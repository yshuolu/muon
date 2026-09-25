import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Asset, Scope } from '../shared/types';
import { DomainError, type ArtifactStore, type AssetStorage, type Repository } from './ports';

export const MAX_ASSET_BYTES = 100 * 1024 * 1024;

const MEDIA_TYPES: Record<string, string> = {
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain', '.log': 'text/plain',
  '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

interface AssetServiceOptions {
  repository: Repository;
  storage: AssetStorage;
  legacyArtifacts?: ArtifactStore;
}

interface AssetProvenance {
  sourcePath?: string;
}

interface ImportFileInput extends AssetProvenance {
  workspacePath: string;
  relativePath: string;
  name?: string;
  origin?: 'generated' | 'imported';
}

function digest(data: Uint8Array) {
  return createHash('sha256').update(data).digest('hex');
}

function validName(name: string) {
  if (!name.trim() || name.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(name) || name === '.' || name === '..') {
    throw new DomainError('Asset names must be filenames of 1 to 255 characters, without paths or control characters.');
  }
  return name;
}

function mediaType(name: string, suggested?: string) {
  const known = MEDIA_TYPES[extname(name).toLowerCase()];
  if (known) return known;
  if (suggested && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(suggested)) return suggested.toLowerCase();
  return 'application/octet-stream';
}

/** Asset references never grant access. Future recipient grants extend this policy. */
export function canReadAsset(scope: Scope, asset: Asset) {
  return asset.workspaceId === scope.workspaceId && asset.projectId === scope.projectId &&
    (asset.ownerUserId === scope.userId || asset.visibility === 'project');
}

export class AssetService {
  constructor(private options: AssetServiceOptions) {}

  async get(scope: Scope, id: string) {
    const asset = await this.options.repository.asset(scope, id);
    return asset && canReadAsset(scope, asset) ? asset : undefined;
  }

  async list(scope: Scope, ids?: string[]) {
    if (!ids) return (await this.options.repository.assets(scope)).filter(asset => canReadAsset(scope, asset));
    const assets = await Promise.all([...new Set(ids)].map(id => this.get(scope, id)));
    return assets.filter((asset): asset is Asset => asset !== undefined);
  }

  async read(scope: Scope, id: string) {
    const asset = await this.get(scope, id);
    if (!asset) return undefined;
    if (asset.storageBackendId !== this.options.storage.backendId) {
      throw new DomainError('The storage backend for this asset is unavailable.', 503);
    }
    const data = await this.options.storage.read(scope, asset.objectKey);
    if (!data) return undefined;
    if (data.byteLength !== asset.sizeBytes || digest(data) !== asset.sha256) {
      throw new DomainError('The stored asset failed its integrity check.', 500);
    }
    return { asset, data };
  }

  async upload(scope: Scope, input: { name: string; mediaType?: string; data: Uint8Array; visibility?: Asset['visibility'] }) {
    return this.store(scope, { ...input, name: validName(input.name), mediaType: mediaType(input.name, input.mediaType), origin: 'upload' });
  }

  /** A reference note is an owner-written Markdown asset; revisions are new assets. */
  async createNote(scope: Scope, input: { name: string; content: string; origin?: 'upload' | 'generated' }) {
    const trimmed = input.name.trim();
    const name = validName(/\.(md|markdown)$/i.test(trimmed) ? trimmed : `${trimmed}.md`);
    if (!input.content.trim()) throw new DomainError('Write something in the note.');
    const data = Buffer.from(`${input.content.trim()}\n`, 'utf8');
    return this.store(scope, { name, mediaType: 'text/markdown', data, origin: input.origin ?? 'upload' });
  }

  async importFile(scope: Scope, input: ImportFileInput) {
    if (!input.relativePath || isAbsolute(input.relativePath) || input.relativePath.includes('\0')) {
      throw new DomainError('Asset paths must be relative to the task worktree.');
    }
    const base = await realpath(input.workspacePath);
    const source = await realpath(resolve(base, input.relativePath));
    const child = relative(base, source);
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new DomainError('Assets must be files inside the task worktree.');
    }
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    let data: Uint8Array;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_ASSET_BYTES) {
        throw new DomainError('Assets must be files no larger than 100 MiB.');
      }
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        // The file may grow after stat; read at most one byte beyond the limit.
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_ASSET_BYTES - total + 1));
        const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > MAX_ASSET_BYTES) throw new DomainError('Assets must be no larger than 100 MiB.', 413);
        chunks.push(chunk.subarray(0, bytesRead));
      }
      data = Buffer.concat(chunks, total);
    } finally {
      await handle.close();
    }
    return this.store(scope, {
      name: validName(input.name ?? basename(input.relativePath)),
      mediaType: mediaType(input.relativePath), data, origin: input.origin ?? 'generated',
      sourcePath: input.relativePath,
    });
  }

  async importLegacy(scope: Scope, url: string, provenance: AssetProvenance = {}) {
    const match = /^\/api\/artifacts\/([a-f0-9-]{36}\.[a-z0-9]+)$/.exec(url);
    if (!match || !this.options.legacyArtifacts) return undefined;
    const id = `legacy-${createHash('sha256').update(url).digest('hex')}`;
    const existing = await this.options.repository.asset(scope, id);
    if (existing) return canReadAsset(scope, existing) ? existing : undefined;
    const legacy = await this.options.legacyArtifacts.read(scope, match[1]);
    if (!legacy) return undefined;
    return this.store(scope, {
      id, name: match[1], mediaType: mediaType(match[1], legacy.mime), data: legacy.data, origin: 'imported', ...provenance,
    });
  }

  private async store(scope: Scope, input: AssetProvenance & {
    id?: string; name: string; mediaType?: string; data: Uint8Array; origin: Asset['origin']; visibility?: Asset['visibility'];
  }): Promise<Asset> {
    if (input.data.byteLength > MAX_ASSET_BYTES) throw new DomainError('Assets must be no larger than 100 MiB.', 413);
    if (input.visibility !== undefined && input.visibility !== 'private' && input.visibility !== 'project') {
      throw new DomainError('Asset visibility must be private or project.');
    }
    // Own the bytes across asynchronous storage calls, even if an upload buffer is reused by its caller.
    const data = Uint8Array.from(input.data);
    const id = input.id ?? randomUUID();
    const asset: Asset = {
      id, workspaceId: scope.workspaceId, projectId: scope.projectId, name: input.name,
      mediaType: input.mediaType ?? mediaType(input.name), sizeBytes: data.byteLength, sha256: digest(data),
      storageBackendId: this.options.storage.backendId, objectKey: id, origin: input.origin,
      createdAt: new Date().toISOString(), createdByUserId: scope.userId,
      ownerUserId: scope.userId, visibility: input.visibility ?? 'private',
      sourcePath: input.sourcePath,
    };
    await this.options.storage.write(scope, asset.objectKey, data);
    try {
      return await this.options.repository.insertAsset(scope, asset);
    } catch (error) {
      // Concurrent legacy backfills converge on the same immutable asset after storage publication.
      const existing = input.id ? await this.get(scope, id) : undefined;
      if (existing && existing.sha256 === asset.sha256 && existing.sizeBytes === asset.sizeBytes &&
          existing.storageBackendId === asset.storageBackendId && existing.objectKey === asset.objectKey) return existing;
      throw error;
    }
  }

}
