import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { ClaudeCodeAdapter, LocalWorktreeProvider, type AgentAdapter, type AgentRequest } from '../src/runtime';
import { TaskService } from '../src/server/task-service';
import { SqliteRepository } from '../src/server/sqlite-repository';
import { LocalArtifactStore } from '../src/server/local-artifacts';
import { createHttpApp } from '../src/server/http-app';
import { singleProjectResolver } from '../src/server/project-registry';
import type { Task } from '../src/shared/types';

// Opt-in authenticated Claude check: real CLI -> REST -> SQLite -> planning agent.
// No approval is issued, and no implementation is allowed in this fixture.
const exec = promisify(execFile);
await mkdir(resolve('.muon/validation'), { recursive: true });
const directory = await mkdtemp(resolve('.muon/validation/plan-discussion-live-'));
const repoPath = join(directory, 'repository');
await mkdir(repoPath);
await writeFile(join(repoPath, 'counter.js'), 'export function createCounter() { let value = 0; return { get value() { return value; }, increment() { return ++value; } }; }\n');
await writeFile(join(repoPath, 'package.json'), JSON.stringify({ name: 'plan-discussion-fixture', private: true, type: 'module', scripts: { test: 'node --test' } }));
await exec('git', ['init', repoPath]);
await exec('git', ['-C', repoPath, 'config', 'core.hooksPath', join(directory, 'empty-hooks')]);
await exec('git', ['-C', repoPath, 'add', '.']);
await exec('git', ['-C', repoPath, '-c', 'user.name=Muon Live Validation', '-c', 'user.email=muon-live@example.invalid', 'commit', '-m', 'Initialize plan discussion fixture']);

const scope = { workspaceId: 'discussion-validation', projectId: 'counter', userId: 'test-owner' };
const databasePath = join(directory, 'muon.sqlite');
const repository = new SqliteRepository(databasePath);
await repository.initialize(scope, { id: scope.projectId, workspaceId: scope.workspaceId, ownerUserId: scope.userId, name: 'Plan discussion validation', identifier: 'RFC', repositoryPath: repoPath }, { defaultProvider: 'claude', dispatcherEnabled: true, maxConcurrentAgents: 1 });
const real = new ClaudeCodeAdapter();
const calls: { phase: string; sessionId?: string; resultSessionId?: string; elapsedMs?: number }[] = [];
const adapter: AgentAdapter = {
  provider: 'claude', available: () => real.available(),
  async run(request: AgentRequest) {
    assert.equal(request.phase, 'planning', 'Discussion must never launch implementation.');
    const call = { phase: request.phase, sessionId: request.sessionId } as typeof calls[number];
    calls.push(call);
    console.log(`Starting real planning turn ${calls.length}.`);
    const started = Date.now();
    const result = await real.run(request);
    call.elapsedMs = Date.now() - started; call.resultSessionId = result.sessionId;
    console.log(`Finished planning turn ${calls.length} in ${call.elapsedMs}ms.`);
    return result;
  },
};
const workspaces = new LocalWorktreeProvider(join(directory, 'worktrees'));
const artifacts = new LocalArtifactStore(join(directory, 'artifacts'));
const unavailable: AgentAdapter = { provider: 'codex', available: async () => false, run: async () => { throw new Error('Unexpected Codex execution'); } };
const service = new TaskService({ scope, repository, artifacts, workspaces, adapters: { claude: adapter, codex: unavailable } });
await service.initialize();
assert.equal((await service.snapshot()).runtime.providers.claude, true);
const port = Number(process.env.MUON_DISCUSSION_TEST_PORT ?? 4334);
const url = `http://127.0.0.1:${port}`;
const app = createHttpApp(singleProjectResolver(service), artifacts, { port });
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
service.start();
console.log(`Live validation directory: ${directory}`);
async function cli(...args: string[]) {
  const { stdout } = await exec(process.execPath, [resolve('bin/muon.mjs'), ...args], { env: { ...process.env, MUON_API_URL: url }, timeout: 30_000 });
  return JSON.parse(stdout);
}
async function review(id: string, version: number): Promise<Task> {
  const started = Date.now();
  while (Date.now() - started < 240_000) {
    const task = await service.getTask(id);
    if (task.status === 'blocked') throw new Error(task.error);
    if (task.phase === 'plan_review' && task.plans.length === version) return task;
    await new Promise(resolveWait => setTimeout(resolveWait, 1000));
  }
  throw new Error(`Timed out awaiting RFC v${version}.`);
}

let task: Task | undefined;
let succeeded = false;
let error: string | undefined;
try {
  task = await cli('tasks', 'create', '--json', JSON.stringify({ title: 'Add reset() to createCounter()', status: 'todo', description: 'Plan a small dependency-free change: add reset() to counter.js to set value to zero. Keep increment behavior and independent counter instances. Add tests using Node built-in test runner. Keep the RFC concise, under 500 words. This fixture exercises owner plan discussion. Do not build before explicit owner approval.' }));
  task = await review(task!.id, 1);
  const firstPlanId = task.plans[0].id;
  await cli('tasks', 'comment', task.identifier, '--plan-id', firstPlanId, '--content', 'Should reset return zero or undefined? Choose zero to match increment returning the new value. Explain the choice and add a repeated-reset test to the RFC.');
  task = await review(task.id, 2);
  assert.equal(task.planDiscussion?.length, 2);
  assert.match(task.planDiscussion![1].content, /zero|0/i);
  assert.match(task.plans[1].content, /repeat|idempotent/i);
  const stale = await fetch(`${url}/api/tasks/${task.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ planId: firstPlanId }) });
  assert.equal(stale.status, 409);
  await cli('tasks', 'comment', task.identifier, '--plan-id', task.plans[1].id, '--content', 'Keep the zero return and repeated-reset coverage we just agreed. Also describe exactly how the test proves that resetting one instance leaves another unchanged.');
  task = await review(task.id, 3);
  assert.equal(task.planDiscussion?.length, 4);
  assert.deepEqual(task.planDiscussion!.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.match(task.plans[2].content, /repeat|idempotent/i);
  assert.match(task.plans[2].content, /independen|isolat|other|second/i);
  assert.equal(task.plans[2].status, 'pending');
  assert.equal(task.plans.some(plan => plan.status === 'approved'), false);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].resultSessionId);
  assert.equal(calls[1].sessionId, calls[0].resultSessionId);
  assert.equal(calls[2].sessionId, calls[1].resultSessionId);
  assert.deepEqual(await workspaces.changedFiles(task.worktree!), []);
  assert.deepEqual(await cli('tasks', 'discussion', task.identifier), task.planDiscussion);
  succeeded = true;
} catch (cause) {
  error = cause instanceof Error ? cause.message : String(cause);
  process.exitCode = 1;
} finally {
  await service.stop();
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  repository.close();
  const reopened = new SqliteRepository(databasePath);
  const persisted = task ? await reopened.task(scope, task.id) : undefined;
  reopened.close();
  if (succeeded) assert.deepEqual(persisted?.planDiscussion, task?.planDiscussion);
  const result = { succeeded, validatedAt: new Date().toISOString(), directory, calls, task: persisted, error };
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ succeeded, directory, calls, error }, null, 2));
}
