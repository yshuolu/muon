import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentRequest, AgentResult, WorkspaceProvider } from '../runtime';
import type { Asset, AssetComment, AssetCommentThread, Task } from '../shared/types';
import { AssetService } from './asset-service';
import { createHttpApp } from './http-app';
import { singleProjectResolver } from './project-registry';
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
let claude: TestAdapter;
let codex: TestAdapter;

/** Holds each run until the test resolves it, so agent output can be scripted. */
class TestAdapter implements AgentAdapter {
  calls: Array<{ request: AgentRequest; resolve: (result: AgentResult) => void; reject: (error: Error) => void }> = [];
  constructor(readonly provider: 'claude' | 'codex') {}
  async available() { return true; }
  run(request: AgentRequest): Promise<AgentResult> {
    return new Promise((resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
      this.calls.push({ request, resolve, reject });
    });
  }
}
async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Expected state did not arrive');
}

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
  claude = new TestAdapter('claude');
  codex = new TestAdapter('codex');
  commands = new LocalChiefCommands({ apiUrl: 'http://127.0.0.1:4310', scope });
  service = new TaskService({ scope, repository, artifacts, assets, workspaces, adapters: { claude, codex }, chiefCommands: commands });
  await service.initialize();
  app = createHttpApp(singleProjectResolver(service), artifacts, { staticRoot: directory, access: commands });
});

