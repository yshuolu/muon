import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { strict as assert } from 'node:assert';
import { CodexAdapter, ClaudeCodeAdapter, LocalWorktreeProvider } from '../src/runtime/index.js';
import { SqliteRepository } from '../src/server/sqlite-repository.js';
import { LocalArtifactStore } from '../src/server/local-artifacts.js';
import { TaskService } from '../src/server/task-service.js';
import { createHttpApp } from '../src/server/http-app.js';
import { singleProjectResolver } from '../src/server/project-registry.js';

const exec = promisify(execFile);
const root = resolve('.muon/acceptance', `codex-${Date.now()}`);
const repositoryPath = join(root, 'repository');
await mkdir(repositoryPath, { recursive: true });
await writeFile(join(repositoryPath, 'package.json'), JSON.stringify({ name: 'muon-live-codex-fixture', type: 'module', scripts: { test: 'node --test' } }, null, 2));
await writeFile(join(repositoryPath, 'slug.js'), 'export function slugify(value) {\n  return value;\n}\n');
await writeFile(join(repositoryPath, 'slug.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from './slug.js';\ntest('existing identity behavior', () => assert.equal(slugify('hello'), 'hello'));\n");
await exec('git', ['init', '-b', 'main'], { cwd: repositoryPath });
await exec('git', ['add', '.'], { cwd: repositoryPath });
await exec('git', ['-c', 'user.name=Muon Acceptance', '-c', 'user.email=acceptance@localhost', 'commit', '-m', 'Initialize isolated acceptance fixture'], { cwd: repositoryPath });

const scope = { workspaceId: 'acceptance', projectId: 'codex-fixture', userId: 'acceptance-owner' };
const repo = new SqliteRepository(join(root, 'state.sqlite'));
const artifacts = new LocalArtifactStore(join(root, 'artifacts'));
await repo.initialize(scope, { id: scope.projectId, workspaceId: scope.workspaceId, ownerUserId: scope.userId, name: 'Codex live acceptance', identifier: 'LIVE', repositoryPath }, { maxConcurrentAgents: 1, dispatcherEnabled: true, defaultProvider: 'codex' });
const service = new TaskService({ scope, repository: repo, artifacts, workspaces: new LocalWorktreeProvider(join(root, 'worktrees')), adapters: { codex: new CodexAdapter(), claude: new ClaudeCodeAdapter() } });
const app = createHttpApp(singleProjectResolver(service), artifacts);
let taskId = '';
const start = Date.now();
async function request(path: string, body: unknown) {
  return app.request(`http://127.0.0.1:4310/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Host: '127.0.0.1:4310' }, body: JSON.stringify(body) });
}
async function waitFor(status: string) {
  let last = '';
  while (Date.now() - start < 12 * 60_000) {
    const task = await service.getTask(taskId);
    const current = `${task.status}/${task.phase}`;
    if (current !== last) { console.log(`${new Date().toISOString()} ${current}`); last = current; }
    await writeFile(join(root, 'latest-task.json'), JSON.stringify(task, null, 2));
    if (task.status === 'blocked') throw new Error(`Live agent blocked: ${task.error}`);
    if (task.status === status) return task;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Live acceptance exceeded 12 minutes.');
}
try {
  console.log(`Live acceptance evidence: ${root}`);
  await service.initialize(); service.start();
  const creation = await request('/tasks', { title: 'Implement predictable URL slug generation', provider: 'codex', description: 'Implement slugify(value) in slug.js. For strings: trim, normalize accented Latin letters using NFKD, lowercase, replace each run of non-alphanumeric characters with one hyphen, remove leading/trailing hyphens. Non-string input must throw TypeError. Extend slug.test.js with cases for Hello World, café déjà vu, empty input, repeated punctuation, and invalid input. Use only built-in Node modules. Change only slug.js and slug.test.js. Do not commit, merge, or modify package.json. Verify with node --test. This is a real isolated Muon acceptance test.' });
  assert.equal(creation.status, 201);
  taskId = (await creation.json()).id;
  const planned = await waitFor('in_review');
  assert.equal(planned.plans.at(-1)?.status, 'pending');
  const plan = planned.plans.at(-1)!;
  assert.match(plan.content, /slug/i);
  const before = await exec('git', ['status', '--porcelain'], { cwd: planned.worktree!.path });
  assert.equal(before.stdout.trim(), '', 'Planning must not modify the worktree');
  assert.equal((await request(`/tasks/${taskId}/approve`, { planId: 'stale-rfc' })).status, 409);
  assert.equal((await service.getTask(taskId)).status, 'in_review');
  console.log(`Reviewed RFC v${plan.version} for the isolated acceptance fixture; approving exact revision.`);
  assert.equal((await request(`/tasks/${taskId}/approve`, { planId: plan.id })).status, 200);
  const done = await waitFor('done');
  const actual = await exec(process.execPath, ['--test'], { cwd: done.worktree!.path });
  const module = await import(`${join(done.worktree!.path, 'slug.js')}?v=${Date.now()}`);
  assert.equal(module.slugify(' Hello World! '), 'hello-world');
  assert.equal(module.slugify('café déjà vu'), 'cafe-deja-vu');
  assert.equal(module.slugify(''), '');
  assert.equal(module.slugify('--a___b---'), 'a-b');
  assert.throws(() => module.slugify(12), TypeError);
  assert.deepEqual(done.changedFiles.map(file => file.path).sort(), ['slug.js', 'slug.test.js']);
  assert.ok(done.evidence.some(item => item.kind === 'test' && item.result === 'passed'));
  assert.equal(await readFile(join(repositoryPath, 'slug.js'), 'utf8'), 'export function slugify(value) {\n  return value;\n}\n');
  const check = { passed: true, provider: 'codex', timestamp: new Date().toISOString(), root, taskId, worktree: done.worktree, planId: plan.id, phases: done.runs, evidence: done.evidence, changedFiles: done.changedFiles, independentTestOutput: actual.stdout, durationSeconds: Math.round((Date.now() - start) / 1000) };
  await writeFile(join(root, 'acceptance-result.json'), JSON.stringify(check, null, 2));
  await mkdir('docs', { recursive: true });
  await writeFile('docs/codex-live-validation.md', `# Codex live acceptance\n\nPassed: ${check.timestamp}\n\nA real authenticated Codex app-server session completed the complete Muon HTTP/task-service workflow in an isolated Git repository.\n\n- Todo automatically dispatched to planning.\n- Planning produced a real RFC and made no worktree changes.\n- A stale RFC approval was rejected.\n- The test owner approved the exact RFC revision.\n- Building and verification used the same worktree and provider session.\n- Five independent host assertions and the task's actual Node test suite passed.\n- Both changed files and verification evidence were persisted.\n- The original checkout was unchanged.\n\nLocal evidence: \`${root}/acceptance-result.json\`\n\nThis test invokes the installed CLI using existing authentication. It is opt-in; run \`node --import tsx scripts/codex-live-check.ts\`.\n`);
  console.log(JSON.stringify({ passed: true, durationSeconds: check.durationSeconds, root, changedFiles: check.changedFiles, tests: actual.stdout }, null, 2));
} catch (error) {
  await writeFile(join(root, 'failure.json'), JSON.stringify({ passed: false, error: error instanceof Error ? error.message : String(error), timestamp: new Date().toISOString() }, null, 2));
  throw error;
} finally { await service.stop(); repo.close(); }
