import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Scope } from '../shared/types';
import { DomainError, type ArtifactStore } from './ports';

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/plain', '.csv': 'text/plain', '.json': 'application/json' };
export class LocalArtifactStore implements ArtifactStore {
  constructor(private root: string) {}
  private directory(scope: Scope) { return resolve(this.root, Buffer.from(scope.workspaceId).toString('base64url'), Buffer.from(scope.projectId).toString('base64url')); }
  private async safeDirectory(scope: Scope, create: boolean) {
    if (create) await mkdir(this.directory(scope), { recursive: true });
    const root = await realpath(this.root);
    const directory = await realpath(this.directory(scope));
    const child = relative(root, directory);
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new DomainError('Artifact directory must remain inside storage.');
    return directory;
  }
  async importFile(scope: Scope, _taskId: string, workspacePath: string, relativePath: string) {
    if (isAbsolute(relativePath)) throw new DomainError('Evidence paths must be relative to the task worktree.');
    const base = await realpath(workspacePath);
    const source = await realpath(resolve(base, relativePath));
    const child = relative(base, source);
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new DomainError('Evidence must be inside the task worktree.');
    const extension = extname(source).toLowerCase();
    if (!MIME[extension]) throw new DomainError('Unsupported evidence file type.');
    const info = await stat(source);
    if (!info.isFile() || info.size > 100 * 1024 * 1024) throw new DomainError('Evidence must be a file under 100 MB.');
    const id = `${randomUUID()}${extension}`;
    const directory = await this.safeDirectory(scope, true);
    await writeFile(resolve(directory, id), await readFile(source), { flag: 'wx' });
    return `/api/artifacts/${id}`;
  }
  async read(scope: Scope, id: string) {
    if (!/^[a-f0-9-]{36}\.[a-z0-9]+$/.test(id) || !MIME[extname(id)]) return undefined;
    try {
      const directory = await this.safeDirectory(scope, false);
      const file = await realpath(resolve(directory, id));
      if (relative(directory, file) !== id) return undefined;
      return { data: await readFile(file), mime: MIME[extname(id)] };
    }
    catch (error) { if (error instanceof DomainError || (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
}
