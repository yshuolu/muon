import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ClaudeCodeAdapter, CodexAdapter, LocalWorktreeProvider } from '../src/runtime/index.js';
import { createHttpApp } from '../src/server/http-app.js';
import { singleProjectResolver } from '../src/server/project-registry.js';
import { LocalArtifactStore } from '../src/server/local-artifacts.js';
import { SqliteRepository } from '../src/server/sqlite-repository.js';
import { TaskService } from '../src/server/task-service.js';
import type { AppSnapshot, Task } from '../src/shared/types.js';

assert.ok(process.argv[2], 'Pass the temporary directory printed by dependency-live-check.ts.');
const directory = await realpath(process.argv[2]);
assert.equal(dirname(directory), await realpath(tmpdir()));
assert.ok(basename(directory).startsWith('muon-dependency-live-'));
const exec = promisify(execFile);
const scope = { workspaceId: 'dependency-live', projectId: 'arithmetic', userId: 'owner' };
const repository = new SqliteRepository(join(directory, 'muon.sqlite'));
const artifacts = new LocalArtifactStore(join(directory, 'artifacts'));
const workspaces = new LocalWorktreeProvider(join(directory, 'worktrees'));
const project = await repository.project(scope);
assert.equal(project.repositoryPath, join(directory, 'repository'));
const service = new TaskService({ scope, repository, artifacts, workspaces, adapters: { claude: new ClaudeCodeAdapter(), codex: new CodexAdapter() } });
await service.initialize();
const app = createHttpApp(singleProjectResolver(service), artifacts);
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await app.request(`http://localhost:4310${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `HTTP ${response.status}: ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}

try {
  const state = await request<AppSnapshot>('/api/state');
  const previous = state.tasks.find(task => task.identifier === 'DEP-4')!;
  assert.equal(previous.status, 'blocked');
  assert.equal(previous.phase, 'verification');
  const originalInputs = previous.plans.find(plan => plan.status === 'approved')!.dependencyInputs;
  const prerequisite = state.tasks.find(task => task.id === originalInputs![0].taskId)!;
  const sourceOffset = await readFile(join(prerequisite.worktree!.path, 'offset.mjs'), 'utf8');
  await request('/api/settings', 'PATCH', { dispatcherEnabled: true });
  await request(`/api/tasks/${previous.id}/retry`, 'POST', { mode: 'retry', feedback: 'Re-run the required approved RFC checks: npm test and npm run typecheck, inspecting the actual files and frozen snapshot. The additional inline node-e probe was optional and its permission denial is retained in prior evidence. Do not retry the denied inline command, do not claim it ran, and do not change permissions. Disclose that optional probe limitation in a note. Required approved checks must be reported as test evidence with their actual pass/fail result; any required failed or skipped check must still block completion. No code changes are requested.' });
  console.log(`Retrying verification in the same task, RFC, and worktree with a fresh provider session: ${directory}`);
  const started = Date.now();
  let complete: Task;
  for (;;) {
    const current = await request<AppSnapshot>('/api/state');
    const task = current.tasks.find(task => task.id === previous.id)!;
    assert.ok(current.runtime.activeRuns <= 1);
    if (task.status === 'done') { complete = task; break; }
    if (task.status === 'blocked') throw new Error(task.error);
    if (Date.now() - started > 6 * 60_000) throw new Error('Retry verification timed out.');
    await delay(250);
  }
  assert.deepEqual(complete.worktree, previous.worktree);
  assert.deepEqual(complete.plans.find(plan => plan.status === 'approved')!.dependencyInputs, originalInputs);
  assert.deepEqual(complete.evidence.slice(0, previous.evidence.length), previous.evidence);
  assert.deepEqual(complete.runs?.slice(0, previous.runs!.length), previous.runs);
  assert.equal(complete.runs?.at(-1)?.phase, 'verification');
  assert.equal(complete.runs?.at(-1)?.status, 'succeeded');
  assert.ok(complete.sessionId);
  assert.notEqual(complete.sessionId, previous.sessionId);
  const cwd = complete.worktree!.path;
  const assertions = (await exec(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict'; import {add,addWithOffset} from './math.mjs'; import {OFFSET} from './offset.mjs'; assert.equal(OFFSET,73129); assert.equal(add(2,3),5); assert.equal(add(-2,-3),-5); assert.equal(addWithOffset(1.25,2.5),73132.75); console.log('Frozen OFFSET and four independent assertions passed.');"], { cwd })).stdout;
  const tests = (await exec('npm', ['test'], { cwd })).stdout;
  const typecheck = (await exec('npm', ['run', 'typecheck'], { cwd })).stdout;
  assert.ok((await stat(join(cwd, 'node_modules/typescript/bin/tsc'))).isFile());
  assert.ok((await stat(join(cwd, '.muon-cache/npm'))).isDirectory());
  assert.equal(await readFile(join(project.repositoryPath, 'math.mjs'), 'utf8'), 'export function add(a, b) { return 0; }\n');
  assert.equal(await readFile(join(prerequisite.worktree!.path, 'math.mjs'), 'utf8'), 'export function add(a, b) { return a + b; }\n');
  assert.equal(await readFile(join(prerequisite.worktree!.path, 'offset.mjs'), 'utf8'), sourceOffset);
  const result = { passed: true, validatedAt: new Date().toISOString(), directory, task: complete, assertions, tests, typecheck };
  await writeFile(join(directory, 'result-retry.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, task: { id: complete.id, status: complete.status, phase: complete.phase, changedFiles: complete.changedFiles, evidence: complete.evidence, runs: complete.runs } }, null, 2));
} catch (error) {
  const result = { passed: false, validatedAt: new Date().toISOString(), directory, error: error instanceof Error ? error.message : String(error), state: await service.snapshot() };
  await writeFile(join(directory, 'result-retry.json'), JSON.stringify(result, null, 2));
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} finally {
  await service.stop();
  repository.close();
}
