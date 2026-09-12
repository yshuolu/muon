import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scope } from '../shared/types';
import { LocalAssetStorage } from './local-assets';

const scope: Scope = { workspaceId: 'workspace-a', projectId: 'project-a', userId: 'owner-a' };
let temporary: string;
let root: string;
let storage: LocalAssetStorage;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'muon-asset-storage-'));
  root = join(temporary, 'assets');
  storage = new LocalAssetStorage(root);
});
afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });

describe('LocalAssetStorage', () => {
  it('stores arbitrary bytes durably, allows identical retries, and rejects replacement', async () => {
    const data = Uint8Array.from([0, 255, 14, 72]);
    await storage.write(scope, 'asset-1', data);
    await storage.write(scope, 'asset-1', data);
    await expect(storage.write(scope, 'asset-1', Uint8Array.from([2]))).rejects.toThrow('immutable');
    expect(await new LocalAssetStorage(root).read(scope, 'asset-1')).toEqual(Buffer.from(data));
    expect((await readdir(root, { recursive: true })).some(path => path.includes('pending-'))).toBe(false);
  });

  it('converges simultaneous identical writes without exposing partial content', async () => {
    const data = Buffer.from('complete immutable object');
    await Promise.all([storage.write(scope, 'asset-1', data), storage.write(scope, 'asset-1', data)]);
    expect(await storage.read(scope, 'asset-1')).toEqual(data);
  });

  it('isolates scopes and safely encodes path-like scope identifiers', async () => {
    const data = Buffer.from('scoped bytes');
    await storage.write(scope, 'asset-1', data);
    expect(await storage.read({ ...scope, workspaceId: 'other' }, 'asset-1')).toBeUndefined();
    expect(await storage.read({ ...scope, projectId: 'other' }, 'asset-1')).toBeUndefined();
    const pathScope = { ...scope, workspaceId: '../workspace', projectId: '..' };
    await storage.write(pathScope, 'asset-1', Buffer.from('path scope'));
    expect(Buffer.from((await storage.read(pathScope, 'asset-1'))!).toString()).toBe('path scope');
    expect(await storage.read(scope, 'asset-1')).toEqual(data);
  });

  it('rejects keys with paths or extensions and returns missing objects as unavailable', async () => {
    for (const key of ['../outside', '/absolute', 'nested/file', 'file.md', '', '..']) {
      await expect(storage.write(scope, key, Buffer.from('bytes'))).rejects.toThrow('storage key');
      await expect(storage.read(scope, key)).rejects.toThrow('storage key');
    }
    expect(await storage.read(scope, 'missing')).toBeUndefined();
  });

  it('does not read or overwrite symlinked objects', async () => {
    await storage.write(scope, 'asset-1', Buffer.from('owned bytes'));
    const stored = join(root, (await readdir(root, { recursive: true })).find(path => path.endsWith('asset-1'))!);
    const outside = join(temporary, 'outside');
    await writeFile(outside, 'outside bytes');
    await rm(stored);
    await symlink(outside, stored);
    expect(await storage.read(scope, 'asset-1')).toBeUndefined();
    await expect(storage.write(scope, 'asset-1', Buffer.from('replacement'))).rejects.toThrow('immutable');
    expect(await readFile(outside, 'utf8')).toBe('outside bytes');
  });

  it('rejects a scoped directory replaced with an escaping symlink before creating files', async () => {
    await storage.write(scope, 'asset-1', Buffer.from('owned bytes'));
    const stored = join(root, (await readdir(root, { recursive: true })).find(path => path.endsWith('asset-1'))!);
    const directory = dirname(stored);
    const outside = join(temporary, 'outside');
    await mkdir(outside);
    await rm(directory, { recursive: true });
    await symlink(outside, directory);
    expect(await storage.read(scope, 'asset-1')).toBeUndefined();
    await expect(storage.write(scope, 'asset-2', Buffer.from('bytes'))).rejects.toThrow('managed storage');
    expect(await readdir(outside)).toEqual([]);
  });
});
