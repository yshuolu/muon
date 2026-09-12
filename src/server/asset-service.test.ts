import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scope } from '../shared/types';
import { AssetService, MAX_ASSET_BYTES } from './asset-service';
import { LocalArtifactStore } from './local-artifacts';
import { LocalAssetStorage } from './local-assets';
import { SqliteRepository } from './sqlite-repository';

const scope: Scope = { workspaceId: 'workspace-a', projectId: 'project-a', userId: 'owner-a' };
let temporary: string;
let workspace: string;
let storage: LocalAssetStorage;
let legacy: LocalArtifactStore;
let repository: SqliteRepository;
let service: AssetService;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'muon-assets-'));
  workspace = join(temporary, 'worktree');
  await mkdir(workspace);
  repository = new SqliteRepository(join(temporary, 'muon.sqlite'));
  await repository.initialize(scope, {
    id: scope.projectId, workspaceId: scope.workspaceId, ownerUserId: scope.userId,
    name: 'Project', identifier: 'MUO', repositoryPath: workspace,
  }, { maxConcurrentAgents: 1, defaultProvider: 'claude', dispatcherEnabled: false });
  storage = new LocalAssetStorage(join(temporary, 'assets'));
  legacy = new LocalArtifactStore(join(temporary, 'artifacts'));
  service = new AssetService({ repository, storage, legacyArtifacts: legacy });
});
afterEach(async () => {
  vi.restoreAllMocks();
  repository.close();
  await rm(temporary, { recursive: true, force: true });
});

