import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLocalInstance } from './local-instance-lock';

let dataRoot: string;
const releases: Array<() => Promise<void>> = [];
beforeEach(async () => { dataRoot = await mkdtemp(join(tmpdir(), 'muon-instance-')); });
afterEach(async () => {
  for (const release of releases.splice(0)) await release();
  await rm(dataRoot, { recursive: true, force: true });
});

describe('acquireLocalInstance', () => {
  it('rejects a second instance for the same data directory and allows reacquisition after release', async () => {
    const release = await acquireLocalInstance(dataRoot);
    releases.push(release);
    await expect(acquireLocalInstance(dataRoot)).rejects.toThrow('already running');
    expect(JSON.parse(await readFile(join(dataRoot, 'server.lock'), 'utf8')).pid).toBe(process.pid);
    releases.pop();
    await release();
    const reacquired = await acquireLocalInstance(dataRoot);
    releases.push(reacquired);
    expect(JSON.parse(await readFile(join(dataRoot, 'server.lock'), 'utf8')).pid).toBe(process.pid);
  });

  it('recovers a stale lock whose process no longer exists', async () => {
    // Signal zero only probes existence and never terminates the process.
    const nonexistentPid = 2_147_483_647;
    let missing = false;
    try { process.kill(nonexistentPid, 0); }
    catch (error) { missing = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    expect(missing).toBe(true);
    await writeFile(join(dataRoot, 'server.lock'), JSON.stringify({ pid: nonexistentPid, startedAt: '2000-01-01T00:00:00.000Z' }));
    const release = await acquireLocalInstance(dataRoot);
    releases.push(release);
    expect(JSON.parse(await readFile(join(dataRoot, 'server.lock'), 'utf8')).pid).toBe(process.pid);
  });

  it('allows independent instances using different data directories', async () => {
    const releaseFirst = await acquireLocalInstance(dataRoot);
    releases.push(releaseFirst);
    const releaseSecond = await acquireLocalInstance(join(dataRoot, 'other-instance'));
    releases.push(releaseSecond);
    expect(JSON.parse(await readFile(join(dataRoot, 'other-instance', 'server.lock'), 'utf8')).pid).toBe(process.pid);
  });

  it('allows only one contender to recover a stale lock', async () => {
    await writeFile(join(dataRoot, 'server.lock'), JSON.stringify({ pid: 2_147_483_647 }));
    const contenders = await Promise.allSettled([acquireLocalInstance(dataRoot), acquireLocalInstance(dataRoot)]);
    const winners = contenders.filter(result => result.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    releases.push(winners[0].value);
  });

  it('preserves an unreadable or invalid lock for inspection', async () => {
    const path = join(dataRoot, 'server.lock');
    await writeFile(path, '{partial');
    await expect(acquireLocalInstance(dataRoot)).rejects.toThrow('needs inspection');
    expect(await readFile(path, 'utf8')).toBe('{partial');
    await writeFile(path, JSON.stringify({ pid: -1 }));
    await expect(acquireLocalInstance(dataRoot)).rejects.toThrow('Invalid');
    expect(JSON.parse(await readFile(path, 'utf8')).pid).toBe(-1);
  });
});