afterEach(async () => {
  for (const call of [...claude.calls, ...codex.calls]) call.reject(new Error('Test cleanup'));
  await service.stop();
  repository.close();
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const chiefPath = (path: string) => path.replace(/^\/api/, `/api/projects/${scope.projectId}`);
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
      expect((await upload(chiefPath('/api/assets'), 'brief.md', '# Brief', 'text/markdown', headers)).status).toBe(403);
      expect((await upload(chiefPath(`/api/tasks/${task.id}/assets`), 'brief.md', '# Brief', 'text/markdown', headers)).status).toBe(403);
      expect((await request(chiefPath(`/api/tasks/${task.id}/assets/attach`), 'POST', { assetId: 'missing' }, headers)).status).toBe(403);
      expect((await request(chiefPath(`/api/tasks/${task.id}/assets/import`), 'POST', { path: 'report.md' }, headers)).status).toBe(403);
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

describe('library resources', () => {
  it('lists every authorized asset in the project and hides other owners’ private files', async () => {
    const task = await service.createTask({ title: 'Read the brief', status: 'backlog' });
    const brief = await (await upload(`/api/tasks/${task.id}/assets`, 'brief.md', '# Brief', 'text/markdown')).json() as Asset;
    const standalone = await (await upload('/api/assets', 'diagram.png', new Uint8Array([137, 80, 78, 71]), 'image/png')).json() as Asset;
    const shared = await repository.insertAsset(scope, { ...standalone, id: 'shared-asset', objectKey: 'shared-asset', ownerUserId: 'teammate', createdByUserId: 'teammate', visibility: 'project' });
    await repository.insertAsset(scope, { ...standalone, id: 'private-asset', objectKey: 'private-asset', ownerUserId: 'teammate', createdByUserId: 'teammate', visibility: 'private' });
    const response = await request('/api/assets');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual([brief, standalone, shared]);
  });

  it('creates Markdown reference notes as immutable owner assets', async () => {
    const response = await request('/api/assets/notes', 'POST', { name: 'Release checklist', content: '# Checklist\n\n- Run tests  \n\n' });
    expect(response.status).toBe(201);
    const note = await response.json() as Asset;
    expect(note).toMatchObject({ name: 'Release checklist.md', mediaType: 'text/markdown', origin: 'upload', ownerUserId: scope.userId, visibility: 'private' });
    expect(await (await request(`/api/assets/${note.id}/content`)).text()).toBe('# Checklist\n\n- Run tests\n');
    const keepsExtension = await (await request('/api/assets/notes', 'POST', { name: 'decisions.MD', content: 'Keep it.' })).json() as Asset;
    expect(keepsExtension.name).toBe('decisions.MD');
    const revision = await (await request('/api/assets/notes', 'POST', { name: 'Release checklist', content: '# Checklist v2' })).json() as Asset;
    expect(revision.id).not.toBe(note.id);
    expect((await (await request('/api/assets')).json() as Asset[]).map(asset => asset.id)).toEqual([note.id, keepsExtension.id, revision.id]);
  });

  it('rejects blank, oversized, or path-like notes and multipart note bodies', async () => {
    expect((await request('/api/assets/notes', 'POST', { name: '   ', content: 'Body' })).status).toBe(400);
    expect((await request('/api/assets/notes', 'POST', { name: 'Empty', content: ' \n\t' })).status).toBe(400);
    expect((await request('/api/assets/notes', 'POST', { name: 'nested/note', content: 'Body' })).status).toBe(400);
    expect((await request('/api/assets/notes', 'POST', { name: 'Big', content: 'x'.repeat(200_001) })).status).toBe(400);
    expect((await request('/api/assets/notes', 'POST', { name: 'Extra', content: 'Body', visibility: 'project' })).status).toBe(400);
    expect((await upload('/api/assets/notes', 'note.md', '# Note', 'text/markdown')).status).toBe(415);
    expect(await repository.assets(scope)).toEqual([]);
  });

  it('keeps review comments idempotent, owner-only, pending-only editable, and Markdown-only', async () => {
    const note = await (await request('/api/assets/notes', 'POST', { name: 'Design', content: '# Design\n\nFirst paragraph here.\n\nSecond paragraph to remove.' })).json() as Asset;
    const binary = await (await upload('/api/assets', 'diagram.png', new Uint8Array([137, 80, 78, 71]), 'image/png')).json() as Asset;
    const requestId = '3f2c1a9e-6b4d-4c2f-9a1e-1d2c3b4a5f60';
    const anchor = { quote: 'First paragraph here.', prefix: '# Design ', suffix: ' Second', start: 9 };
    const created = await request(`/api/assets/${note.id}/comments`, 'POST', { content: 'Why first?', requestId, anchor });
    expect(created.status).toBe(201);
    const comment = await created.json() as AssetComment;
    expect(comment).toMatchObject({ assetId: note.id, requestId, content: 'Why first?', anchor, status: 'pending' });
    expect(await (await request(`/api/assets/${note.id}/comments`, 'POST', { content: 'Why first?', requestId, anchor })).json()).toEqual(comment);
    expect((await request(`/api/assets/${note.id}/comments`, 'POST', { content: 'Changed text', requestId, anchor })).status).toBe(409);
    expect((await request(`/api/assets/${note.id}/comments`, 'POST', { content: 'Bad id', requestId: 'nope' })).status).toBe(400);
    expect((await request(`/api/assets/${binary.id}/comments`, 'POST', { content: 'On an image', requestId: crypto.randomUUID() })).status).toBe(400);
    const whole = await (await request(`/api/assets/${note.id}/comments`, 'POST', { content: 'Remove the second paragraph.', requestId: crypto.randomUUID() })).json() as AssetComment;
    expect(whole.anchor).toBeUndefined();
    expect(await (await request(`/api/assets/${note.id}/comments/${whole.id}`, 'PATCH', { content: 'Remove the second paragraph entirely.' })).json()).toMatchObject({ id: whole.id, content: 'Remove the second paragraph entirely.' });
    const thread = await (await request(`/api/assets/${note.id}/comments`)).json() as AssetCommentThread;
    expect(thread.comments.map(item => item.id)).toEqual([comment.id, whole.id]);
    expect(thread.review).toMatchObject({ assetId: note.id, busy: false, provider: 'claude', model: null });
    expect(thread.inherited).toEqual([]);
    expect(await (await request('/api/assets/comment-counts')).json()).toEqual({ [note.id]: 2 });
    expect((await request(`/api/assets/${note.id}/comments/${whole.id}`, 'DELETE', {})).status).toBe(200);
    expect((await request(`/api/assets/${note.id}/comments/missing`, 'DELETE', {})).status).toBe(404);
    const session = await commands.open(scope, new AbortController().signal);
    const headers = { authorization: `Bearer ${session.cli.token}` };
    try {
      expect((await request(chiefPath(`/api/assets/${note.id}/comments`), 'GET', undefined, headers)).status).toBe(200);
      expect((await request(chiefPath(`/api/assets/${note.id}/comments`), 'POST', { content: 'Chief comment', requestId: crypto.randomUUID() }, headers)).status).toBe(403);
      expect((await request(chiefPath(`/api/assets/${note.id}/comments/resolve`), 'POST', {}, headers)).status).toBe(403);
    } finally { await session.close(); }
  });

  it('resolves every pending comment in one run and saves edits as a linked new version', async () => {
    const note = await (await request('/api/assets/notes', 'POST', { name: 'Design', content: '# Design\n\nFirst paragraph here.\n\nSecond paragraph to remove.' })).json() as Asset;
    const question = await (await request(`/api/assets/${note.id}/comments`, 'POST', { content: 'Why first?', requestId: crypto.randomUUID(), anchor: { quote: 'First paragraph here.', prefix: '', suffix: '', start: 9 } })).json() as AssetComment;
    const removal = await (await request(`/api/assets/${note.id}/comments`, 'POST', { content: 'Remove the second paragraph.', requestId: crypto.randomUUID() })).json() as AssetComment;
    const chat = service.createPlanningChat();
    service.updatePlanningChat(chat.id, { provider: 'codex', model: 'gpt-6-astra-mini' });
    expect((await request(`/api/assets/${note.id}/comments/resolve`, 'POST', {})).status).toBe(202);
    let review = (await (await request(`/api/assets/${note.id}/comments`)).json() as AssetCommentThread).review;
    expect(review).toMatchObject({ busy: true, provider: 'codex', model: 'gpt-6-astra-mini' });
    expect((await request(`/api/assets/${note.id}/comments/resolve`, 'POST', {})).status).toBe(409);
    expect((await request(`/api/assets/${note.id}/comments`, 'POST', { content: 'Late', requestId: crypto.randomUUID() })).status).toBe(409);
    await eventually(() => codex.calls.length === 1);
    expect(codex.calls[0].request).toMatchObject({ provider: 'codex', phase: 'chat', model: 'gpt-6-astra-mini' });
    expect(codex.calls[0].request.prompt).toContain('Second paragraph to remove.');
    expect(codex.calls[0].request.prompt).toContain(question.id);
    codex.calls[0].resolve({ text: JSON.stringify({ replies: [{ id: question.id, kind: 'answered', content: 'Because it introduces the design.' }, { id: removal.id, kind: 'changed', content: 'Removed the second paragraph.' }], document: '# Design\n\nFirst paragraph here.' }) });
    await eventually(async () => !(await (await request(`/api/assets/${note.id}/comments`)).json() as AssetCommentThread).review.busy);
    const thread = await (await request(`/api/assets/${note.id}/comments`)).json() as AssetCommentThread;
    expect(thread.review.error).toBeUndefined();
    const revision = await (await request(`/api/assets/${thread.review.revisionAssetId}`)).json() as Asset;
    expect(revision).toMatchObject({ name: 'Design.md', origin: 'generated', previousVersionId: note.id });
    expect(await (await request(`/api/assets/${revision.id}/content`)).text()).toBe('# Design\n\nFirst paragraph here.\n');
    expect(thread.comments.map(item => [item.status, item.reply?.kind, item.reply?.provider, item.revisionAssetId])).toEqual([['resolved', 'answered', 'codex', revision.id], ['resolved', 'changed', 'codex', revision.id]]);
    expect(thread.comments[0].reply?.content).toBe('Because it introduces the design.');
    const inherited = await (await request(`/api/assets/${revision.id}/comments`)).json() as AssetCommentThread;
    expect(inherited.inherited.map(item => item.id)).toEqual([question.id, removal.id]);
    expect(inherited.comments).toEqual([]);
    expect((await request(`/api/assets/${note.id}/comments/${question.id}`, 'PATCH', { content: 'Too late' })).status).toBe(409);
    expect(await (await request('/api/assets/comment-counts')).json()).toEqual({});
  });

  it('keeps comments pending when the run fails, returns nothing usable, or is interrupted', async () => {
    const note = await (await request('/api/assets/notes', 'POST', { name: 'Design', content: '# Design\n\nBody.' })).json() as Asset;
    const comment = await (await request(`/api/assets/${note.id}/comments`, 'POST', { content: 'Rewrite the body.', requestId: crypto.randomUUID() })).json() as AssetComment;
    expect((await request(`/api/assets/${note.id}/comments/resolve`, 'POST', {})).status).toBe(202);
    await eventually(() => claude.calls.length === 1);
    claude.calls[0].resolve({ text: JSON.stringify({ replies: [{ id: comment.id, kind: 'changed', content: 'Rewrote it.' }] }) });
    await eventually(async () => !(await (await request(`/api/assets/${note.id}/comments`)).json() as AssetCommentThread).review.busy);
    let thread = await (await request(`/api/assets/${note.id}/comments`)).json() as AssetCommentThread;
    expect(thread.review.error).toContain('without returning the revised document');
    expect(thread.comments[0]).toMatchObject({ status: 'pending', lastError: thread.review.error });
    expect(await service.listAssets()).toHaveLength(1);
    expect((await request(`/api/assets/${note.id}/comments/resolve`, 'POST', {})).status).toBe(202);
    await eventually(() => claude.calls.length === 2);
    claude.calls[1].resolve({ text: 'not json at all' });
    await eventually(async () => !(await (await request(`/api/assets/${note.id}/comments`)).json() as AssetCommentThread).review.busy);
    thread = await (await request(`/api/assets/${note.id}/comments`)).json() as AssetCommentThread;
    expect(thread.review.error).toContain('unexpected result');
    expect((await request(`/api/assets/${note.id}/comments/resolve`, 'POST', {})).status).toBe(202);
    await eventually(() => claude.calls.length === 3);
    await service.stop();
    thread = await (await request(`/api/assets/${note.id}/comments`)).json() as AssetCommentThread;
    expect(thread.comments[0].status).toBe('pending');
    expect(thread.comments[0].lastError).toContain('interrupted');
    expect(await service.listAssets()).toHaveLength(1);
  });

  it('lets chief credentials read the library but not write notes', async () => {
    const note = await (await request('/api/assets/notes', 'POST', { name: 'Context', content: 'Read me.' })).json() as Asset;
    const session = await commands.open(scope, new AbortController().signal);
    const headers = { authorization: `Bearer ${session.cli.token}` };
    try {
      expect(await (await request(chiefPath('/api/assets'), 'GET', undefined, headers)).json()).toEqual([note]);
      expect((await request('/api/assets', 'GET', undefined, headers)).status).toBe(403);
      expect((await request(chiefPath('/api/assets/notes'), 'POST', { name: 'Chief note', content: 'Body' }, headers)).status).toBe(403);
      expect((await repository.assets(scope)).map(asset => asset.id)).toEqual([note.id]);
    } finally {
      await session.close();
    }
  });
});
