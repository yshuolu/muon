import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentRequest, AgentResult, WorkspaceProvider } from '../runtime';
import { materializeAssetInputs } from '../runtime/local-asset-inputs';
import { assetIdsInText, assetReference } from '../shared/asset-references';
import type { Task } from '../shared/types';
import { AssetService } from './asset-service';
import { LocalAssetStorage } from './local-assets';
import { SqliteRepository } from './sqlite-repository';
import { TaskService } from './task-service';

const scope = { workspaceId: 'workspace', projectId: 'project', userId: 'owner' };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'muon-asset-workflow-'));
  const repository = new SqliteRepository(':memory:');
  await repository.initialize(scope, { id: scope.projectId, workspaceId: scope.workspaceId, ownerUserId: scope.userId, name: 'Test', identifier: 'AST', repositoryPath: directory }, { maxConcurrentAgents: 1, dispatcherEnabled: false, defaultProvider: 'claude' });
  const calls: Array<{ request: AgentRequest; finish: (result: AgentResult) => void }> = [];
  const adapter: AgentAdapter = {
    provider: 'claude', available: async () => true,
    run: request => new Promise((resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('Canceled')), { once: true });
      calls.push({ request, finish: resolve });
    }),
  };
  const workspaces: WorkspaceProvider = {
    ensure: async ({ taskId }) => {
      const path = join(directory, taskId);
      await mkdir(path, { recursive: true });
      return { path, branch: `muon/${taskId}`, baseCommit: 'a'.repeat(40) };
    },
    changedFiles: async () => [],
    materializeInputs: vi.fn((workspace, inputs) => materializeAssetInputs(workspace.path, inputs)),
  };
  const assets = new AssetService({ repository, storage: new LocalAssetStorage(join(directory, 'assets')) });
  const service = new TaskService({ scope, repository, assets, artifacts: { importFile: vi.fn(), read: async () => undefined }, workspaces, adapters: { claude: adapter, codex: { ...adapter, provider: 'codex' } } });
  await service.initialize();
  cleanups.push(async () => { await service.stop(); repository.close(); await rm(directory, { recursive: true, force: true }); });
  async function dispatch() {
    await repository.saveSettings(scope, { ...await repository.settings(scope), dispatcherEnabled: true });
    await service.tick();
  }
  async function taskState(id: string, phase: Task['phase']) {
    await vi.waitFor(async () => expect((await service.getTask(id)).phase).toBe(phase));
    return service.getTask(id);
  }
  return { directory, repository, calls, workspaces, assets, service, dispatch, taskState };
}

describe('asset references across the task lifecycle', () => {
  it('supplies text references as isolated inputs and retains those references in the reviewed RFC', async () => {
    const f = await fixture();
    const input = await f.assets.upload(scope, { name: 'brief.md', data: Buffer.from('# Input brief\n') });
    const task = await f.service.createTask({ title: 'Read the brief', description: assetReference(input) });
    await f.dispatch();
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    expect(f.calls[0].request.prompt).toContain(`.muon-cache/inputs/${input.id}/brief.md`);
    expect(await readFile(join(f.calls[0].request.cwd, '.muon-cache', 'inputs', input.id, 'brief.md'), 'utf8')).toBe('# Input brief\n');
    f.calls[0].finish({ text: '# RFC\nRead the provided brief.' });
    const review = await f.taskState(task.id, 'plan_review');
    expect(review.plans[0].content).toContain(assetReference(input));
    expect(review).not.toHaveProperty('inputAssetIds');
    expect(review.plans[0]).not.toHaveProperty('inputAssetIds');
    await f.service.approve(task.id, review.plans[0].id);
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
    expect(f.calls[1].request.phase).toBe('building');
    expect(f.calls[1].request.prompt).toContain(`.muon-cache/inputs/${input.id}/brief.md`);
    await expect(f.service.attachTaskAsset(task.id, input.id)).rejects.toThrow('before planning');
  });

  it('keeps declared output files readable when verification fails, using result text only', async () => {
    const f = await fixture();
    const task = await f.service.createTask({ title: 'Write a report' });
    await f.dispatch();
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    f.calls[0].finish({ text: '# RFC\nWrite report.md.' });
    const review = await f.taskState(task.id, 'plan_review');
    await f.service.approve(task.id, review.plans[0].id);
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
    await writeFile(join(f.calls[1].request.cwd, 'report.md'), '# Findings\n\nThe complete report.');
    f.calls[1].finish({ text: 'Created report.md.' });
    await vi.waitFor(() => expect(f.calls).toHaveLength(3));
    f.calls[2].finish({ text: JSON.stringify({ summary: 'Report produced; one check failed.', outputPaths: ['report.md', 'missing.md'], evidence: [{ kind: 'test', title: 'Acceptance', description: 'A check failed.', result: 'failed', steps: ['Run acceptance check'] }] }) });
    await vi.waitFor(async () => expect((await f.service.getTask(task.id)).status).toBe('blocked'));
    const saved = await f.service.getTask(task.id);
    expect(saved).not.toHaveProperty('outputAssetIds');
    const [id] = assetIdsInText(saved.summary);
    expect(id).toBeTruthy();
    await rm(join(f.calls[1].request.cwd, 'report.md'));
    expect(Buffer.from((await f.service.readAsset(id)).data).toString()).toBe('# Findings\n\nThe complete report.');
    expect(saved.evidence.some(item => item.title === 'Retain output: missing.md' && item.result === 'failed')).toBe(true);
    expect((await f.service.listTaskAssets(task.id)).map(asset => asset.id)).toEqual([id]);
    await f.service.retry(task.id, { mode: 'retry' });
    await vi.waitFor(() => expect(f.calls).toHaveLength(4));
    f.calls[3].finish({ text: JSON.stringify({ summary: 'Retry passed without new outputs.', evidence: [{ kind: 'test', title: 'Acceptance', description: 'Passed.', result: 'passed', steps: ['Run acceptance check'] }] }) });
    await vi.waitFor(async () => expect((await f.service.getTask(task.id)).status).toBe('done'));
    expect((await f.service.listTaskAssets(task.id)).map(asset => asset.id)).toEqual([id]);
  });
});
