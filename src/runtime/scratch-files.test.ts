import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeScratchFiles } from './scratch-files.js';

let scratch: string;
beforeEach(async () => { scratch = await mkdtemp(join(tmpdir(), 'muon-scratch-files-')); });
afterEach(async () => { await rm(scratch, { recursive: true, force: true }); });

describe('writeScratchFiles', () => {
  it('writes files under nested relative paths', async () => {
    await writeScratchFiles(scratch, [{ path: 'library/notes.md', data: new TextEncoder().encode('# Notes') }, { path: 'plain.txt', data: new TextEncoder().encode('x') }]);
    expect(await readFile(join(scratch, 'library', 'notes.md'), 'utf8')).toBe('# Notes');
    expect(await readFile(join(scratch, 'plain.txt'), 'utf8')).toBe('x');
  });

  it('refuses paths that leave the scratch directory or overwrite a copy', async () => {
    const data = new Uint8Array([1]);
    for (const path of ['../escape.md', '/tmp/absolute.md', 'library/../../up.md', '..', '']) {
      await expect(writeScratchFiles(scratch, [{ path, data }])).rejects.toThrow();
    }
    await writeScratchFiles(scratch, [{ path: 'same.md', data }]);
    await expect(writeScratchFiles(scratch, [{ path: 'same.md', data }])).rejects.toThrow();
  });
});
