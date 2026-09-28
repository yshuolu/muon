import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASSET_INPUT_DIRECTORY, materializeAssetInputs } from './local-asset-inputs';

let temporary: string;
let worktree: string;
const input = (id = 'asset-1', name = 'report.md', content = '# Report') => {
  const data = Buffer.from(content);
  return { id, name, data, sha256: createHash('sha256').update(data).digest('hex') };
};

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'muon-asset-inputs-'));
  worktree = join(temporary, 'worktree');
  await mkdir(worktree);
});
afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });

describe('materializeAssetInputs', () => {
  it('stages separate read-only copies and allows identical retries', async () => {
    const first = input();
    const second = input('asset-2', 'report.md', '# Another report');
    const expected = [first, second].map(asset => ({ id: asset.id, name: asset.name, path: `${ASSET_INPUT_DIRECTORY}/${asset.id}/${asset.name}` }));
    expect(await materializeAssetInputs(worktree, [first, second])).toEqual(expected);
    expect(await materializeAssetInputs(worktree, [first, second])).toEqual(expected);
    expect(await readFile(join(worktree, expected[0].path), 'utf8')).toBe('# Report');
    expect(await readFile(join(worktree, expected[1].path), 'utf8')).toBe('# Another report');
    expect((await stat(join(worktree, expected[0].path))).mode & 0o222).toBe(0);
    expect((await readdir(worktree, { recursive: true })).some(path => path.includes('.pending-'))).toBe(false);
  });

  it('converges simultaneous staging without overwriting immutable content', async () => {
    const asset = input();
    await Promise.all([materializeAssetInputs(worktree, [asset]), materializeAssetInputs(worktree, [asset])]);
    expect(await readFile(join(worktree, ASSET_INPUT_DIRECTORY, asset.id, asset.name), 'utf8')).toBe('# Report');
  });

  it('rejects unsafe filenames and checksum mismatches before creating input files', async () => {
    for (const name of ['../outside', '/outside', 'nested/file', 'nested\\file', '.', '..', '', 'bad\nname', 'bad\u007fname', 'x'.repeat(256)]) {
      await expect(materializeAssetInputs(worktree, [input('asset-1', name)])).rejects.toThrow('filename');
    }
    await expect(materializeAssetInputs(worktree, [input('../outside')])).rejects.toThrow('filename');
    await expect(materializeAssetInputs(worktree, [{ ...input(), sha256: '0'.repeat(64) }])).rejects.toThrow('integrity');
    expect(await readdir(worktree)).toEqual([]);
  });

  it('does not overwrite a staged input whose bytes were modified', async () => {
    const asset = input();
    const [stored] = await materializeAssetInputs(worktree, [asset]);
    const file = join(worktree, stored.path);
    await chmod(file, 0o644);
    await writeFile(file, '# Edited');
    await expect(materializeAssetInputs(worktree, [asset])).rejects.toThrow('modified');
    expect(await readFile(file, 'utf8')).toBe('# Edited');
    expect((await readdir(dirname(file))).some(path => path.startsWith('.pending-'))).toBe(false);
  });

  it.each(['.muon-cache', ASSET_INPUT_DIRECTORY, `${ASSET_INPUT_DIRECTORY}/asset-1`])('rejects an escaping directory symlink at %s', async segment => {
    const outside = join(temporary, 'outside');
    await mkdir(outside);
    const destination = join(worktree, segment);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(outside, destination);
    await expect(materializeAssetInputs(worktree, [input()])).rejects.toThrow('symbolic links');
    expect(await readdir(outside)).toEqual([]);
  });

  it('does not read through or replace an existing file symlink', async () => {
    const outside = join(temporary, 'outside.md');
    await writeFile(outside, '# Report');
    const destination = join(worktree, ASSET_INPUT_DIRECTORY, 'asset-1', 'report.md');
    await mkdir(dirname(destination), { recursive: true });
    await symlink(outside, destination);
    await expect(materializeAssetInputs(worktree, [input()])).rejects.toThrow();
    expect(await realpath(destination)).toBe(await realpath(outside));
    expect(await readFile(outside, 'utf8')).toBe('# Report');
    expect((await readdir(dirname(destination))).some(path => path.startsWith('.pending-'))).toBe(false);
  });
});
