import { mkdir, open, readFile, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export async function acquireLocalInstance(dataRoot: string): Promise<() => Promise<void>> {
  await mkdir(dataRoot, { recursive: true });
  const path = join(dataRoot, 'server.lock');
  const claim = async () => {
      const file = await open(path, 'wx', 0o600);
      await file.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await file.close();
      return async () => {
        const owner = JSON.parse(await readFile(path, 'utf8')) as { pid: number };
        if (owner.pid === process.pid) await unlink(path);
      };
  };
  try { return await claim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const recovery = `${path}.recovery`;
    try { await mkdir(recovery); }
    catch { throw new Error('Another Muon instance is starting or inspecting its previous lock.'); }
    try {
      let pid: number;
      try { pid = (JSON.parse(await readFile(path, 'utf8')) as { pid: number }).pid; }
      catch { throw new Error(`Another Muon instance is starting, or ${path} needs inspection.`); }
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid Muon instance lock: ${path}`);
      try { process.kill(pid, 0); }
      catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') {
          await unlink(path);
          return await claim();
        }
        throw probeError;
      }
      throw new Error(`Muon is already running for this data directory (process ${pid}).`);
    } finally { await rmdir(recovery); }
  }
}
