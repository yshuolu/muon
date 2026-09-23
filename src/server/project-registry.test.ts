import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentRequest, AgentResult, WorkspaceProvider } from '../runtime';
import type { Project, Task } from '../shared/types';
import { createHttpApp } from './http-app';
import { LocalChiefCommands } from './local-chief-commands';
import type { ArtifactStore } from './ports';
import { ProjectRegistry, deriveIdentifier } from './project-registry';
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

const identity = { workspaceId: 'registry-workspace', userId: 'owner' };
let repository: SqliteRepository;
let registry: ProjectRegistry;
let claude: TestAdapter;
let codex: TestAdapter;
let workspaces: WorkspaceProvider;
let commands: LocalChiefCommands;
let app: ReturnType<typeof createHttpApp>;

function build(repo: SqliteRepository) {
  const artifacts: ArtifactStore = { importFile: vi.fn(), read: vi.fn(async () => undefined) };
  const created = new ProjectRegistry({
    scope: identity, repository: repo, workspaces, adapters: { claude, codex },
    defaultSettings: { maxConcurrentAgents: 1, dispatcherEnabled: false, defaultProvider: 'claude' },
    seed: { name: 'My project', identifier: 'MUO', repositoryPath: '/repos/first' },
    createService: (scope, providerAvailability) => new TaskService({ scope, repository: repo, artifacts, workspaces, adapters: { claude, codex }, chiefCommands: commands, providerAvailability }),
  });
  commands = new LocalChiefCommands({ apiUrl: 'http://127.0.0.1:4310', scope: identity, resolveProjectId: reference => created.projectIdFor(reference) });
  return { registry: created, app: createHttpApp(created, artifacts, { access: commands }) };
}

beforeEach(async () => {
  repository = new SqliteRepository(':memory:');
  claude = new TestAdapter('claude'); codex = new TestAdapter('codex', false);
  workspaces = {
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
    expect(deriveIdentifier('My project', [])).toBe('MP');
    expect(deriveIdentifier('Release checklist tooling', [])).toBe('RCT');
    expect(deriveIdentifier('123 app', [])).toBe('APP');
    expect(deriveIdentifier('!!!', [])).toBe('PRJ');
    expect(deriveIdentifier('Muon', ['muon'])).toBe('MUON2');
    expect(deriveIdentifier('Muons', ['MUONS', 'MUON2'])).toBe('MUON3');
  });
});

