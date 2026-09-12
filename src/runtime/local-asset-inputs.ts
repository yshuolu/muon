import { constants } from 'node:fs';
import { link, mkdir, open, realpath, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const ASSET_INPUT_DIRECTORY = '.muon-cache/inputs';

/** Stage separate immutable copies; providers never receive the storage root or a sibling checkout. */
export async function materializeAssetInputs(workspacePath: string, inputs: Array<{ id: string; name: string; sha256: string; data: Uint8Array }>) {
  const base = await realpath(workspacePath);
  const result: Array<{ id: string; name: string; path: string }> = [];
  for (const original of inputs) {
    if (original.data.byteLength > 100 * 1024 * 1024) throw new Error('Input asset failed its integrity check.');
    const input = { ...original, data: Uint8Array.from(original.data) };
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(input.id) || !input.name || input.name.length > 255 || /[/\\\u0000-\u001f\u007f]/.test(input.name) || ['.', '..'].includes(input.name)) throw new Error('Invalid input asset filename.');
    if (input.data.byteLength > 100 * 1024 * 1024 || createHash('sha256').update(input.data).digest('hex') !== input.sha256) throw new Error('Input asset failed its integrity check.');
    let directory = base;
    for (const segment of ['.muon-cache', 'inputs', input.id]) {
      directory = join(directory, segment);
      try { await mkdir(directory); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (await realpath(directory) !== directory) throw new Error('Input asset directory cannot contain symbolic links.');
    }
    const destination = join(directory, input.name);
    const temporary = join(directory, `.pending-${randomUUID()}`);
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444);
      try { await handle.writeFile(input.data); } finally { await handle.close(); }
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await existing.stat();
          if (!info.isFile() || info.size !== input.data.byteLength) throw new Error('The managed input copy was modified. Inspect it before retrying.');
          const bytes = await existing.readFile();
          if (createHash('sha256').update(bytes).digest('hex') !== input.sha256) throw new Error('The managed input copy was modified. Inspect it before retrying.');
        } finally { await existing.close(); }
      }
    } finally {
      await rm(temporary, { force: true });
    }
    result.push({ id: input.id, name: input.name, path: `${ASSET_INPUT_DIRECTORY}/${input.id}/${input.name}` });
  }
  return result;
}
