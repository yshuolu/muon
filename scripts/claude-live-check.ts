import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ClaudeCodeAdapter } from '../src/runtime/claude-code-adapter.js';
import { LocalWorktreeProvider } from '../src/runtime/local-worktree-provider.js';
import type { AgentPhase, AgentResult } from '../src/runtime/contracts.js';

const exec = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), 'muon-claude-live-')));
const repository = join(directory, 'repository');
const evidence = join(directory, 'evidence');
await mkdir(repository);
await mkdir(evidence);
console.log(`Live validation directory: ${directory}`);

const originalSource = 'export function add(a, b) { return 0; }\n';
await writeFile(join(repository, 'math.mjs'), originalSource);
await writeFile(join(repository, 'math.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './math.mjs';
test('zero', () => assert.equal(add(0, 0), 0));
`);
await exec('git', ['init', repository]);
await exec('git', ['-C', repository, 'config', 'core.hooksPath', join(directory, 'empty-hooks')]);
await exec('git', ['-C', repository, 'add', 'math.mjs', 'math.test.mjs']);
await exec('git', ['-C', repository, '-c', 'user.name=Muon Live Validation', '-c', 'user.email=muon-live@example.invalid', 'commit', '-m', 'Initial validation fixture']);

const workspaces = new LocalWorktreeProvider(join(directory, 'worktrees'));
const workspace = await workspaces.ensure({ repositoryPath: repository, taskId: 'claude-live' });
const adapter = new ClaudeCodeAdapter();
assert.equal(await adapter.available(), true, 'Claude CLI must be installed.');
const { stdout: version } = await exec('claude', ['--version']);
const phases: { phase: AgentPhase; elapsedMs: number; sessionId?: string }[] = [];
let sessionId: string | undefined;

async function run(phase: AgentPhase, prompt: string): Promise<AgentResult> {
  const started = Date.now();
  console.log(`Starting real Claude ${phase}.`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6 * 60_000);
  try {
    const result = await adapter.run({ provider: 'claude', phase, cwd: workspace.path, prompt, sessionId, signal: controller.signal });
    assert.ok(result.sessionId, 'The live Claude result must include a resumable session.');
    if (sessionId) assert.equal(result.sessionId, sessionId, 'All phases must reuse the same Claude session.');
    sessionId = result.sessionId;
    phases.push({ phase, elapsedMs: Date.now() - started, sessionId });
    await writeFile(join(evidence, `${phase}.md`), result.text);
    console.log(`Completed ${phase} in ${Date.now() - started}ms.`);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

try {
  const plan = await run('planning', 'Inspect math.mjs and math.test.mjs. Produce a concise Markdown RFC to make add(a, b) return the numerical sum. Include regression tests covering positive numbers, negative numbers and decimals. Scope is exactly these two files. This is the planning phase: do not edit or execute commands. Return the RFC as your final result.');
  assert.match(plan.text, /math|add/i);
  assert.deepEqual(await workspaces.changedFiles(workspace), [], 'Planning must leave the task worktree unchanged.');
  await run('building', `The owner approves the RFC below. Implement it now in math.mjs and math.test.mjs. Do not modify other files. Run the tests using node --test math.test.mjs and return a brief implementation result. The test fixture has no dependencies and requires no network.\n\n${plan.text}`);
  assert.notEqual(await readFile(join(workspace.path, 'math.mjs'), 'utf8'), originalSource, 'The coding agent must modify the implementation.');
  const { stdout: hostChecks } = await exec(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict'; import { add } from './math.mjs'; assert.equal(add(2,3),5); assert.equal(add(-2,-3),-5); assert.equal(add(1.25,2.5),3.75); console.log('Independent positive, negative, decimal checks passed.');"], { cwd: workspace.path });
  await writeFile(join(evidence, 'independent-assertions.txt'), hostChecks);
  await run('verification', 'Verify the approved implementation. You must execute node --test math.test.mjs and report the actual command, exit outcome, and test count in your final result. Check positive numbers, negative numbers, and decimals are tested. No network is needed. Do not edit files unless required to fix a real failure.');
  const { stdout: testOutput } = await exec(process.execPath, ['--test', 'math.test.mjs'], { cwd: workspace.path });
  await writeFile(join(evidence, 'host-test-output.txt'), testOutput);
  const changedFiles = await workspaces.changedFiles(workspace);
  assert.deepEqual(changedFiles.map(file => file.path), ['math.mjs', 'math.test.mjs']);
  assert.equal(await readFile(join(repository, 'math.mjs'), 'utf8'), originalSource, 'Agent changes must remain in its isolated task worktree.');
  assert.deepEqual(await workspaces.ensure({ repositoryPath: repository, taskId: 'claude-live' }), workspace, 'Task workspace must be reusable.');
  const result = { passed: true, validatedAt: new Date().toISOString(), cliVersion: version.trim(), directory, workspace, phases, changedFiles, testOutput, hostChecks };
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const result = { passed: false, validatedAt: new Date().toISOString(), cliVersion: version.trim(), directory, workspace, phases, error: error instanceof Error ? error.message : String(error) };
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
