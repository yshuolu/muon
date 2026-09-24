import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalWorktreeProvider } from './local-worktree-provider.js';

const exec = promisify(execFile);
let directory: string;
let repository: string;
let root: string;
const git = async (path: string, ...args: string[]) => (await exec('git', ['-C', path, ...args])).stdout.trim();

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'muon-worktree-')));
  repository = join(directory, 'repository');
  root = join(directory, 'worktrees');
  await mkdir(repository);
  await git(repository, 'init');
  await git(repository, 'config', 'user.name', 'Muon Test');
  await git(repository, 'config', 'user.email', 'test@localhost');
  await git(repository, 'config', 'core.hooksPath', join(directory, 'empty-hooks'));
  await writeFile(join(repository, 'source.txt'), 'original\n');
  await git(repository, 'add', '.');
  await git(repository, 'commit', '-m', 'Initial');
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('LocalWorktreeProvider', () => {
  it('reuses one isolated worktree and retains its original base across restarts', async () => {
    const provider = new LocalWorktreeProvider(root);
    const [first, parallel] = await Promise.all([
      provider.ensure({ repositoryPath: repository, taskId: 'task-1' }),
      provider.ensure({ repositoryPath: repository, taskId: 'task-1' }),
    ]);
    expect(first).toEqual(parallel);
    await writeFile(join(first.path, 'source.txt'), 'changed\n');
    const second = await new LocalWorktreeProvider(root).ensure({ repositoryPath: repository, taskId: 'task-1' });
    expect(second).toEqual(first);
    expect(await readFile(join(repository, 'source.txt'), 'utf8')).toBe('original\n');
    expect(await readFile(join(second.path, 'source.txt'), 'utf8')).toBe('changed\n');
    expect(await git(first.path, 'branch', '--show-current')).toBe('muon/task-1');
  });

  it('includes committed, staged, unstaged and untracked changes from the original base', async () => {
    const provider = new LocalWorktreeProvider(root);
    const workspace = await provider.ensure({ repositoryPath: repository, taskId: 'task-diff' });
    await writeFile(join(workspace.path, 'source.txt'), 'changed\nsecond\n');
    await git(workspace.path, 'add', 'source.txt');
    await git(workspace.path, 'commit', '-m', 'Agent commit');
    await writeFile(join(workspace.path, 'staged.txt'), 'staged\n');
    await git(workspace.path, 'add', 'staged.txt');
    await writeFile(join(workspace.path, 'source.txt'), 'changed\nsecond\nthird\n');
    await writeFile(join(workspace.path, 'untracked\tfile.txt'), 'one\ntwo');
    const files = await provider.changedFiles(workspace);
    expect(files).toEqual(expect.arrayContaining([
      { path: 'source.txt', status: 'M', additions: 3, deletions: 1 },
      { path: 'staged.txt', status: 'A', additions: 1, deletions: 0 },
      { path: 'untracked\tfile.txt', status: 'A', additions: 2, deletions: 0 },
    ]));
  });

  it('does not follow untracked symlinks or miscount binary files', async () => {
    const provider = new LocalWorktreeProvider(root);
    const workspace = await provider.ensure({ repositoryPath: repository, taskId: 'task-links' });
    await symlink(join(repository, 'source.txt'), join(workspace.path, 'link.txt'));
    await writeFile(join(workspace.path, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    expect(await provider.changedFiles(workspace)).toEqual([
      { path: 'binary.bin', status: 'A', additions: 0, deletions: 0 },
      { path: 'link.txt', status: 'A', additions: 0, deletions: 0 },
    ]);
  });

  it('rejects traversal, non-root repository paths and foreign changed-file paths', async () => {
    const provider = new LocalWorktreeProvider(root);
    await expect(provider.ensure({ repositoryPath: repository, taskId: '../escape' })).rejects.toThrow('Invalid task ID');
    await mkdir(join(repository, 'child'));
    await expect(provider.ensure({ repositoryPath: join(repository, 'child'), taskId: 'valid' })).rejects.toThrow('repository root');
    const workspace = await provider.ensure({ repositoryPath: repository, taskId: 'valid' });
    await expect(provider.changedFiles({ path: repository, baseCommit: workspace.baseCommit })).rejects.toThrow('Muon-owned');
    await expect(provider.changedFiles({ path: workspace.path, baseCommit: '--help' })).rejects.toThrow('verified base commit');
  });

  it('refuses branches not created by Muon and preserves existing work', async () => {
    await git(repository, 'branch', 'muon/conflict');
    const provider = new LocalWorktreeProvider(root);
    await expect(provider.ensure({ repositoryPath: repository, taskId: 'conflict' })).rejects.toThrow('already exists');
    expect(await readFile(join(repository, 'source.txt'), 'utf8')).toBe('original\n');
  });

  it('exports an applicable byte-exact snapshot without changing the source index or files', async () => {
    await writeFile(join(repository, 'deleted.txt'), 'remove me\n');
    await git(repository, 'add', '.');
    await git(repository, 'commit', '-m', 'Add deletion fixture');
    const provider = new LocalWorktreeProvider(root);
    const source = await provider.ensure({ repositoryPath: repository, taskId: 'source' });
    const destination = await provider.ensure({ repositoryPath: repository, taskId: 'destination' });
    await writeFile(join(source.path, 'source.txt'), 'staged\n');
    await git(source.path, 'add', 'source.txt');
    await writeFile(join(source.path, 'source.txt'), 'actual unstaged result\n');
    await writeFile(join(source.path, 'new file\t.mjs'), 'export const answer = 42; // ✓\n');
    await writeFile(join(source.path, 'binary.bin'), Buffer.from([0, 255, 42, 1, 0, 128]));
    await writeFile(join(source.path, 'legacy.txt'), Buffer.from([255, 254, 65, 10]));
    await writeFile(join(source.path, 'executable.sh'), '#!/bin/sh\nexit 0\n');
    await chmod(join(source.path, 'executable.sh'), 0o755);
    await rm(join(source.path, 'deleted.txt'));
    const indexPath = await git(source.path, 'rev-parse', '--git-path', 'index');
    const originalIndex = await readFile(indexPath);
    const changes = await provider.exportChanges(source);
    expect(await readFile(indexPath)).toEqual(originalIndex);
    expect(changes.files.map(file => file.path)).toEqual(['binary.bin', 'deleted.txt', 'executable.sh', 'legacy.txt', 'new file\t.mjs', 'source.txt']);
    expect(changes.sha256).toMatch(/^[a-f0-9]{64}$/);
    const patchBytes = Buffer.from(changes.patch, changes.patchEncoding);
    expect(patchBytes.toString()).toContain('GIT binary patch');
    const patchPath = join(directory, 'dependency.patch');
    await writeFile(patchPath, patchBytes);
    await git(destination.path, 'apply', '--binary', patchPath);
    for (const name of ['source.txt', 'new file\t.mjs', 'binary.bin', 'legacy.txt', 'executable.sh']) expect(await readFile(join(destination.path, name))).toEqual(await readFile(join(source.path, name)));
    await expect(readFile(join(destination.path, 'deleted.txt'))).rejects.toThrow();
    expect(await readFile(join(repository, 'source.txt'), 'utf8')).toBe('original\n');
    expect(await provider.exportChanges(source)).toEqual(changes);
  });

  it('preserves a symlink as a link without exporting its external target content', async () => {
    const provider = new LocalWorktreeProvider(root);
    const source = await provider.ensure({ repositoryPath: repository, taskId: 'link-source' });
    const outside = join(directory, 'private.txt');
    await writeFile(outside, 'Do not export this target content.');
    await symlink(outside, join(source.path, 'external-link'));
    const changes = await provider.exportChanges(source);
    expect(changes.patch).toContain('new file mode 120000');
    expect(changes.patch).not.toContain('Do not export this target content.');
  });

  it('rejects oversized exports and foreign or changed worktree identities', async () => {
    const provider = new LocalWorktreeProvider(root);
    const source = await provider.ensure({ repositoryPath: repository, taskId: 'bounded-source' });
    await writeFile(join(source.path, 'source.txt'), 'replacement content\n');
    await expect(provider.exportChanges({ ...source, maxBytes: 64 })).rejects.toThrow(/exceeds.*no partial patch/);
    await expect(provider.exportChanges({ ...source, path: repository })).rejects.toThrow('Muon-owned');
    await expect(provider.exportChanges({ ...source, branch: 'wrong' })).rejects.toThrow('saved task workspace');
    await git(source.path, 'checkout', '-b', 'external-branch');
    await expect(provider.exportChanges(source)).rejects.toThrow('branch changed outside Muon');
    expect(await readFile(join(source.path, 'source.txt'), 'utf8')).toBe('replacement content\n');
  });

  it('validates an actual Git root with a committed base before configuration', async () => {
    const provider = new LocalWorktreeProvider(root);
    await expect(provider.validateRepository(repository)).resolves.toBeUndefined();
    await mkdir(join(repository, 'child'));
    await expect(provider.validateRepository(join(repository, 'child'))).rejects.toThrow('repository root');
    const empty = join(directory, 'empty');
    await mkdir(empty);
    await git(empty, 'init');
    await expect(provider.validateRepository(empty)).rejects.toThrow();
    await expect(provider.validateRepository(directory)).rejects.toThrow();
  });

  it('rejects a source that changes while its dependency snapshot is being exported', async () => {
    const provider = new LocalWorktreeProvider(root);
    const source = await provider.ensure({ repositoryPath: repository, taskId: 'racing-source' });
    await writeFile(join(source.path, 'source.txt'), 'first result\n');
    const original = provider.changedFiles.bind(provider);
    let reads = 0;
    vi.spyOn(provider, 'changedFiles').mockImplementation(async input => {
      reads += 1;
      if (reads === 2) await writeFile(join(source.path, 'source.txt'), 'external change\n');
      return original(input);
    });
    await expect(provider.exportChanges(source)).rejects.toThrow('changed while preparing');
    expect(await readFile(join(source.path, 'source.txt'), 'utf8')).toBe('external change\n');
  });

  it('never executes configured checkout hooks while preparing a task for RFC review', async () => {
    const hooks = join(directory, 'configured-hooks');
    await mkdir(hooks);
    await writeFile(join(hooks, 'post-checkout'), '#!/bin/sh\necho hook-ran > "$PWD/approval-bypass-marker"\n', { mode: 0o755 });
    await git(repository, 'config', 'core.hooksPath', hooks);
    const provider = new LocalWorktreeProvider(root);
    const source = await provider.ensure({ repositoryPath: repository, taskId: 'hook-safe' });
    await expect(readFile(join(source.path, 'approval-bypass-marker'))).rejects.toThrow();
    await expect(readFile(join(repository, 'approval-bypass-marker'))).rejects.toThrow();
    expect(await provider.changedFiles(source)).toEqual([]);
    expect(await git(repository, 'config', 'core.hooksPath')).toBe(hooks);
  });

  it('rejects oversized source files before loading their contents', async () => {
    const provider = new LocalWorktreeProvider(root);
    const source = await provider.ensure({ repositoryPath: repository, taskId: 'large-source' });
    const large = join(source.path, 'oversized.bin');
    await writeFile(large, '');
    await truncate(large, 33 * 1024 * 1024);
    await expect(provider.exportChanges(source)).rejects.toThrow('32 MiB export bound');
  });
});

describe('LocalWorktreeProvider.initializeRepository', () => {
  it('turns a plain folder into a repository with the current files committed, and keeps existing history', async () => {
    const provider = new LocalWorktreeProvider(root);
    const plain = join(directory, 'plain');
    await mkdir(join(plain, 'src'), { recursive: true });
    await writeFile(join(plain, 'src', 'index.ts'), 'export const ok = true;\n');
    await expect(provider.validateRepository(plain)).rejects.toThrow();
    await provider.initializeRepository(plain);
    await expect(provider.validateRepository(plain)).resolves.toBeUndefined();
    expect(await git(plain, 'log', '--format=%s')).toBe('Initial commit recorded by Muon');
    expect(await git(plain, 'ls-files')).toBe('src/index.ts');
    expect(await git(plain, 'status', '--porcelain')).toBe('');
    const workspace = await provider.ensure({ repositoryPath: plain, taskId: 'plain-task' });
    expect(await readFile(join(workspace.path, 'src', 'index.ts'), 'utf8')).toBe('export const ok = true;\n');
    await provider.initializeRepository(plain);
    expect(await git(plain, 'rev-list', '--count', 'HEAD')).toBe('1');
    await provider.initializeRepository(repository);
    expect(await git(repository, 'log', '--format=%s')).toBe('Initial');
  });

  it('commits an empty repository and rejects folders nested inside another repository', async () => {
    const provider = new LocalWorktreeProvider(root);
    const empty = join(directory, 'empty');
    await mkdir(empty);
    await git(empty, 'init');
    await git(empty, 'config', 'user.name', 'Muon Test');
    await git(empty, 'config', 'user.email', 'test@localhost');
    await provider.initializeRepository(empty);
    expect(await git(empty, 'rev-list', '--count', 'HEAD')).toBe('1');
    await mkdir(join(repository, 'nested'));
    await expect(provider.initializeRepository(join(repository, 'nested'))).rejects.toThrow('inside another Git repository');
    await expect(provider.initializeRepository(join(repository, 'source.txt'))).rejects.toThrow('folder');
    await expect(provider.initializeRepository('relative')).rejects.toThrow('absolute');
  });
});
