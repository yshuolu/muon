import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, WorkspaceProvider } from '../runtime';
import type { Asset, Task } from '../shared/types';
import { AssetService } from './asset-service';
import { createHttpApp } from './http-app';
import { LocalAssetStorage } from './local-assets';
import { LocalChiefCommands } from './local-chief-commands';
import type { ArtifactStore } from './ports';
import { SqliteRepository } from './sqlite-repository';
import { TaskService } from './task-service';

const scope = { workspaceId: 'asset-workspace', projectId: 'asset-project', userId: 'owner' };
let directory: string;
let repository: SqliteRepository;
let assets: AssetService;
let service: TaskService;
let workspaces: WorkspaceProvider;
let commands: LocalChiefCommands;
let app: ReturnType<typeof createHttpApp>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'muon-assets-http-'));
  repository = new SqliteRepository(':memory:');
  await repository.initialize(scope, {
    id: scope.projectId, workspaceId: scope.workspaceId, ownerUserId: scope.userId,
    name: 'Asset project', identifier: 'AST', repositoryPath: join(directory, 'repository'),
  }, { maxConcurrentAgents: 1, dispatcherEnabled: false, defaultProvider: 'claude' });
  workspaces = {
    ensure: vi.fn(async ({ taskId }) => ({ path: join(directory, 'worktrees', taskId), branch: `muon/${taskId}`, baseCommit: 'a'.repeat(40) })),
    changedFiles: vi.fn(async () => []),
  };
  const artifacts: ArtifactStore = { importFile: vi.fn(), read: vi.fn(async () => undefined) };
  assets = new AssetService({ repository, storage: new LocalAssetStorage(join(directory, 'assets')), legacyArtifacts: artifacts });
  const claude: AgentAdapter = { provider: 'claude', available: async () => true, run: vi.fn(async () => ({ text: '# RFC' })) };
  const codex: AgentAdapter = { ...claude, provider: 'codex' };
  commands = new LocalChiefCommands({ apiUrl: 'http://127.0.0.1:4310', scope });
  service = new TaskService({ scope, repository, artifacts, assets, workspaces, adapters: { claude, codex }, chiefCommands: commands });
  await service.initialize();
  app = createHttpApp(service, artifacts, { staticRoot: directory, access: commands });
});