describe('AssetService', () => {
  it('persists one asset model for arbitrary uploaded bytes and recognizes Markdown', async () => {
    const data = Uint8Array.from([0, 255, 7]);
    const binary = await service.upload(scope, { name: 'model.custom', data });
    const report = await service.upload(scope, { name: 'report.MD', mediaType: 'application/octet-stream', data: Buffer.from('# Report') });
    expect(binary).toMatchObject({ name: 'model.custom', mediaType: 'application/octet-stream', sizeBytes: 3, origin: 'upload', createdByUserId: scope.userId, ownerUserId: scope.userId, visibility: 'private' });
    expect(binary.sha256).toBe(createHash('sha256').update(data).digest('hex'));
    expect(report.mediaType).toBe('text/markdown');
    data[0] = 17;
    expect((await service.read(scope, binary.id))?.data).toEqual(Buffer.from([0, 255, 7]));
    expect(await service.list(scope, [report.id, binary.id, report.id, 'missing'])).toEqual([report, binary]);
    expect(await service.list(scope)).toEqual([binary, report]);
    expect(await service.get({ ...scope, projectId: 'other-project' }, binary.id)).toBeUndefined();
    expect(await service.read({ ...scope, workspaceId: 'other-workspace' }, binary.id)).toBeUndefined();
  });

  it('copies generated files with provenance and media type from their original extension', async () => {
    await writeFile(join(workspace, 'report.md'), '# Original report');
    const asset = await service.importFile(scope, {
      workspacePath: workspace, relativePath: 'report.md', name: 'Report.txt',
    });
    await writeFile(join(workspace, 'report.md'), '# A later report');
    expect(asset).toMatchObject({ name: 'Report.txt', mediaType: 'text/markdown', origin: 'generated', sourcePath: 'report.md' });
    expect(asset).not.toHaveProperty('sourceTaskId');
    expect(asset).not.toHaveProperty('sourceRunId');
    expect(Buffer.from((await service.read(scope, asset.id))!.data).toString()).toBe('# Original report');
  });

  it('rejects unsafe paths, escaping symlinks, directories, and oversized files', async () => {
    await writeFile(join(temporary, 'outside.md'), 'private');
    await symlink(join(temporary, 'outside.md'), join(workspace, 'escape.md'));
    await symlink(temporary, join(workspace, 'escape-directory'));
    await mkdir(join(workspace, 'directory.md'));
    await writeFile(join(workspace, 'oversized.bin'), '');
    await truncate(join(workspace, 'oversized.bin'), MAX_ASSET_BYTES + 1);
    for (const path of [join(temporary, 'outside.md'), '../outside.md', 'escape.md', 'escape-directory/outside.md', 'directory.md', 'oversized.bin', '.']) {
      await expect(service.importFile(scope, { workspacePath: workspace, relativePath: path })).rejects.toThrow();
    }
    expect(await service.list(scope)).toEqual([]);
  });

  it('permits a worktree symlink whose file remains inside the worktree', async () => {
    await writeFile(join(workspace, 'report.md'), '# Report');
    await symlink(join(workspace, 'report.md'), join(workspace, 'alias.md'));
    const asset = await service.importFile(scope, { workspacePath: workspace, relativePath: 'alias.md' });
    expect(Buffer.from((await service.read(scope, asset.id))!.data).toString()).toBe('# Report');
  });

  it('rejects invalid upload names and uses a safe fallback for malformed MIME input', async () => {
    for (const name of ['../report.md', '/report.md', 'folder\\report.md', '.', '', 'bad\nname', 'x'.repeat(256)]) {
      await expect(service.upload(scope, { name, data: Buffer.from('bytes') })).rejects.toThrow();
    }
    const asset = await service.upload(scope, { name: 'unknown', mediaType: 'text/html\r\nInjected: header', data: Buffer.from('bytes') });
    expect(asset.mediaType).toBe('application/octet-stream');
  });

  it('retains legacy bytes with deterministic IDs through repeated imports and reopening', async () => {
    await writeFile(join(workspace, 'report.md'), '# Legacy report');
    const url = await legacy.importFile(scope, 'task-1', workspace, 'report.md');
    const [first, simultaneous] = await Promise.all([
      service.importLegacy(scope, url),
      service.importLegacy(scope, url),
    ]);
    expect(first).toEqual(simultaneous);
    expect(first?.mediaType).toBe('text/markdown');
    repository.close();
    repository = new SqliteRepository(join(temporary, 'muon.sqlite'));
    service = new AssetService({ repository, storage, legacyArtifacts: legacy });
    expect(await service.importLegacy(scope, url)).toEqual(first);
    expect(await service.list(scope)).toHaveLength(1);
    expect(Buffer.from((await service.read(scope, first!.id))!.data).toString()).toBe('# Legacy report');
  });

  it('recovers legacy imports after failed database insertion or a storage publication error', async () => {
    await writeFile(join(workspace, 'report.md'), '# Legacy report');
    const url = await legacy.importFile(scope, 'task-1', workspace, 'report.md');
    vi.spyOn(repository, 'insertAsset').mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(service.importLegacy(scope, url)).rejects.toThrow('Database unavailable');
    expect(await service.list(scope)).toEqual([]);
    const write = storage.write.bind(storage);
    vi.spyOn(storage, 'write').mockImplementationOnce(async (...args) => {
      await write(...args);
      throw new Error('Storage acknowledgement lost');
    });
    await expect(service.importLegacy(scope, url)).rejects.toThrow('Storage acknowledgement lost');
    expect(await service.list(scope)).toEqual([]);
    expect(await service.importLegacy(scope, url)).toBeDefined();
    expect(await service.list(scope)).toHaveLength(1);
  });

  it('does not turn untrusted legacy URLs into reads outside the legacy API', async () => {
    const read = vi.spyOn(legacy, 'read');
    for (const url of ['https://example.com/file.md', '/api/artifacts/../../outside.md', '/api/assets/asset-1', '/api/artifacts/missing.md']) {
      expect(await service.importLegacy(scope, url)).toBeUndefined();
    }
    expect(read).not.toHaveBeenCalled();
    expect(await service.importLegacy(scope, '/api/artifacts/00000000-0000-0000-0000-000000000000.md')).toBeUndefined();
  });

  it('reports unavailable storage and detects bytes changed outside Muon', async () => {
    const asset = await service.upload(scope, { name: 'report.md', data: Buffer.from('# Report') });
    const unavailable = new AssetService({ repository, storage: new LocalAssetStorage(join(temporary, 'other'), 'another-backend') });
    await expect(unavailable.read(scope, asset.id)).rejects.toThrow('backend');
    const root = join(temporary, 'assets');
    const stored = join(root, (await readdir(root, { recursive: true })).find(path => path.endsWith(asset.objectKey))!);
    await writeFile(stored, '# Tampered');
    await expect(service.read(scope, asset.id)).rejects.toThrow('integrity');
    await rm(stored);
    expect(await service.read(scope, asset.id)).toBeUndefined();
  });

  it('enforces ownership for private assets and project scope for shared assets', async () => {
    const otherUser = { ...scope, userId: 'another-user' };
    const privateAsset = await service.upload(scope, { name: 'private.md', data: Buffer.from('owner only') });
    const sharedAsset = await service.upload(scope, { name: 'shared.md', data: Buffer.from('project members'), visibility: 'project' });
    const otherPrivate = await service.upload(otherUser, { name: 'other.md', data: Buffer.from('another owner') });
    const read = vi.spyOn(storage, 'read');
    expect(await service.get(otherUser, privateAsset.id)).toBeUndefined();
    expect(await service.read(otherUser, privateAsset.id)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(await service.list(otherUser)).toEqual([sharedAsset, otherPrivate]);
    expect(await service.list(scope, [otherPrivate.id, privateAsset.id, sharedAsset.id])).toEqual([privateAsset, sharedAsset]);
    expect((await service.read(otherUser, sharedAsset.id))?.asset.id).toBe(sharedAsset.id);
    expect(await service.read({ ...otherUser, projectId: 'another-project' }, sharedAsset.id)).toBeUndefined();
    expect(await service.get({ ...otherUser, workspaceId: 'another-workspace' }, sharedAsset.id)).toBeUndefined();
  });

  it('does not disclose an imported private legacy asset to another project member', async () => {
    await writeFile(join(workspace, 'report.md'), '# Owner report');
    const url = await legacy.importFile(scope, 'task-1', workspace, 'report.md');
    const asset = await service.importLegacy(scope, url);
    expect(asset?.visibility).toBe('private');
    expect(await service.importLegacy({ ...scope, userId: 'another-user' }, url)).toBeUndefined();
    expect(await service.list({ ...scope, userId: 'another-user' })).toEqual([]);
  });
});
