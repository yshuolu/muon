import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import type { ScratchFile } from './contracts.js';

/**
 * Copies request files into an advisory session's scratch directory. Paths are relative and may not escape the
 * directory; the copies are plain files the agent reads with its own tools, never inputs it can modify in place.
 */
export async function writeScratchFiles(scratch: string, files: ScratchFile[] = []): Promise<void> {
  for (const file of files) {
    const relative = normalize(file.path);
    if (!relative || isAbsolute(relative) || relative === '..' || relative.startsWith(`..${sep}`) || relative.includes(`${sep}..${sep}`) || relative.endsWith(`${sep}..`)) {
      throw new Error(`Scratch file path must stay inside the scratch directory: ${file.path}`);
    }
    const target = join(scratch, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.data, { flag: 'wx' });
  }
}