describe('project registry', () => {
  it('seeds the first project once and serves it under both the legacy and prefixed routes', async () => {
    const projects = await json<Project[]>(await request('/api/projects'));
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ id: 'local-project', name: 'My project', identifier: 'MUO', repositoryPath: '/repos/first', ownerUserId: identity.userId });
    const state = await json<{ project: Project; projects: Project[]; runtime: { providers: Record<string, boolean> } }>(await request('/api/state'));
    expect(state.project.id).toBe('local-project');
    expect(state.projects.map(project => project.id)).toEqual(['local-project']);
    expect(state.runtime.providers).toEqual({ claude: true, codex: false });
    expect((await json<Project>(await request('/api/projects/local-project/project'))).id).toBe('local-project');
    expect((await json<Project>(await request('/api/projects/muo/project'))).id).toBe('local-project');
    expect((await request('/api/projects/missing/project')).status).toBe(404);
    expect((await request('/api/projects/missing')).status).toBe(404);
  });

  it('creates projects with validated repositories and unique identifiers, isolating their records', async () => {
    expect((await request('/api/projects', 'POST', { name: 'Second app', repositoryPath: 'relative/path' })).status).toBe(400);
    expect((await request('/api/projects', 'POST', { name: 'Second app', repositoryPath: '/repos/second', identifier: 'muo' })).status).toBe(409);
    expect((await request('/api/projects', 'POST', { name: 'Second app', repositoryPath: '/repos/second', identifier: '1AB' })).status).toBe(400);
    const second = await json<Project>(await request('/api/projects', 'POST', { name: 'Second app', repositoryPath: '/repos/second' }), 201);
    expect(second).toMatchObject({ name: 'Second app', identifier: 'SA', repositoryPath: '/repos/second', workspaceId: identity.workspaceId });
    expect(second.id).not.toBe('local-project');
    expect(second.createdAt).toBeTruthy();
    const sameRepo = await json<Project>(await request('/api/projects', 'POST', { name: 'Second app', repositoryPath: '/repos/second' }), 201);
    expect(sameRepo.identifier).toBe('SA2');
    const task = await json<Task>(await request(`/api/projects/${second.id}/tasks`, 'POST', { title: 'Only in the second project', status: 'backlog' }), 201);
    expect(task).toMatchObject({ projectId: second.id, identifier: 'SA-1' });
    expect(await json<Task[]>(await request('/api/tasks'))).toEqual([]);
    expect(await json<Task[]>(await request('/api/projects/local-project/tasks'))).toEqual([]);
    expect((await json<Task[]>(await request(`/api/projects/SA/tasks`))).map(item => item.id)).toEqual([task.id]);
    expect((await request(`/api/projects/local-project/tasks/${task.id}`)).status).toBe(404);
    expect((await request(`/api/projects/local-project/tasks`, 'POST', { title: 'Cross-project relation', parentId: task.id })).status).toBe(400);
    const settings = await json<{ maxConcurrentAgents: number; dispatcherEnabled: boolean }>(await request(`/api/projects/${second.id}/settings`));
    expect(settings).toMatchObject({ maxConcurrentAgents: 1, dispatcherEnabled: false });
    expect((await json<Project[]>(await request('/api/projects'))).map(project => project.identifier)).toEqual(['MUO', 'SA', 'SA2']);
  });

  it('renames and rebinds a project through its own resource', async () => {
    const renamed = await json<Project>(await request('/api/projects/local-project', 'PATCH', { name: 'Renamed', repositoryPath: '/repos/moved' }));
    expect(renamed).toMatchObject({ id: 'local-project', name: 'Renamed', repositoryPath: '/repos/moved' });
    expect((await request('/api/projects/local-project', 'PATCH', { repositoryPath: 'nope' })).status).toBe(400);
    expect((await request('/api/projects/local-project', 'PATCH', { identifier: 'X' })).status).toBe(400);
    expect((await json<{ project: Project }>(await request('/api/state'))).project.name).toBe('Renamed');
  });

  it('archives only idle projects, hides them from routing, and restores them with their records', async () => {
    const second = await json<Project>(await request('/api/projects', 'POST', { name: 'Second', repositoryPath: '/repos/second' }), 201);
    const task = await json<Task>(await request(`/api/projects/${second.id}/tasks`, 'POST', { title: 'Keep me', status: 'backlog' }), 201);
    await repository.saveSettings({ ...identity, projectId: second.id }, { maxConcurrentAgents: 1, dispatcherEnabled: true, defaultProvider: 'claude' });
    await json<Task>(await request(`/api/projects/${second.id}/tasks/${task.id}`, 'PATCH', { status: 'todo' }));
    await eventually(() => claude.calls.length === 1);
    expect((await request(`/api/projects/${second.id}/archive`, 'POST', {})).status).toBe(409);
    claude.calls[0].resolve({ text: '# RFC' });
    await eventually(async () => (await json<Task>(await request(`/api/projects/${second.id}/tasks/${task.id}`))).status === 'in_review');
    const archived = await json<Project>(await request(`/api/projects/${second.id}/archive`, 'POST', {}));
    expect(archived.archivedAt).toBeTruthy();
    expect((await request(`/api/projects/${second.id}/archive`, 'POST', {})).status).toBe(409);
    expect((await request(`/api/projects/${second.id}/tasks`)).status).toBe(404);
    expect((await json<Project>(await request(`/api/projects/${second.id}`))).archivedAt).toBe(archived.archivedAt);
    expect((await json<{ projects: Project[] }>(await request('/api/state'))).projects.map(project => project.archivedAt !== undefined)).toEqual([false, true]);
    const restored = await json<Project>(await request(`/api/projects/${second.id}/restore`, 'POST', {}));
    expect(restored.archivedAt).toBeUndefined();
    expect((await request(`/api/projects/${second.id}/restore`, 'POST', {})).status).toBe(409);
    expect((await json<Task[]>(await request(`/api/projects/${second.id}/tasks`))).map(item => item.id)).toEqual([task.id]);
  });

  it('falls back to the next active project for legacy routes and reports when none remain', async () => {
    const second = await json<Project>(await request('/api/projects', 'POST', { name: 'Second', repositoryPath: '/repos/second' }), 201);
    await json<Project>(await request('/api/projects/local-project/archive', 'POST', {}));
    expect((await json<{ project: Project }>(await request('/api/state'))).project.id).toBe(second.id);
    await json<Project>(await request(`/api/projects/${second.id}/archive`, 'POST', {}));
    expect((await request('/api/state')).status).toBe(404);
    expect(await json<Project[]>(await request('/api/projects'))).toHaveLength(2);
    await json<Project>(await request('/api/projects/local-project/restore', 'POST', {}));
    expect((await json<{ project: Project }>(await request('/api/state'))).project.id).toBe('local-project');
  });

  it('reloads every project and its archived state from the database', async () => {
    const second = await json<Project>(await request('/api/projects', 'POST', { name: 'Second', repositoryPath: '/repos/second' }), 201);
    await json<Project>(await request(`/api/projects/${second.id}/archive`, 'POST', {}));
    await registry.stopAll();
    ({ registry, app } = build(repository));
    await registry.load();
    const projects = await json<Project[]>(await request('/api/projects'));
    expect(projects.map(project => [project.id, project.archivedAt !== undefined])).toEqual([['local-project', false], [second.id, true]]);
    expect((await request(`/api/projects/${second.id}/tasks`)).status).toBe(404);
    expect((await request('/api/projects/local-project/tasks')).status).toBe(200);
  });

  it('binds chief credentials to the project that opened them', async () => {
    const second = await json<Project>(await request('/api/projects', 'POST', { name: 'Second', repositoryPath: '/repos/second' }), 201);
    const grant = await commands.open({ ...identity, projectId: second.id }, new AbortController().signal);
    try {
      const headers = { authorization: `Bearer ${grant.cli.token}` };
      const created = await json<Task>(await request(`/api/projects/${second.id}/tasks`, 'POST', { title: 'Chief task', status: 'backlog' }, headers), 201);
      expect(created.projectId).toBe(second.id);
      expect(grant.taskIds()).toEqual([created.id]);
      expect(second.identifier).toBe('SECON');
      expect((await request(`/api/projects/${second.identifier.toLowerCase()}/tasks`, 'GET', undefined, headers)).status).toBe(200);
      expect((await request('/api/projects/local-project/tasks', 'POST', { title: 'Wrong project' }, headers)).status).toBe(403);
      expect((await request('/api/tasks', 'POST', { title: 'Unprefixed' }, headers)).status).toBe(403);
      expect((await request('/api/projects', 'POST', { name: 'Chief project', repositoryPath: '/repos/chief' }, headers)).status).toBe(403);
      expect((await request(`/api/projects/${second.id}/archive`, 'POST', {}, headers)).status).toBe(403);
      expect(await json<Task[]>(await request('/api/projects/local-project/tasks'))).toEqual([]);
    } finally { await grant.close(); }
  });
});