afterEach(async () => {
  await service.stop();
  repository.close();
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function request(path: string, method = 'GET', body?: unknown, headers?: Record<string, string>) {
  return app.request(`http://localhost:4310${path}`, {
    method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function upload(path: string, name: string, content: string | Uint8Array, type = 'application/octet-stream', headers?: Record<string, string>) {
  const body = new FormData();
  body.append('file', new File([typeof content === 'string' ? content : new Uint8Array(content)], name, { type }));
  return app.request(`http://localhost:4310${path}`, { method: 'POST', body, headers });
}

async function taskWithReport(status: 'blocked' | 'done' = 'blocked') {
  const task = await service.createTask({ title: 'Generate report', status: 'backlog' });
  const worktree = await workspaces.ensure({ repositoryPath: join(directory, 'repository'), taskId: task.id });
  await mkdir(worktree.path, { recursive: true });
  await writeFile(join(worktree.path, 'report.md'), '# Findings\n\nA readable report.\n');
  const changedFiles = [{ path: 'report.md', status: 'added', additions: 3, deletions: 0 }];
  vi.mocked(workspaces.changedFiles).mockResolvedValue(changedFiles);
  return repository.saveTask(scope, { ...task, status, phase: status === 'done' ? 'complete' : 'verification', worktree, changedFiles }, task.version);
}

describe('asset HTTP resources', () => {
  it('preserves Unicode filenames in original downloads', async () => {
    const created = await upload('/api/assets', '📄报告.md', '# Report');
    expect(created.status).toBe(201);
    const asset = await created.json() as Asset;
    const response = await request(`/api/assets/${asset.id}/content?download=1`);
    expect(response.headers.get('content-disposition')).toContain(`filename*=UTF-8''${encodeURIComponent('📄报告.md')}`);
  });
  it('retains a Markdown upload as a scoped input and serves its original content', async () => {
    const task = await service.createTask({ title: 'Read the brief', status: 'backlog' });
    const content = '# Brief\n\nReview **these requirements**.\n';
    const response = await upload(`/api/tasks/${task.identifier}/assets`, 'brief.md', content, 'text/markdown');
    expect(response.status).toBe(201);
    const asset = await response.json() as Asset;
    expect(asset).toMatchObject({
      name: 'brief.md', mediaType: 'text/markdown', sizeBytes: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'), origin: 'upload',
      workspaceId: scope.workspaceId, projectId: scope.projectId, createdByUserId: scope.userId,
      ownerUserId: scope.userId, visibility: 'private',
    });
    expect((await service.getTask(task.id)).description).toContain(`[brief.md](asset://${asset.id})`);
    const listed = await request(`/api/tasks/${task.identifier.toLowerCase()}/assets`);
    expect(await listed.json()).toEqual([asset]);
    const metadata = await request(`/api/assets/${asset.id}`);
    expect(await metadata.json()).toEqual(asset);
    expect(metadata.headers.get('cache-control')).toBe('no-store');
    const preview = await request(`/api/assets/${asset.id}/content`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toContain('text/markdown');
    expect(preview.headers.get('x-content-type-options')).toBe('nosniff');
    expect(preview.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await preview.text()).toBe(content);
    const download = await request(`/api/assets/${asset.id}/content?download=1`);
    expect(download.headers.get('content-disposition')).toContain('attachment;');
    expect(download.headers.get('content-disposition')).toContain('brief.md');
    expect(await download.text()).toBe(content);
  });

  it('retains arbitrary binary files and supports full, open-ended, and suffix byte ranges', async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 128, 255, 6, 7, 8, 9]);
    const response = await upload('/api/assets', 'payload.bin', bytes);
    expect(response.status).toBe(201);
    const asset = await response.json() as Asset;
    expect(asset.sizeBytes).toBe(bytes.byteLength);
    const full = await request(`/api/assets/${asset.id}/content`);
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);
    for (const [range, start, end] of [['bytes=2-5', 2, 5], ['bytes=7-', 7, 9], ['bytes=-3', 7, 9]] as const) {
      const partial = await request(`/api/assets/${asset.id}/content`, 'GET', undefined, { range });
      expect(partial.status).toBe(206);
      expect(partial.headers.get('content-range')).toBe(`bytes ${start}-${end}/10`);
      expect(new Uint8Array(await partial.arrayBuffer())).toEqual(bytes.slice(start, end + 1));
    }
    for (const range of ['bytes=10-', 'bytes=7-3', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5']) {
      const invalid = await request(`/api/assets/${asset.id}/content`, 'GET', undefined, { range });
      expect(invalid.status).toBe(416);
      expect(invalid.headers.get('content-range')).toBe('bytes */10');
    }
  });

  it('references the same Asset in another task without duplicating its file record', async () => {
    const producer = await taskWithReport('done');
    const retained = await request(`/api/tasks/${producer.id}/assets/import`, 'POST', { path: 'report.md' });
    expect(retained.status).toBe(201);
    const asset = await retained.json() as Asset;
    const consumer = await service.createTask({ title: 'Use the report', status: 'backlog' });
    const attached = await request(`/api/tasks/${consumer.id}/assets/attach`, 'POST', { assetId: asset.id });
    expect(attached.status).toBe(200);
    expect(await attached.json()).toEqual(asset);
    expect((await service.getTask(consumer.id)).description).toContain(`[report.md](asset://${asset.id})`);
    expect((await service.getTask(producer.id)).summary).toContain(`[report.md](asset://${asset.id})`);
    expect(await repository.assets(scope)).toEqual([asset]);
    expect(await (await request(`/api/tasks/${consumer.id}/assets`)).json()).toEqual([asset]);
  });

  it('retains a blocked task report without changing verification state or depending on its worktree', async () => {
    const task = await taskWithReport();
    const response = await request(`/api/tasks/${task.id}/assets/import`, 'POST', { path: 'report.md' });
    expect(response.status).toBe(201);
    const asset = await response.json() as Asset;
    expect(asset).toMatchObject({ name: 'report.md', mediaType: 'text/markdown' });
    const updated = await service.getTask(task.id);
    expect(updated).toMatchObject({ status: 'blocked', phase: 'verification' });
    expect(updated.summary).toContain(`[report.md](asset://${asset.id})`);
    expect(updated.evidence.slice(0, -1)).toEqual(task.evidence);
    expect(updated.evidence.at(-1)).toMatchObject({ kind: 'note', description: `[report.md](asset://${asset.id})` });
    expect(updated.evidence.at(-1)?.result).toBeUndefined();
    await rm(task.worktree!.path, { recursive: true });
    expect(await (await request(`/api/assets/${asset.id}/content`)).text()).toBe('# Findings\n\nA readable report.\n');
    expect(await (await request(`/api/tasks/${task.id}/assets`)).json()).toEqual([asset]);
  });

  it('refuses changes to task inputs after planning has begun', async () => {
    const task = await service.createTask({ title: 'Approved brief', status: 'backlog' });
    const response = await upload('/api/assets', 'brief.md', '# Brief');
    const asset = await response.json() as Asset;
    await repository.saveTask(scope, {
      ...task, status: 'in_review', phase: 'plan_review',
      plans: [{ id: 'plan-1', version: 1, format: 'markdown', content: '# RFC', status: 'pending', createdAt: new Date().toISOString() }],
    }, task.version);
    expect((await upload(`/api/tasks/${task.id}/assets`, 'late.md', '# Later')).status).toBe(409);
    expect((await request(`/api/tasks/${task.id}/assets/attach`, 'POST', { assetId: asset.id })).status).toBe(409);
    expect((await service.getTask(task.id)).description).toBe(task.description);
    expect(await repository.assets(scope)).toEqual([asset]);
  });

  it('does not reveal or attach assets belonging to another project', async () => {
    const response = await upload('/api/assets', 'private.md', '# Private');
    const asset = await response.json() as Asset;
    const otherScope = { ...scope, projectId: 'other-project' };
    await repository.initialize(otherScope, {
      id: otherScope.projectId, workspaceId: otherScope.workspaceId, ownerUserId: scope.userId,
      name: 'Other project', identifier: 'OTH', repositoryPath: '',
    }, { maxConcurrentAgents: 1, dispatcherEnabled: false, defaultProvider: 'claude' });
    const foreign = await repository.insertAsset(otherScope, { ...asset, id: 'foreign-asset' });
    const task = await service.createTask({ title: 'Stay scoped', status: 'backlog' });
    for (const id of [foreign.id, 'missing']) {
      expect((await request(`/api/assets/${id}`)).status).toBe(404);
      expect((await request(`/api/assets/${id}/content`)).status).toBe(404);
      expect((await request(`/api/tasks/${task.id}/assets/attach`, 'POST', { assetId: id })).status).toBe(404);
    }
    expect((await service.getTask(task.id)).description).toBe(task.description);
  });

  it('enforces asset visibility independently of a task text reference', async () => {
    const otherOwner = { ...scope, userId: 'another-owner' };
    const privateAsset = await assets.upload(otherOwner, { name: 'private.md', data: Buffer.from('# Private') });
    const projectAsset = await assets.upload(otherOwner, { name: 'shared.md', data: Buffer.from('# Project'), visibility: 'project' });
    const task = await service.createTask({ title: 'References do not grant access', status: 'backlog' });
    await repository.saveTask(scope, {
      ...task, description: `[Private](asset://${privateAsset.id})\n[Shared](asset://${projectAsset.id})`,
    }, task.version);
    expect((await request(`/api/assets/${privateAsset.id}`)).status).toBe(404);
    expect((await request(`/api/assets/${privateAsset.id}/content`)).status).toBe(404);
    expect((await request(`/api/tasks/${task.id}/assets/attach`, 'POST', { assetId: privateAsset.id })).status).toBe(404);
    expect(await (await request(`/api/tasks/${task.id}/assets`)).json()).toEqual([projectAsset]);
    expect(await (await request(`/api/assets/${projectAsset.id}/content`)).text()).toBe('# Project');
    expect(await assets.get(otherOwner, privateAsset.id)).toEqual(privateAsset);
  });

  it('derives a deduplicated asset view from descriptions, plans, comments, and results', async () => {
    const brief = await assets.upload(scope, { name: 'brief.md', data: Buffer.from('# Brief') });
    const screenshot = await assets.upload(scope, { name: 'screenshot.png', data: new Uint8Array([1, 2, 3]) });
    const report = await assets.upload(scope, { name: 'report.md', data: Buffer.from('# Report') });
    const task = await service.createTask({
      title: 'Read references', status: 'backlog', description: `[Brief](asset://${brief.id})`,
    });
    const timestamp = new Date().toISOString();
    await repository.saveTask(scope, {
      ...task, summary: `[Report](asset://${report.id})`,
      plans: [{ id: 'referenced-plan', version: 1, format: 'markdown', content: `[Brief again](asset://${brief.id})`, status: 'pending', createdAt: timestamp }],
      planDiscussion: [{ id: 'comment', planId: 'referenced-plan', role: 'user', content: `![Screenshot](asset://${screenshot.id})`, createdAt: timestamp }],
      evidence: [{ id: 'evidence', kind: 'note', title: 'Report retained', description: `[Report again](asset://${report.id})`, createdAt: timestamp }],
    }, task.version);
    const result = await (await request(`/api/tasks/${task.id}/assets`)).json() as Asset[];
    expect(result).toHaveLength(3);
    expect(result).toEqual(expect.arrayContaining([brief, screenshot, report]));
    expect(await repository.assets(scope)).toHaveLength(3);
  });

  it('rejects non-files, unrelated multipart mutations, and foreign origins before writing assets', async () => {
    const form = new FormData();
    form.append('file', 'This is not a file.');
    expect((await app.request('http://localhost:4310/api/assets', { method: 'POST', body: form })).status).toBe(400);
    expect((await upload('/api/tasks', 'brief.md', '# Brief')).status).toBe(415);
    expect((await upload('/api/assets', 'brief.md', '# Brief', 'text/markdown', { origin: 'https://foreign.example' })).status).toBe(403);
    expect(await repository.assets(scope)).toEqual([]);
  });

  it('requires owner authority for uploads, attachment, and output import', async () => {
    const task = await taskWithReport();
    const session = await commands.open(scope, new AbortController().signal);
    const headers = { authorization: `Bearer ${session.cli.token}` };
    try {
      expect((await upload('/api/assets', 'brief.md', '# Brief', 'text/markdown', headers)).status).toBe(403);
      expect((await upload(`/api/tasks/${task.id}/assets`, 'brief.md', '# Brief', 'text/markdown', headers)).status).toBe(403);
      expect((await request(`/api/tasks/${task.id}/assets/attach`, 'POST', { assetId: 'missing' }, headers)).status).toBe(403);
      expect((await request(`/api/tasks/${task.id}/assets/import`, 'POST', { path: 'report.md' }, headers)).status).toBe(403);
      expect(await repository.assets(scope)).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it('imports only listed changed files contained in the owned, inactive worktree', async () => {
    let task = await taskWithReport();
    await writeFile(join(task.worktree!.path, 'unlisted.md'), '# Not an output');
    await writeFile(join(directory, 'outside.md'), '# Outside');
    await symlink(join(directory, 'outside.md'), join(task.worktree!.path, 'escape.md'));
    const changedFiles = [
      ...task.changedFiles, { path: 'escape.md', status: 'added', additions: 1, deletions: 0 },
    ];
    task = await repository.saveTask(scope, { ...task, changedFiles }, task.version);
    vi.mocked(workspaces.changedFiles).mockResolvedValue(changedFiles);
    for (const path of ['unlisted.md', '../outside.md', join(directory, 'outside.md'), 'escape.md']) {
      const response = await request(`/api/tasks/${task.id}/assets/import`, 'POST', { path });
      expect(response.status).toBe(400);
    }
    expect(await repository.assets(scope)).toEqual([]);
    const active: Task = await repository.saveTask(scope, { ...task, status: 'in_progress', phase: 'building', runId: 'active-run' }, task.version);
    expect((await request(`/api/tasks/${active.id}/assets/import`, 'POST', { path: 'report.md' })).status).toBe(409);
    expect(await repository.assets(scope)).toEqual([]);
  });
});
