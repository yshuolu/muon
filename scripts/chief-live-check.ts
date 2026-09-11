import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { once } from 'node:events';
import { LocalChiefCommands } from '../src/server/local-chief-commands.js';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
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
const directory = await realpath(await mkdtemp(join(tmpdir(), 'muon-chief-live-')));
const repositoryPath = join(directory, 'repository');
await mkdir(repositoryPath);
const originalReadme = '# Arithmetic fixture\nA small JavaScript arithmetic module is planned for this repository.\n';
await writeFile(join(repositoryPath, 'README.md'), originalReadme);
await exec('git', ['init', repositoryPath]);
await exec('git', ['-C', repositoryPath, 'config', 'core.hooksPath', join(directory, 'empty-hooks')]);
await exec('git', ['-C', repositoryPath, 'add', 'README.md']);
await exec('git', ['-C', repositoryPath, '-c', 'user.name=Muon Live Validation', '-c', 'user.email=muon-live@example.invalid', 'commit', '-m', 'Initial chief validation fixture']);

const scope = { workspaceId: 'chief-live', projectId: 'arithmetic', userId: 'owner' };
const repository = new SqliteRepository(join(directory, 'muon.sqlite'));
const artifacts = new LocalArtifactStore(join(directory, 'artifacts'));
await repository.initialize(scope, { id: scope.projectId, workspaceId: scope.workspaceId, ownerUserId: scope.userId, name: 'Arithmetic fixture', identifier: 'CHK', repositoryPath }, { maxConcurrentAgents: 1, dispatcherEnabled: false, defaultProvider: 'claude' });
const port = Number(process.env.MUON_CHIEF_TEST_PORT ?? 4333);
const chiefCommands = new LocalChiefCommands({ apiUrl: `http://127.0.0.1:${port}`, scope });
const service = new TaskService({ scope, repository, artifacts, chiefCommands, workspaces: new LocalWorktreeProvider(join(directory, 'worktrees')), adapters: { claude: new ClaudeCodeAdapter(), codex: new CodexAdapter() } });
await service.initialize();
const app = createHttpApp(service, artifacts, { port, access: chiefCommands });
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
await once(server, 'listening');
console.log(`Live chief validation directory: ${directory}`);

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `HTTP ${response.status}: ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}

const turns: { elapsedMs: number; message: string; taskIds?: string[] }[] = [];
let peakActiveRuns = 0;
async function chief(content: string): Promise<AppSnapshot> {
  const before = await request<AppSnapshot>('/api/state');
  const started = Date.now();
  await request('/api/chief/messages', 'POST', { content });
  for (;;) {
    const state = await request<AppSnapshot>('/api/state');
    peakActiveRuns = Math.max(peakActiveRuns, state.runtime.activeRuns);
    assert.ok(state.runtime.activeRuns <= 1, 'Chief must respect the shared concurrency limit.');
    if (!state.runtime.chiefRunning && state.messages.length > before.messages.length + 1) {
      const message = state.messages.at(-1)!;
      assert.equal(message.role, 'assistant');
      assert.doesNotMatch(message.content, /couldn't complete|could not be applied/i);
      turns.push({ elapsedMs: Date.now() - started, message: message.content, taskIds: message.taskIds });
      return state;
    }
    if (Date.now() - started > 6 * 60_000) throw new Error('Real chief exceeded the six-minute live-check deadline.');
    await delay(250);
  }
}

try {
  const existing = await request<Task>('/api/tasks', 'POST', { title: 'Existing backlog task', description: 'A task that the chief must update.', status: 'backlog', priority: 4 });
  console.log('Asking real Claude chief to decompose work and edit an existing task.');
  const first = await chief(`Organize this work now; do not implement files or enable the dispatcher. Create one organizational group titled "Arithmetic feature" and exactly two coding subtasks under it: "Implement addition" and "Test addition". Set both subtasks to Todo with provider Claude and label "arithmetic". Implement addition should describe adding a numerical add(a,b) export. Test addition should depend on Implement addition and describe positive, negative, and decimal regression coverage in its own task worktree, including integration of the dependency change if required. Also update existing task ${existing.identifier} (${existing.id}): rename it to "Review arithmetic requirements", change priority to high, and set its labels to ["review"], keeping it in Backlog. Perform the task changes through your Muon CLI, then summarize the saved results.`);
  assert.equal(first.tasks.length, 4);
  const group = first.tasks.find(task => task.title === 'Arithmetic feature')!;
  const implementation = first.tasks.find(task => task.title === 'Implement addition')!;
  const tests = first.tasks.find(task => task.title === 'Test addition')!;
  assert.equal(group?.kind, 'group');
  assert.equal(group.worktree, undefined);
  for (const task of [implementation, tests]) {
    assert.ok(task);
    assert.equal(task.kind, 'coding');
    assert.equal(task.parentId, group.id);
    assert.equal(task.status, 'todo');
    assert.equal(task.provider, 'claude');
    assert.ok(task.labels.includes('arithmetic'));
    assert.equal(task.plans.length, 0);
    assert.equal(task.runs?.length ?? 0, 0);
  }
  assert.deepEqual(tests.blockedByIds, [implementation.id]);
  const edited = first.tasks.find(task => task.id === existing.id)!;
  assert.equal(edited.title, 'Review arithmetic requirements');
  assert.equal(edited.priority, 2);
  assert.equal(edited.status, 'backlog');
  assert.deepEqual(edited.labels, ['review']);
  console.log('Group, coding subtasks, dependency, and existing-task update persisted correctly.');

  const second = await chief(`Update our existing tasks only. Cancel "Test addition" (${tests.id}). Move "Implement addition" (${implementation.id}) to Backlog and change its priority to urgent. Keep all other fields and tasks unchanged. Do not implement code or approve any RFC.`);
  assert.equal(second.tasks.length, 4);
  assert.equal(second.tasks.find(task => task.id === tests.id)?.status, 'canceled');
  const updatedImplementation = second.tasks.find(task => task.id === implementation.id)!;
  assert.equal(updatedImplementation.priority, 1);
  assert.equal(updatedImplementation.status, 'backlog');
  assert.equal(updatedImplementation.parentId, group.id);
  assert.ok(updatedImplementation.labels.includes('arithmetic'));
  assert.equal(second.tasks.find(task => task.id === group.id)?.status === 'done', false);
  assert.equal(second.runtime.demo, false);
  assert.equal(second.runtime.activeRuns, 0);
  assert.equal(peakActiveRuns, 1);
  assert.equal(second.settings.dispatcherEnabled, false);
  assert.equal(await readFile(join(repositoryPath, 'README.md'), 'utf8'), originalReadme);
  assert.equal((await exec('git', ['-C', repositoryPath, 'status', '--porcelain'])).stdout, '');
  await service.stop();
  const reopened = new SqliteRepository(join(directory, 'muon.sqlite'));
  try { assert.deepEqual(await reopened.tasks(scope), second.tasks); } finally { reopened.close(); }
  const result = { passed: true, validatedAt: new Date().toISOString(), directory, peakActiveRuns, turns, tasks: second.tasks.map(task => ({ id: task.id, title: task.title, kind: task.kind, status: task.status, priority: task.priority, parentId: task.parentId, blockedByIds: task.blockedByIds, labels: task.labels })) };
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const state = await service.snapshot();
  const result = { passed: false, validatedAt: new Date().toISOString(), directory, turns, error: error instanceof Error ? error.message : String(error), state };
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} finally {
  await service.stop();
  repository.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
