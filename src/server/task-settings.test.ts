import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentRequest, AgentResult, WorkspaceProvider } from '../runtime';
import type { Scope } from '../shared/types';
import { SqliteRepository } from './sqlite-repository';
import { TaskService } from './task-service';

const scope: Scope = { workspaceId: 'workspace', projectId: 'project', userId: 'owner' };
const fixtures: Array<{ service: TaskService; repo: SqliteRepository }> = [];
async function fixture() {
  const repo = new SqliteRepository(':memory:');
  await repo.initialize(scope, { id: 'project', workspaceId: 'workspace', ownerUserId: 'owner', identifier: 'MUO', name: 'Test project', repositoryPath: '/test/repository' }, { maxConcurrentAgents: 1, dispatcherEnabled: false, defaultProvider: 'claude' });
  const calls: AgentRequest[] = [];
  const adapter: AgentAdapter = {
    provider: 'claude', available: async () => true,
    run: request => new Promise<AgentResult>((_resolve, reject) => {
      calls.push(request);
      request.signal?.addEventListener('abort', () => reject(new Error('Canceled test run')), { once: true });
    }),
  };
  const workspaces: WorkspaceProvider = {
    validateRepository: vi.fn(async () => undefined),
    ensure: async ({ taskId }) => ({ path: `/test/worktrees/${taskId}`, branch: `muon/${taskId}`, baseCommit: 'a'.repeat(40) }),
    changedFiles: async () => [],
  };
  const service = new TaskService({ scope, repository: repo, adapters: { claude: adapter, codex: { ...adapter, provider: 'codex' } }, workspaces, artifacts: { importFile: async () => '', read: async () => undefined } });
  await service.initialize();
  fixtures.push({ service, repo });
  return { service, repo, calls, workspaces };
}
afterEach(async () => {
  for (const { service, repo } of fixtures.splice(0)) { await service.stop(); repo.close(); }
});

describe('TaskService settings admission', () => {
  it('allows changing concurrency and pause settings with the unchanged repository during an active run', async () => {
    const { service, repo, workspaces } = await fixture();
    await service.createTask({ title: 'Active task' });
    await service.updateSettings({ dispatcherEnabled: true });
    await service.tick();
    expect((await service.snapshot()).runtime.activeRuns).toBe(1);
    await service.updateSettings({ repositoryPath: '/test/repository', projectName: 'Renamed project', maxConcurrentAgents: 3, dispatcherEnabled: false });
    expect(await repo.settings(scope)).toMatchObject({ maxConcurrentAgents: 3, dispatcherEnabled: false });
    expect(await repo.project(scope)).toMatchObject({ repositoryPath: '/test/repository', name: 'Renamed project' });
    expect(workspaces.validateRepository).not.toHaveBeenCalled();
  });

  it('waits for an in-flight dispatch decision and rejects a repository change once that run is admitted', async () => {
    const { service, repo, workspaces } = await fixture();
    await service.createTask({ title: 'About to run' });
    await service.tick();
    await repo.saveSettings(scope, { ...await repo.settings(scope), dispatcherEnabled: true });
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(repo, 'pendingChief').mockImplementationOnce(async () => { enter(); await gate; return null; });
    const dispatching = service.tick();
    await entered;
    const changing = service.updateSettings({ repositoryPath: '/test/other-repository' });
    const outcome = changing.then(() => 'succeeded', error => (error as Error).message);
    await setImmediate();
    release();
    await dispatching;
    expect(await outcome).toContain('active agents');
    expect((await repo.project(scope)).repositoryPath).toBe('/test/repository');
    expect(workspaces.validateRepository).not.toHaveBeenCalled();
  });

  it('prevents new admission while validating an actual repository change', async () => {
    const { service, repo, calls, workspaces } = await fixture();
    await service.createTask({ title: 'Queued task' });
    await service.tick();
    await repo.saveSettings(scope, { ...await repo.settings(scope), dispatcherEnabled: true });
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(workspaces.validateRepository!).mockImplementationOnce(async () => { enter(); await gate; });
    const changing = service.updateSettings({ repositoryPath: '/test/new-repository', dispatcherEnabled: false });
    await entered;
    await service.tick();
    expect(calls).toEqual([]);
    release();
    await changing;
    expect((await repo.project(scope)).repositoryPath).toBe('/test/new-repository');
    expect(calls).toEqual([]);
  });

  it('keeps a coding parent queued until its canceled child is removed', async () => {
    const { service, calls } = await fixture();
    const parent = await service.createTask({ title: 'Coding integration parent' });
    const child = await service.createTask({ title: 'Removed child scope', parentId: parent.id, status: 'backlog' });
    await service.editTask(child.id, { status: 'canceled' });
    await service.updateSettings({ dispatcherEnabled: true });
    await service.tick();
    expect(calls).toEqual([]);
    expect(await service.getTask(parent.id)).toMatchObject({ status: 'todo', phase: 'idle' });
    await service.editTask(child.id, { parentId: null });
    await service.tick();
    for (let attempt = 0; calls.length === 0 && attempt < 20; attempt++) await setImmediate();
    expect(calls).toHaveLength(1);
    expect(calls[0].phase).toBe('planning');
  });
});
