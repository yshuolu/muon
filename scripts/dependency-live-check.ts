import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ClaudeCodeAdapter, CodexAdapter, LocalWorktreeProvider } from '../src/runtime/index.js';
import { createHttpApp } from '../src/server/http-app.js';
import { LocalArtifactStore } from '../src/server/local-artifacts.js';
import { SqliteRepository } from '../src/server/sqlite-repository.js';
import { TaskService } from '../src/server/task-service.js';
import type { AppSnapshot, Task } from '../src/shared/domain.js';

const exec = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), 'muon-dependency-live-')));
const repositoryPath = join(directory, 'repository');
await mkdir(repositoryPath);
console.log(`Live dependency integration directory: ${directory}`);
const originalSource = 'export function add(a, b) { return 0; }\n';
await writeFile(join(repositoryPath, 'math.mjs'), originalSource);
await writeFile(join(repositoryPath, 'math.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './math.mjs';\ntest('zero', () => assert.equal(add(0, 0), 0));\n");
await writeFile(join(repositoryPath, '.gitignore'), 'node_modules/\n.muon-cache/\n');
await writeFile(join(repositoryPath, 'package.json'), JSON.stringify({ name: 'muon-dependency-fixture', private: true, type: 'module', scripts: { test: 'node --test math.test.mjs', typecheck: 'tsc --allowJs --checkJs --noEmit --target es2022 --module nodenext --moduleResolution nodenext math.mjs offset.mjs' }, devDependencies: { typescript: '5.9.2' } }, null, 2));
await exec('npm', ['install', '--package-lock-only', '--ignore-scripts', '--cache', join(directory, 'fixture-cache'), '--no-audit', '--no-fund'], { cwd: repositoryPath, timeout: 120_000 });
await exec('git', ['init', repositoryPath]);
await exec('git', ['-C', repositoryPath, 'config', 'core.hooksPath', join(directory, 'empty-hooks')]);
await exec('git', ['-C', repositoryPath, 'add', '.']);
await exec('git', ['-C', repositoryPath, '-c', 'user.name=Muon Live Validation', '-c', 'user.email=muon-live@example.invalid', 'commit', '-m', 'Initial dependency integration fixture']);

const scope = { workspaceId: 'dependency-live', projectId: 'arithmetic', userId: 'owner' };
const repository = new SqliteRepository(join(directory, 'muon.sqlite'));
const artifacts = new LocalArtifactStore(join(directory, 'artifacts'));
const workspaces = new LocalWorktreeProvider(join(directory, 'worktrees'));
await repository.initialize(scope, { id: scope.projectId, workspaceId: scope.workspaceId, ownerUserId: scope.userId, name: 'Dependency integration fixture', identifier: 'DEP', repositoryPath }, { maxConcurrentAgents: 1, dispatcherEnabled: false, defaultProvider: 'claude' });
const service = new TaskService({ scope, repository, artifacts, workspaces, adapters: { claude: new ClaudeCodeAdapter(), codex: new CodexAdapter() } });
await service.initialize();
const app = createHttpApp(service, artifacts);
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await app.request(`http://localhost:4310${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `HTTP ${response.status}: ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}
async function until(taskId: string, status: Task['status']): Promise<Task> {
  const started = Date.now();
  for (;;) {
    const state = await request<AppSnapshot>('/api/state');
    assert.ok(state.runtime.activeRuns <= 1);
    const task = state.tasks.find(task => task.id === taskId)!;
    if (task.status === status) return task;
    if (task.status === 'blocked') throw new Error(`Integration blocked: ${task.error}`);
    if (Date.now() - started > 8 * 60_000) throw new Error(`Timed out waiting for ${status}; current state ${task.status}/${task.phase}.`);
    await delay(250);
  }
}

try {
  const group = await request<Task>('/api/tasks', 'POST', { title: 'Completed prerequisite group', kind: 'group', status: 'backlog' });
  const nested = await request<Task>('/api/tasks', 'POST', { title: 'Nested prerequisite group', kind: 'group', status: 'backlog', parentId: group.id });
  const dependency = await request<Task>('/api/tasks', 'POST', { title: 'Completed arithmetic prerequisite fixture', status: 'backlog', parentId: nested.id });
  const source = await workspaces.ensure({ repositoryPath, taskId: dependency.id });
  const dependencySource = 'export function add(a, b) { return a + b; }\n';
  const dependencyOffset = 'export const OFFSET = 73129;\n';
  await writeFile(join(source.path, 'math.mjs'), dependencySource);
  await writeFile(join(source.path, 'offset.mjs'), dependencyOffset);
  await exec(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict'; import {add} from './math.mjs'; import {OFFSET} from './offset.mjs'; assert.equal(add(2,3),5); assert.equal(OFFSET,73129);"], { cwd: source.path });
  await repository.saveTask(scope, { ...dependency, status: 'done', phase: 'complete', worktree: source, summary: 'Fixture prerequisite has an actual uncommitted add implementation and an untracked offset module, independently checked on the host.', changedFiles: await workspaces.changedFiles(source), evidence: [{ id: 'prerequisite-host-check', kind: 'test', title: 'Actual fixture prerequisite check', description: 'Host imported both actual modules and asserted add(2,3) and OFFSET.', result: 'passed', steps: ['node --input-type=module: import add and OFFSET, assert add(2,3)===5 and OFFSET===73129'], createdAt: new Date().toISOString() }] }, dependency.version);
  const integration = await request<Task>('/api/tasks', 'POST', { title: 'Integrate prerequisite and verify typed arithmetic', description: 'Integrate the completed prerequisite changes from the supplied snapshots. In math.mjs preserve add and add an exported addWithOffset(a,b) that imports OFFSET from offset.mjs and returns add(a,b)+OFFSET. Extend math.test.mjs with positive, negative, and decimal coverage for add and addWithOffset. Use the provided OFFSET value, do not invent or change it. This fresh worktree has a committed package.json and lockfile but no node_modules. After RFC approval install the locked dependencies with npm ci --cache .muon-cache/npm --no-audit --no-fund, then run npm test and npm run typecheck. Record both commands as test evidence. No unrelated changes, no commits or merges.', status: 'todo', provider: 'claude', blockedByIds: [group.id] });
  await request('/api/settings', 'PATCH', { dispatcherEnabled: true });
  console.log('Real Claude integration planning is running with exported nested dependency inputs.');
  const review = await until(integration.id, 'in_review');
  assert.equal(review.plans[0].dependencyInputs?.length, 1);
  assert.ok(review.plans[0].dependencyInputs![0].changes.patch.includes('73129'));
  assert.deepEqual(await workspaces.changedFiles(review.worktree!), []);
  await assert.rejects(stat(join(review.worktree!.path, 'node_modules')));
  await writeFile(join(source.path, 'offset.mjs'), 'export const OFFSET = 99999;\n');
  await request(`/api/tasks/${integration.id}/approve`, 'POST', { planId: review.plans[0].id });
  console.log('Approved exact RFC; source later changed to prove the integration uses the frozen snapshot.');
  const complete = await until(integration.id, 'done');
  const cwd = complete.worktree!.path;
  const assertions = (await exec(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict'; import {add,addWithOffset} from './math.mjs'; import {OFFSET} from './offset.mjs'; assert.equal(OFFSET,73129); assert.equal(add(2,3),5); assert.equal(add(-2,-3),-5); assert.equal(addWithOffset(1.25,2.5),73132.75); console.log('Original frozen OFFSET and independent arithmetic checks passed.');"], { cwd })).stdout;
  const tests = (await exec('npm', ['test'], { cwd })).stdout;
  const typecheck = (await exec('npm', ['run', 'typecheck'], { cwd })).stdout;
  assert.ok((await stat(join(cwd, 'node_modules', 'typescript', 'bin', 'tsc'))).isFile());
  assert.ok((await stat(join(cwd, '.muon-cache', 'npm'))).isDirectory());
  assert.equal(await readFile(join(repositoryPath, 'math.mjs'), 'utf8'), originalSource);
  assert.equal(await readFile(join(source.path, 'math.mjs'), 'utf8'), dependencySource);
  assert.equal(await readFile(join(source.path, 'offset.mjs'), 'utf8'), 'export const OFFSET = 99999;\n');
  assert.deepEqual(complete.plans[0].dependencyInputs, review.plans[0].dependencyInputs);
  assert.deepEqual(complete.runs?.map(run => run.status), ['succeeded', 'succeeded', 'succeeded']);
  assert.ok(complete.evidence.some(item => item.kind === 'test' && item.steps?.some(step => step.includes('typecheck')) && item.result === 'passed'));
  const result = { passed: true, validatedAt: new Date().toISOString(), directory, prerequisiteIsHostVerifiedFixture: true, task: complete, assertions, tests, typecheck };
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, task: { id: complete.id, status: complete.status, phase: complete.phase, changedFiles: complete.changedFiles, evidence: complete.evidence, runs: complete.runs } }, null, 2));
} catch (error) {
  const result = { passed: false, validatedAt: new Date().toISOString(), directory, error: error instanceof Error ? error.message : String(error), state: await service.snapshot() };
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} finally {
  await service.stop();
  repository.close();
}
