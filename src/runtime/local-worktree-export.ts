import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ChangedFile, TaskWorkspace, WorkspaceChanges } from './contracts.js';

const exec = promisify(execFile);
export const MAX_DEPENDENCY_PATCH_BYTES = 256 * 1024;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

type SnapshotFile = { file: ChangedFile; mode: string; content: Buffer };
type Snapshot = { files: SnapshotFile[]; headCommit: string; sha256: string };

export async function exportWorktreeChanges(input: TaskWorkspace & { maxBytes?: number }, operations: {
  validate: () => Promise<{ commonDirectory: string }>;
  changedFiles: () => Promise<ChangedFile[]>;
}): Promise<WorkspaceChanges> {
  const maxBytes = input.maxBytes ?? MAX_DEPENDENCY_PATCH_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_DEPENDENCY_PATCH_BYTES) throw new Error('Dependency patch limit must be between 1 byte and 256 KiB.');
  const manifest = await operations.validate();
  const directory = await mkdtemp(join(tmpdir(), 'muon-dependency-export-'));
  const objects = join(directory, 'objects');
  await mkdir(objects);
  const hooks = join(directory, 'empty-hooks');
  await mkdir(hooks);
  const environment = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_INDEX_FILE: join(directory, 'index'), GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(manifest.commonDirectory, 'objects') };
  const git = async (args: string[], outputLimit = 64 * 1024) => (await exec('git', ['-c', `core.hooksPath=${hooks}`, '-C', input.path, ...args], { env: environment, timeout: 30_000, windowsHide: true, maxBuffer: outputLimit, encoding: 'utf8' })).stdout;
  const capture = async (): Promise<Snapshot> => {
    await operations.validate();
    const headCommit = (await git(['rev-parse', '--verify', 'HEAD'])).trim();
    const changed = await operations.changedFiles();
    if (changed.length > 512) throw new Error('Dependency has more than 512 changed files. Split the task before integrating it.');
    const hash = createHash('sha256').update(input.baseCommit).update(headCommit);
    const files: SnapshotFile[] = [];
    let totalBytes = 0;
    for (const file of changed) {
      const absolute = resolve(input.path, file.path);
      const relativePath = relative(input.path, absolute);
      if (!relativePath || isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) throw new Error('Dependency file escapes its worktree.');
      let mode = '0'; let content = Buffer.alloc(0);
      if (file.status !== 'D') {
        const parent = await realpath(dirname(absolute));
        const parentRelative = relative(input.path, parent);
        if (isAbsolute(parentRelative) || parentRelative === '..' || parentRelative.startsWith(`..${sep}`)) throw new Error('Dependency file parent escapes its worktree.');
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) {
          mode = '120000'; content = Buffer.from(await readlink(absolute));
        } else if (info.isFile()) {
          if (info.size + totalBytes > MAX_SOURCE_BYTES) throw new Error('Dependency source exceeds the 32 MiB export bound. Split the task before integrating it.');
          mode = info.mode & 0o111 ? '100755' : '100644';
          const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.size + totalBytes > MAX_SOURCE_BYTES) throw new Error('Dependency file changed while preparing its export. Retry after its worktree is stable.');
            const bytes = Buffer.alloc(opened.size + 1);
            let offset = 0;
            while (offset < bytes.length) {
              const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
              if (!bytesRead) break;
              offset += bytesRead;
            }
            if (offset !== opened.size) throw new Error('Dependency file changed while preparing its export. Retry after its worktree is stable.');
            content = bytes.subarray(0, offset);
          } finally { await handle.close(); }
        } else throw new Error(`Cannot export dependency path ${file.path}: directories, submodules, and special files require explicit integration.`);
      }
      totalBytes += content.length;
      if (totalBytes > MAX_SOURCE_BYTES) throw new Error('Dependency source exceeds the 32 MiB export bound. Split the task before integrating it.');
      hash.update(JSON.stringify([file.path, file.status, mode, content.length])).update(content);
      files.push({ file, mode, content });
    }
    return { files, headCommit, sha256: hash.digest('hex') };
  };
  try {
    const before = await capture();
    await git(['read-tree', input.baseCommit]);
    for (const [index, item] of before.files.entries()) {
      if (item.file.status === 'D') await git(['update-index', '--force-remove', '--', item.file.path]);
      else {
        const blobPath = join(directory, `blob-${index}`);
        await writeFile(blobPath, item.content);
        const objectId = (await git(['hash-object', '--no-filters', '-w', '--', blobPath])).trim();
        await git(['update-index', '--add', '--cacheinfo', item.mode, objectId, item.file.path]);
      }
    }
    const tree = (await git(['write-tree'])).trim();
    let patchBytes: Buffer;
    try {
      patchBytes = (await exec('git', ['-c', `core.hooksPath=${hooks}`, '-C', input.path, 'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', input.baseCommit, tree, '--'], { env: environment, timeout: 30_000, windowsHide: true, maxBuffer: maxBytes, encoding: 'buffer' })).stdout;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error(`Dependency patch exceeds ${maxBytes} bytes. Split the task or arrange an explicit integration; no partial patch was supplied.`);
      throw error;
    }
    if (patchBytes.length > maxBytes) throw new Error(`Dependency patch exceeds ${maxBytes} bytes; no partial patch was supplied.`);
    const after = await capture();
    if (after.sha256 !== before.sha256) throw new Error('Dependency worktree changed while preparing its export. Retry after its worktree is stable.');
    const patchEncoding = patchBytes.equals(Buffer.from(patchBytes.toString('utf8'))) ? 'utf8' : 'base64';
    return { format: 'git-patch', baseCommit: input.baseCommit, headCommit: before.headCommit, sha256: createHash('sha256').update(patchBytes).digest('hex'), patchEncoding, patch: patchBytes.toString(patchEncoding), files: before.files.map(item => item.file) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
