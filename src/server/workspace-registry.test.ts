import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentRequest, AgentResult, WorktreeProvider } from '../runtime';
import type { Workspace, Task } from '../shared/types';
import { createHttpApp } from './http-app';
import { LocalChiefCommands } from './local-chief-commands';
import type { ArtifactStore } from './ports';
import { WorkspaceRegistry, deriveIdentifier } from './workspace-registry';
import { SqliteRepository } from './sqlite-repository';
import { TaskService } from './task-service';

class TestAdapter implements AgentAdapter {
  calls: Array<{ request: AgentRequest; resolve: (result: AgentResult) => void; reject: (error: Error) => void }> = [];
  constructor(readonly provider: 'claude' | 'codex', private readonly installed = true) {}
  async available() { return this.installed; }
  run(request: AgentRequest): Promise<AgentResult> {
    return new Promise((resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
      this.calls.push({ request, resolve, reject });
    });
  }
}

const identity = { accountId: 'registry-workspace', userId: 'owner' };
let repository: SqliteRepository;
let registry: WorkspaceRegistry;
let claude: TestAdapter;
let codex: TestAdapter;
let worktrees: WorktreeProvider;
let commands: LocalChiefCommands;
let app: ReturnType<typeof createHttpApp>;

function build(repo: SqliteRepository) {
  const artifacts: ArtifactStore = { importFile: vi.fn(), read: vi.fn(async () => undefined) };
  const created = new WorkspaceRegistry({
    scope: identity, repository: repo, worktrees, adapters: { claude, codex },
    defaultSettings: { maxConcurrentAgents: 1, dispatcherEnabled: false, defaultProvider: 'claude' },
    seed: { name: 'My workspace', identifier: 'MUO', repositoryPath: '/repos/first' },
    createService: (scope, providerAvailability) => new TaskService({ scope, repository: repo, artifacts, worktrees, adapters: { claude, codex }, chiefCommands: commands, providerAvailability }),
  });
  commands = new LocalChiefCommands({ apiUrl: 'http://127.0.0.1:4310', scope: identity, resolveWorkspaceId: reference => created.workspaceIdFor(reference) });
  return { registry: created, app: createHttpApp(created, artifacts, { access: commands }) };
}

beforeEach(async () => {
  repository = new SqliteRepository(':memory:');
  claude = new TestAdapter('claude'); codex = new TestAdapter('codex', false);
  worktrees = {
    validateRepository: vi.fn(async path => { if (!path.startsWith('/repos/')) throw new Error('Not a repository root.'); }),
    ensure: vi.fn(async ({ taskId }) => ({ path: `/test/worktrees/${taskId}`, branch: `muon/${taskId}`, baseCommit: 'a'.repeat(40) })),
    changedFiles: vi.fn(async () => []),
  };
  ({ registry, app } = build(repository));
  await registry.load();
});
afterEach(async () => {
  for (const call of [...claude.calls, ...codex.calls]) call.reject(new Error('Test cleanup'));
  await registry.stopAll();
  repository.close();
});

function request(path: string, method = 'GET', body?: unknown, headers?: Record<string, string>) {
  return app.request(`http://localhost:4310${path}`, {
    method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return response.json() as Promise<T>;
}
async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (await check()) return; await delay(5); }
  throw new Error('Expected state did not arrive');
}

describe('identifier derivation', () => {
  it('prefers word initials, falls back to leading letters, and stays unique', () => {
    expect(deriveIdentifier('Muon', [])).toBe('MUON');
    expect(deriveIdentifier('My workspace', [])).toBe('MW');
    expect(deriveIdentifier('Release checklist tooling', [])).toBe('RCT');
    expect(deriveIdentifier('123 app', [])).toBe('APP');
    expect(deriveIdentifier('!!!', [])).toBe('PRJ');
    expect(deriveIdentifier('Muon', ['muon'])).toBe('MUON2');
    expect(deriveIdentifier('Muons', ['MUONS', 'MUON2'])).toBe('MUON3');
  });
});

