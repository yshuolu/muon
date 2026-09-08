import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentProvider, AgentRequest, AgentResult, WorkspaceProvider } from '../runtime';
import { AgentProcessUnreapedError } from '../runtime';
import type { ArtifactStore } from './ports';
import { createHttpApp } from './http-app';
import { SqliteRepository } from './sqlite-repository';
import { TaskService } from './task-service';

class TestAdapter implements AgentAdapter {
  calls: Array<{ request: AgentRequest; resolve: (result: AgentResult) => void; reject: (error: Error) => void }> = [];
  constructor(readonly provider: AgentProvider) {}
  async available() { return true; }
  run(request: AgentRequest): Promise<AgentResult> {
    return new Promise((resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
      this.calls.push({ request, resolve, reject });
    });
  }
}

const scope = { workspaceId: 'test-workspace', projectId: 'test-project', userId: 'owner' };
let repository: SqliteRepository;
let service: TaskService;
let claude: TestAdapter;
let codex: TestAdapter;
let workspaces: WorkspaceProvider;
let app: ReturnType<typeof createHttpApp>;
let artifacts: ArtifactStore;

beforeEach(async () => {
  repository = new SqliteRepository(':memory:');
  await repository.initialize(scope, {
    id: scope.projectId, workspaceId: scope.workspaceId, ownerUserId: scope.userId,
    name: 'Test project', identifier: 'TST', repositoryPath: '/test/repo',
  }, { maxConcurrentAgents: 1, dispatcherEnabled: false, defaultProvider: 'claude' });
  claude = new TestAdapter('claude'); codex = new TestAdapter('codex');
  workspaces = {
    validateRepository: vi.fn(async path => { if (!path.startsWith('/')) throw new Error('Repository path must be absolute.'); }),
    ensure: vi.fn(async ({ taskId }) => ({ path: `/test/worktrees/${taskId}`, branch: `muon/${taskId}`, baseCommit: 'a'.repeat(40) })),
    changedFiles: vi.fn(async () => []),
  };
  artifacts = { importFile: vi.fn(), read: vi.fn(async () => undefined) };
  service = new TaskService({ scope, repository, artifacts, workspaces, adapters: { claude, codex } });
  await service.initialize();
  app = createHttpApp(service, artifacts, { staticRoot: process.cwd() });
});
afterEach(async () => {
  for (const call of [...claude.calls, ...codex.calls]) call.reject(new Error('Test cleanup'));
  await service.stop();
  repository.close();
  vi.restoreAllMocks();
});

