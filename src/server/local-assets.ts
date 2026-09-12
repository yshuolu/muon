import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Scope } from '../shared/types';
import { DomainError, type AssetStorage } from './ports';

/** Local object storage knows scoped keys and bytes, never agent worktree paths. */
export class LocalAssetStorage implements AssetStorage {
  constructor(private root: string, readonly backendId = 'local') {}

  private validateKey(objectKey: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(objectKey)) {
      throw new DomainError('Invalid asset storage key.');
    }
  }

  private async directory(scope: Scope, create: boolean) {
    if (create) await mkdir(this.root, { recursive: true });
    let directory = await realpath(this.root);
    for (const id of [scope.workspaceId, scope.projectId]) {
      if (!id) throw new DomainError('Asset storage requires a workspace and project.');
      directory = resolve(directory, Buffer.from(id).toString('base64url'));
      if (create) await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new DomainError('Asset directories must remain inside managed storage.');
      }
    }
    return directory;
  }

  async write(scope: Scope, objectKey: string, data: Uint8Array) {
    this.validateKey(objectKey);
    const directory = await this.directory(scope, true);
    const temporary = resolve(directory, `pending-${randomUUID()}`);
    try {
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Linking publishes a complete file atomically and cannot overwrite an existing key.
      try {
        await link(temporary, resolve(directory, objectKey));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await this.read(scope, objectKey);
        if (!existing || !Buffer.from(existing).equals(Buffer.from(data))) {
          throw new DomainError('Asset content is immutable; create a new asset for changed bytes.', 409);
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async read(scope: Scope, objectKey: string): Promise<Uint8Array | undefined> {
    this.validateKey(objectKey);
    try {
      const directory = await this.directory(scope, false);
      const handle = await open(resolve(directory, objectKey), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await handle.stat()).isFile()) return undefined;
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (error instanceof DomainError || code === 'ENOENT' || code === 'ELOOP') return undefined;
      throw error;
    }
  }
}