describe('workspace registry', () => {
  it('seeds the first workspace once and serves it under both the legacy and prefixed routes', async () => {
    const workspaces = await json<Workspace[]>(await request('/api/workspaces'));
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({ id: 'local-project', name: 'My workspace', identifier: 'MUO', repositoryPath: '/repos/first', ownerUserId: identity.userId });
    const state = await json<{ workspace: Workspace; workspaces: Workspace[]; runtime: { providers: Record<string, boolean> } }>(await request('/api/state'));
    expect(state.workspace.id).toBe('local-project');
    expect(state.workspaces.map(workspace => workspace.id)).toEqual(['local-project']);
    expect(state.runtime.providers).toEqual({ claude: true, codex: false });
    expect((await json<Workspace>(await request('/api/workspaces/local-project/workspace'))).id).toBe('local-project');
    expect((await json<Workspace>(await request('/api/workspaces/muo/workspace'))).id).toBe('local-project');
    expect((await request('/api/workspaces/missing/workspace')).status).toBe(404);
    expect((await request('/api/workspaces/missing')).status).toBe(404);
  });

  it('creates workspaces with validated repositories and unique identifiers, isolating their records', async () => {
    expect((await request('/api/workspaces', 'POST', { name: 'Second app', repositoryPath: 'relative/path' })).status).toBe(400);
    expect((await request('/api/workspaces', 'POST', { name: 'Second app', repositoryPath: '/repos/second', identifier: 'muo' })).status).toBe(409);
    expect((await request('/api/workspaces', 'POST', { name: 'Second app', repositoryPath: '/repos/second', identifier: '1AB' })).status).toBe(400);
    const second = await json<Workspace>(await request('/api/workspaces', 'POST', { name: 'Second app', repositoryPath: '/repos/second' }), 201);
    expect(second).toMatchObject({ name: 'Second app', identifier: 'SA', repositoryPath: '/repos/second', accountId: identity.accountId });
    expect(second.id).not.toBe('local-project');
    expect(second.createdAt).toBeTruthy();
    const sameRepo = await json<Workspace>(await request('/api/workspaces', 'POST', { name: 'Second app', repositoryPath: '/repos/second' }), 201);
    expect(sameRepo.identifier).toBe('SA2');
    const task = await json<Task>(await request(`/api/workspaces/${second.id}/tasks`, 'POST', { title: 'Only in the second workspace', status: 'backlog' }), 201);
    expect(task).toMatchObject({ workspaceId: second.id, identifier: 'SA-1' });
    expect(await json<Task[]>(await request('/api/tasks'))).toEqual([]);
    expect(await json<Task[]>(await request('/api/workspaces/local-project/tasks'))).toEqual([]);
    expect((await json<Task[]>(await request(`/api/workspaces/SA/tasks`))).map(item => item.id)).toEqual([task.id]);
    expect((await request(`/api/workspaces/local-project/tasks/${task.id}`)).status).toBe(404);
    expect((await request(`/api/workspaces/local-project/tasks`, 'POST', { title: 'Cross-workspace relation', parentId: task.id })).status).toBe(400);
    const settings = await json<{ maxConcurrentAgents: number; dispatcherEnabled: boolean }>(await request(`/api/workspaces/${second.id}/settings`));
    expect(settings).toMatchObject({ maxConcurrentAgents: 1, dispatcherEnabled: false });
    expect((await json<Workspace[]>(await request('/api/workspaces'))).map(workspace => workspace.identifier)).toEqual(['MUO', 'SA', 'SA2']);
  });

  it('initializes a plain folder as a repository only when asked, and explains the alternative otherwise', async () => {
    const initialized: string[] = [];
    worktrees.initializeRepository = vi.fn(async path => { initialized.push(path); });
    vi.mocked(worktrees.validateRepository!).mockImplementation(async path => { if (!initialized.includes(path) && !path.startsWith('/repos/')) throw new Error('not a git repository'); });
    const refused = await request('/api/workspaces', 'POST', { name: 'Plain', repositoryPath: '/plain/folder' });
    expect(refused.status).toBe(400);
    expect((await refused.json() as { error: string }).error).toContain('let Muon initialize one');
    expect(initialized).toEqual([]);
    const created = await json<Workspace>(await request('/api/workspaces', 'POST', { name: 'Plain', repositoryPath: '/plain/folder', initializeRepository: true }), 201);
    expect(created.repositoryPath).toBe('/plain/folder');
    expect(initialized).toEqual(['/plain/folder']);
    vi.mocked(worktrees.initializeRepository!).mockRejectedValueOnce(new Error('inside another Git repository'));
    const nested = await request('/api/workspaces', 'POST', { name: 'Nested', repositoryPath: '/repos/first/nested', initializeRepository: true });
    expect(nested.status).toBe(400);
    expect((await nested.json() as { error: string }).error).toContain('Could not initialize');
  });

  it('renames and rebinds a workspace through its own resource', async () => {
    const renamed = await json<Workspace>(await request('/api/workspaces/local-project', 'PATCH', { name: 'Renamed', repositoryPath: '/repos/moved' }));
    expect(renamed).toMatchObject({ id: 'local-project', name: 'Renamed', repositoryPath: '/repos/moved' });
    expect((await request('/api/workspaces/local-project', 'PATCH', { repositoryPath: 'nope' })).status).toBe(400);
    expect((await request('/api/workspaces/local-project', 'PATCH', { identifier: 'X' })).status).toBe(400);
    expect((await json<{ workspace: Workspace }>(await request('/api/state'))).workspace.name).toBe('Renamed');
  });

  it('changes a workspace’s task prefix and renames its existing task identifiers', async () => {
    const task = await json<Task>(await request('/api/workspaces/local-project/tasks', 'POST', { title: 'First task' }), 201);
    expect(task.identifier).toBe('MUO-1');
    const other = await json<Workspace>(await request('/api/workspaces', 'POST', { name: 'Other', repositoryPath: '/repos/other', identifier: 'OTH' }), 201);
    expect((await request('/api/workspaces/local-project', 'PATCH', { identifier: 'oth' })).status).toBe(409);
    const renamed = await json<Workspace>(await request('/api/workspaces/local-project', 'PATCH', { identifier: 'core' }));
    expect(renamed.identifier).toBe('CORE');
    expect((await json<Task>(await request('/api/workspaces/local-project/tasks/CORE-1'))).id).toBe(task.id);
    expect((await request('/api/workspaces/local-project/tasks/MUO-1')).status).toBe(404);
    expect((await json<Task>(await request('/api/workspaces/core/tasks', 'POST', { title: 'Second task' }), 201)).identifier).toBe('CORE-2');
    expect((await json<Workspace>(await request(`/api/workspaces/${other.id}`))).identifier).toBe('OTH');
    expect((await json<Workspace[]>(await request('/api/workspaces'))).map(workspace => workspace.identifier)).toEqual(['CORE', 'OTH']);
  });

  it('archives only idle workspaces, hides them from routing, and restores them with their records', async () => {
    const second = await json<Workspace>(await request('/api/workspaces', 'POST', { name: 'Second', repositoryPath: '/repos/second' }), 201);
    const task = await json<Task>(await request(`/api/workspaces/${second.id}/tasks`, 'POST', { title: 'Keep me', status: 'backlog' }), 201);
    await repository.saveSettings({ ...identity, workspaceId: second.id }, { maxConcurrentAgents: 1, dispatcherEnabled: true, defaultProvider: 'claude' });
    await json<Task>(await request(`/api/workspaces/${second.id}/tasks/${task.id}`, 'PATCH', { status: 'todo' }));
    await eventually(() => claude.calls.length === 1);
    expect((await request(`/api/workspaces/${second.id}/archive`, 'POST', {})).status).toBe(409);
    claude.calls[0].resolve({ text: '# RFC' });
    await eventually(async () => (await json<Task>(await request(`/api/workspaces/${second.id}/tasks/${task.id}`))).status === 'in_review');
    const archived = await json<Workspace>(await request(`/api/workspaces/${second.id}/archive`, 'POST', {}));
    expect(archived.archivedAt).toBeTruthy();
    expect((await request(`/api/workspaces/${second.id}/archive`, 'POST', {})).status).toBe(409);
    expect((await request(`/api/workspaces/${second.id}/tasks`)).status).toBe(404);
    expect((await json<Workspace>(await request(`/api/workspaces/${second.id}`))).archivedAt).toBe(archived.archivedAt);
    expect((await json<{ workspaces: Workspace[] }>(await request('/api/state'))).workspaces.map(workspace => workspace.archivedAt !== undefined)).toEqual([false, true]);
    const restored = await json<Workspace>(await request(`/api/workspaces/${second.id}/restore`, 'POST', {}));
    expect(restored.archivedAt).toBeUndefined();
    expect((await request(`/api/workspaces/${second.id}/restore`, 'POST', {})).status).toBe(409);
    expect((await json<Task[]>(await request(`/api/workspaces/${second.id}/tasks`))).map(item => item.id)).toEqual([task.id]);
  });

  it('falls back to the next active workspace for legacy routes and reports when none remain', async () => {
    const second = await json<Workspace>(await request('/api/workspaces', 'POST', { name: 'Second', repositoryPath: '/repos/second' }), 201);
    await json<Workspace>(await request('/api/workspaces/local-project/archive', 'POST', {}));
    expect((await json<{ workspace: Workspace }>(await request('/api/state'))).workspace.id).toBe(second.id);
    await json<Workspace>(await request(`/api/workspaces/${second.id}/archive`, 'POST', {}));
    expect((await request('/api/state')).status).toBe(404);
    expect(await json<Workspace[]>(await request('/api/workspaces'))).toHaveLength(2);
    await json<Workspace>(await request('/api/workspaces/local-project/restore', 'POST', {}));
    expect((await json<{ workspace: Workspace }>(await request('/api/state'))).workspace.id).toBe('local-project');
  });

  it('reloads every workspace and its archived state from the database', async () => {
    const second = await json<Workspace>(await request('/api/workspaces', 'POST', { name: 'Second', repositoryPath: '/repos/second' }), 201);
    await json<Workspace>(await request(`/api/workspaces/${second.id}/archive`, 'POST', {}));
    await registry.stopAll();
    ({ registry, app } = build(repository));
    await registry.load();
    const workspaces = await json<Workspace[]>(await request('/api/workspaces'));
    expect(workspaces.map(workspace => [workspace.id, workspace.archivedAt !== undefined])).toEqual([['local-project', false], [second.id, true]]);
    expect((await request(`/api/workspaces/${second.id}/tasks`)).status).toBe(404);
    expect((await request('/api/workspaces/local-project/tasks')).status).toBe(200);
  });

  it('binds chief credentials to the workspace that opened them', async () => {
    const second = await json<Workspace>(await request('/api/workspaces', 'POST', { name: 'Second', repositoryPath: '/repos/second' }), 201);
    const grant = await commands.open({ ...identity, workspaceId: second.id }, new AbortController().signal);
    try {
      const headers = { authorization: `Bearer ${grant.cli.token}` };
      const created = await json<Task>(await request(`/api/workspaces/${second.id}/tasks`, 'POST', { title: 'Chief task', status: 'backlog' }, headers), 201);
      expect(created.workspaceId).toBe(second.id);
      expect(grant.taskIds()).toEqual([created.id]);
      expect(second.identifier).toBe('SECON');
      expect((await request(`/api/workspaces/${second.identifier.toLowerCase()}/tasks`, 'GET', undefined, headers)).status).toBe(200);
      expect((await request('/api/workspaces/local-project/tasks', 'POST', { title: 'Wrong workspace' }, headers)).status).toBe(403);
      expect((await request('/api/tasks', 'POST', { title: 'Unprefixed' }, headers)).status).toBe(403);
      expect((await request('/api/workspaces', 'POST', { name: 'Chief workspace', repositoryPath: '/repos/chief' }, headers)).status).toBe(403);
      expect((await request(`/api/workspaces/${second.id}/archive`, 'POST', {}, headers)).status).toBe(403);
      expect(await json<Task[]>(await request('/api/workspaces/local-project/tasks'))).toEqual([]);
    } finally { await grant.close(); }
  });
});