async function request(path: string, method = 'GET', body?: unknown, headers?: Record<string, string>) {
  return app.request(`http://localhost:4310${path}`, {
    method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function eventually(check: () => boolean | Promise<boolean>) {
  for (let count = 0; count < 200; count++) { if (await check()) return; await setImmediate(); }
  throw new Error('Expected state did not arrive');
}
async function enableDispatch() {
  await repository.saveSettings(scope, { ...await repository.settings(scope), dispatcherEnabled: true });
  await service.tick();
}

describe('HTTP validation and local boundary', () => {
  it('validates repository setup through the workspace provider before saving settings', async () => {
    vi.mocked(workspaces.validateRepository!).mockRejectedValue(new Error('No committed Git history.'));
    const result = await request('/api/settings', 'PATCH', { repositoryPath: '/empty/git', projectName: 'Changed name', maxConcurrentAgents: 3 });
    expect(result.status).toBe(400);
    expect((await result.json()).error).toContain('at least one commit');
    expect((await repository.project(scope)).name).toBe('Test project');
    expect((await repository.project(scope)).repositoryPath).toBe('/test/repo');
    expect((await repository.settings(scope)).maxConcurrentAgents).toBe(1);
    vi.mocked(workspaces.validateRepository!).mockResolvedValue();
    expect((await request('/api/settings', 'PATCH', { repositoryPath: '/valid/git' })).status).toBe(200);
    expect((await repository.project(scope)).repositoryPath).toBe('/valid/git');
  });

  it('serves recording byte ranges and rejects unsatisfiable ranges', async () => {
    vi.mocked(artifacts.read).mockResolvedValue({ data: Buffer.from('0123456789'), mime: 'video/webm' });
    const full = await request('/api/artifacts/recording');
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    for (const [range, expected, contentRange] of [
      ['bytes=2-5', '2345', 'bytes 2-5/10'],
      ['bytes=7-', '789', 'bytes 7-9/10'],
      ['bytes=-3', '789', 'bytes 7-9/10'],
    ]) {
      const response = await request('/api/artifacts/recording', 'GET', undefined, { range });
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(contentRange);
      expect(await response.text()).toBe(expected);
    }
    for (const range of ['bytes=10-', 'bytes=7-3', 'bytes=-', 'bytes=-0', 'bytes=0-1,4-5']) {
      const response = await request('/api/artifacts/recording', 'GET', undefined, { range });
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */10');
    }
  });

  it('accepts task groups and validates recovery requests', async () => {
    const creation = await request('/api/tasks', 'POST', { title: 'Release work', kind: 'group', status: 'backlog' });
    expect(creation.status).toBe(201);
    const group = await creation.json();
    expect(group.kind).toBe('group');
    expect((await request(`/api/tasks/${group.id}`, 'PATCH', { kind: 'coding' })).status).toBe(400);
    expect((await request(`/api/tasks/${group.id}/retry`, 'POST', { mode: 'approve' })).status).toBe(400);
    expect((await request(`/api/tasks/${group.id}/retry`, 'POST', { feedback: 'x'.repeat(20_001) })).status).toBe(400);
  });

  it('permits local reads and rejects remote origins and unrecognized hosts', async () => {
    expect((await request('/api/state')).status).toBe(200);
    expect((await request('/api/state', 'GET', undefined, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await app.request('http://evil.example/api/state')).status).toBe(403);
    expect((await request('/api/state', 'GET', undefined, { origin: 'not a URL' })).status).toBe(403);
  });

  it('rejects mutations without JSON and malformed JSON before touching state', async () => {
    expect((await request('/api/tasks', 'POST')).status).toBe(415);
    const response = await app.request('http://localhost:4310/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    expect(response.status).toBe(400);
    expect(await repository.tasks(scope)).toEqual([]);
  });

  it.each([
    { title: 'Try to skip review', status: 'done' },
    { title: 'Try to skip review', phase: 'building' },
    { title: 'Override ownership', ownerUserId: 'someone-else' },
    { title: 'Invalid provider', provider: 'shell' },
    { title: 'Invalid priority', priority: 99 },
    { title: '   ' },
  ])('rejects unsupported task fields and invalid values: %j', async body => {
    expect((await request('/api/tasks', 'POST', body)).status).toBe(400);
    expect(await repository.tasks(scope)).toEqual([]);
  });

  it('validates limits and does not permit approval through a task patch', async () => {
    const created = await request('/api/tasks', 'POST', { title: 'Valid task', status: 'backlog' });
    const task = await created.json();
    expect(created.status).toBe(201);
    expect((await request(`/api/tasks/${task.id}`, 'PATCH', { plans: [{ status: 'approved' }] })).status).toBe(400);
    expect((await request('/api/settings', 'PATCH', { maxConcurrentAgents: 0 })).status).toBe(400);
    expect((await request('/api/settings', 'PATCH', { maxConcurrentAgents: 9 })).status).toBe(400);
    expect((await request('/api/settings', 'PATCH', { maxConcurrentAgents: 2.5 })).status).toBe(400);
    expect((await request('/api/settings', 'PATCH', { repositoryPath: 'relative/path' })).status).toBe(400);
    expect((await request(`/api/tasks/${task.id}/approve`, 'POST', { planId: 'invented' })).status).toBe(409);
    expect((await request('/api/tasks/missing/retry', 'POST', {})).status).toBe(404);
  });

  it('rejects oversized request bodies', async () => {
    expect((await request('/api/chief/messages', 'POST', { content: 'x'.repeat(1024 * 1024) })).status).toBe(413);
    expect(await repository.messages(scope)).toEqual([]);
  });
});

describe('runtime integration regressions', () => {
  it('preserves status when a chief action changes only priority', async () => {
    const task = await service.createTask({ title: 'Priority only', status: 'backlog', priority: 4 });
    expect((await request('/api/chief/messages', 'POST', { content: 'Make this task urgent' })).status).toBe(202);
    await eventually(() => claude.calls.length === 1);
    expect(claude.calls[0].request.phase).toBe('chief');
    claude.calls[0].resolve({ text: JSON.stringify({ message: 'Priority updated.', actions: [{ type: 'update_task', taskId: task.id, priority: 1 }] }) });
    await eventually(async () => (await repository.messages(scope)).some(message => message.role === 'assistant'));
    expect(await service.getTask(task.id)).toMatchObject({ status: 'backlog', priority: 1 });
  });

  it('preserves priority when a chief action changes only status', async () => {
    const task = await service.createTask({ title: 'Status only', status: 'backlog', priority: 2 });
    await service.sendChief('Queue this task');
    await eventually(() => claude.calls.length === 1);
    claude.calls[0].resolve({ text: JSON.stringify({ message: 'Task queued.', actions: [{ type: 'update_task', taskId: task.id, status: 'todo' }] }) });
    await eventually(async () => (await repository.messages(scope)).some(message => message.role === 'assistant'));
    expect(await service.getTask(task.id)).toMatchObject({ status: 'todo', priority: 2 });
  });

  it('validates the saved worktree again before an approved build', async () => {
    const task = await service.createTask({ title: 'Branch validation' });
    await enableDispatch();
    await eventually(() => claude.calls.length === 1);
    claude.calls[0].resolve({ text: '# RFC\nImplement in this worktree.', sessionId: 'planning-session' });
    await eventually(async () => (await service.getTask(task.id)).status === 'in_review');
    vi.mocked(workspaces.ensure).mockRejectedValue(new Error('Worktree branch changed outside Muon'));
    const reviewed = await service.getTask(task.id);
    await service.approve(task.id, reviewed.plans[0].id);
    await eventually(async () => (await service.getTask(task.id)).status === 'blocked' || claude.calls.length > 1);
    expect(claude.calls).toHaveLength(1);
    expect((await service.getTask(task.id)).error).toContain('branch changed');
  });

  it('cannot launch a newly claimed task after shutdown begins', async () => {
    await service.createTask({ title: 'Shutdown race' });
    await repository.saveSettings(scope, { ...await repository.settings(scope), dispatcherEnabled: true });
    const saveTask = repository.saveTask.bind(repository);
    let claiming = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(repository, 'saveTask').mockImplementation(async (...args) => {
      if (args[1].status === 'in_progress' && args[1].runId) { claiming = true; await gate; }
      return saveTask(...args);
    });
    const tick = service.tick();
    await eventually(() => claiming);
    const stop = service.stop();
    release();
    await Promise.all([stop, tick]);
    await setImmediate();
    expect(claude.calls).toHaveLength(0);
  });

  it('does not apply chief actions after shutdown begins', async () => {
    await service.sendChief('Create a task');
    await eventually(() => claude.calls.length === 1);
    claude.calls[0].resolve({ text: JSON.stringify({ message: 'Created.', actions: [{ type: 'create_task', title: 'Late task', status: 'backlog' }] }) });
    await service.stop();
    expect(await repository.tasks(scope)).toEqual([]);
  });

  it('accepts only one simultaneous chief request', async () => {
    const responses = await Promise.all([
      request('/api/chief/messages', 'POST', { content: 'First request' }),
      request('/api/chief/messages', 'POST', { content: 'Second request' }),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([202, 409]);
    expect((await repository.messages(scope)).filter(message => message.role === 'user')).toHaveLength(1);
  });

  it('does not recycle a slot when process termination was not confirmed', async () => {
    const first = await service.createTask({ title: 'First task', priority: 1 });
    await service.createTask({ title: 'Queued task', priority: 2 });
    await enableDispatch();
    await eventually(() => claude.calls.length === 1);
    claude.calls[0].reject(new AgentProcessUnreapedError());
    await eventually(async () => (await service.getTask(first.id)).status === 'blocked');
    await setImmediate();
    await service.tick();
    expect(claude.calls).toHaveLength(1);
    expect((await service.snapshot()).runtime.activeRuns).toBe(1);
  });
});
