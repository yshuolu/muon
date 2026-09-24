import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ChangedFile, TaskWorkspace, WorkspaceProvider } from './contracts.js';
import { exportWorktreeChanges } from './local-worktree-export.js';
import { ASSET_INPUT_DIRECTORY, materializeAssetInputs } from './local-asset-inputs.js';

const exec = promisify(execFile);
type Manifest = TaskWorkspace & { repositoryPath: string; commonDirectory: string; taskId: string };

async function git(cwd: string, args: string[]): Promise<string> {
  const hooks = await mkdtemp(join(tmpdir(), 'muon-empty-git-hooks-'));
  try {
    const { stdout } = await exec('git', ['-c', `core.hooksPath=${hooks}`, '-C', cwd, ...args], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout;
  } finally { await rm(hooks, { recursive: true, force: true }); }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function gitCommonDirectory(path: string): Promise<string> {
  const directory = (await git(path, ['rev-parse', '--git-common-dir'])).trim();
  return realpath(resolve(path, directory));
}

function inside(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

export class LocalWorktreeProvider implements WorkspaceProvider {
  private readonly pending = new Map<string, Promise<TaskWorkspace>>();

  constructor(private readonly root: string) {
    if (!isAbsolute(root)) throw new Error('Worktree storage root must be an absolute path.');
  }

  async validateRepository(repositoryPath: string): Promise<void> {
    if (!isAbsolute(repositoryPath)) throw new Error('Repository path must be absolute.');
    const path = await realpath(repositoryPath);
    const top = await realpath((await git(path, ['rev-parse', '--show-toplevel'])).trim());
    if (top !== path) throw new Error('Select the Git repository root, not a subdirectory.');
    await git(path, ['rev-parse', '--verify', 'HEAD^{commit}']);
  }

  /**
   * Initializes Git in a folder that is not yet a repository root, then records its current contents as the
   * first commit so task worktrees start from what the owner sees today. Existing history is never rewritten.
   */
  async initializeRepository(repositoryPath: string): Promise<void> {
    if (!isAbsolute(repositoryPath)) throw new Error('Repository path must be absolute.');
    const path = await realpath(repositoryPath);
    if (!(await lstat(path)).isDirectory()) throw new Error('Choose a folder, not a file.');
    let top: string | undefined;
    try { top = await realpath((await git(path, ['rev-parse', '--show-toplevel'])).trim()); } catch { top = undefined; }
    if (top !== undefined && top !== path) throw new Error('This folder is inside another Git repository. Choose that repository root instead.');
    if (top === undefined) await git(path, ['init', '--quiet']);
    try { await git(path, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']); return; } catch { /* No commits yet. */ }
    const identity: string[] = [];
    for (const [key, fallback] of [['user.name', 'Muon'], ['user.email', 'muon@localhost']] as const) {
      const configured = await git(path, ['config', '--get', key]).catch(() => '');
      if (!configured.trim()) identity.push('-c', `${key}=${fallback}`);
    }
    await git(path, ['add', '--all']);
    await git(path, [...identity, 'commit', '--quiet', '--allow-empty', '--no-verify', '-m', 'Initial commit recorded by Muon']);
  }

  private async validateExport(input: TaskWorkspace): Promise<Manifest> {
    if (!/^[0-9a-f]{40,64}$/.test(input.baseCommit)) throw new Error('A verified base commit is required.');
    const root = await realpath(this.root);
    const path = await realpath(input.path);
    if (path !== input.path || !inside(root, path)) throw new Error('Dependency export must target a Muon-owned worktree.');
    const manifest = JSON.parse(await readFile(join(path, '..', 'workspace.json'), 'utf8')) as Manifest;
    if (manifest.path !== path || manifest.branch !== input.branch || manifest.baseCommit !== input.baseCommit || manifest.commonDirectory !== await gitCommonDirectory(path)) throw new Error('Dependency export does not match the saved task workspace.');
    if ((await git(path, ['symbolic-ref', '--short', 'HEAD'])).trim() !== manifest.branch) throw new Error('Dependency worktree branch changed outside Muon. Review it before integrating.');
    return manifest;
  }

  exportChanges(input: TaskWorkspace & { maxBytes?: number }) {
    return exportWorktreeChanges(input, { validate: () => this.validateExport(input), changedFiles: () => this.changedFiles(input) });
  }

  async materializeInputs(workspace: TaskWorkspace, inputs: Array<{ id: string; name: string; sha256: string; data: Uint8Array }>) {
    await this.validateExport(workspace);
    // A repository-owned file must never be silently replaced by a managed input.
    const tracked = await git(workspace.path, ['ls-files', '-z', '--', ASSET_INPUT_DIRECTORY]);
    if (tracked) throw new Error('The reserved input asset directory contains tracked files.');
    return materializeAssetInputs(workspace.path, inputs);
  }

  async ensure(input: { repositoryPath: string; taskId: string; baseRef?: string }): Promise<TaskWorkspace> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.taskId)) throw new Error('Invalid task ID for worktree.');
    if (!isAbsolute(input.repositoryPath)) throw new Error('Repository path must be absolute.');
    const repositoryPath = await realpath(input.repositoryPath);
    const top = await realpath((await git(repositoryPath, ['rev-parse', '--show-toplevel'])).trim());
    if (top !== repositoryPath) throw new Error('Select the Git repository root, not a subdirectory.');
    const commonDirectory = await gitCommonDirectory(repositoryPath);
    const key = `${commonDirectory}\0${input.taskId}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = this.ensureLocked({ ...input, repositoryPath }, commonDirectory);
    this.pending.set(key, promise);
    try { return await promise; } finally { this.pending.delete(key); }
  }

  private async ensureLocked(input: { repositoryPath: string; taskId: string; baseRef?: string }, commonDirectory: string): Promise<TaskWorkspace> {
    await mkdir(this.root, { recursive: true });
    const root = await realpath(this.root);
    const namespace = createHash('sha256').update(commonDirectory).digest('hex').slice(0, 16);
    const taskDirectory = join(root, namespace, input.taskId);
    await mkdir(taskDirectory, { recursive: true });
    if ((await realpath(taskDirectory)) !== taskDirectory) throw new Error('Worktree storage contains an unexpected symbolic link.');
    const lock = join(taskDirectory, 'creation.lock');
    try { await mkdir(lock); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('This worktree is being created. If Muon stopped unexpectedly, inspect its creation.lock before retrying.');
      throw error;
    }
    try {
      const path = join(taskDirectory, 'checkout');
      const branch = `muon/${input.taskId}`;
      const metadataPath = join(taskDirectory, 'workspace.json');
      let manifest: Manifest;
      if (await exists(metadataPath)) {
        manifest = JSON.parse(await readFile(metadataPath, 'utf8')) as Manifest;
        if (manifest.path !== path || manifest.branch !== branch || manifest.taskId !== input.taskId || manifest.commonDirectory !== commonDirectory || manifest.repositoryPath !== input.repositoryPath || !/^[0-9a-f]{40,64}$/.test(manifest.baseCommit)) {
          throw new Error('Saved worktree identity does not match this repository and task.');
        }
      } else {
        const baseRef = input.baseRef ?? 'HEAD';
        if (!baseRef || baseRef.startsWith('-') || /[\0\r\n]/.test(baseRef)) throw new Error('Invalid worktree base ref.');
        const baseCommit = (await git(input.repositoryPath, ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`])).trim();
        if ((await git(input.repositoryPath, ['branch', '--list', branch])).trim()) throw new Error(`Branch ${branch} already exists without Muon workspace metadata.`);
        if (await exists(path)) throw new Error('Refusing to replace an existing checkout without Muon workspace metadata.');
        manifest = { path, branch, baseCommit, repositoryPath: input.repositoryPath, commonDirectory, taskId: input.taskId };
        // Write the base first so a restart after worktree creation cannot lose its diff baseline.
        await writeFile(metadataPath, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
      }
      await git(input.repositoryPath, ['cat-file', '-e', `${manifest.baseCommit}^{commit}`]);
      if (!(await exists(path))) {
        const branchExists = (await git(input.repositoryPath, ['branch', '--list', branch])).trim().length > 0;
        await git(input.repositoryPath, branchExists
          ? ['worktree', 'add', path, branch]
          : ['worktree', 'add', '-b', branch, path, manifest.baseCommit]);
      }
      if ((await realpath(path)) !== path || await gitCommonDirectory(path) !== commonDirectory) throw new Error('Worktree no longer belongs to the expected repository.');
      if ((await git(path, ['symbolic-ref', '--short', 'HEAD'])).trim() !== branch) throw new Error('Worktree branch changed outside Muon; review it before continuing.');
      return { path, branch, baseCommit: manifest.baseCommit };
    } finally {
      await rm(lock, { recursive: true });
    }
  }

  async changedFiles(input: { path: string; baseCommit: string }): Promise<ChangedFile[]> {
    if (!/^[0-9a-f]{40,64}$/.test(input.baseCommit)) throw new Error('A verified base commit is required.');
    const root = await realpath(this.root);
    const path = await realpath(input.path);
    if (!inside(root, path)) throw new Error('Changed-file inspection must target a Muon-owned worktree.');
    const manifest = JSON.parse(await readFile(join(path, '..', 'workspace.json'), 'utf8')) as Manifest;
    if (manifest.path !== path || manifest.baseCommit !== input.baseCommit || manifest.commonDirectory !== await gitCommonDirectory(path)) throw new Error('Changed-file inspection does not match the saved task workspace.');
    const [statusOutput, statsOutput, untrackedOutput] = await Promise.all([
      git(path, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', input.baseCommit, '--']),
      git(path, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', input.baseCommit, '--']),
      git(path, ['ls-files', '--others', '--exclude-standard', '-z']),
    ]);
    const stats = new Map<string, { additions: number; deletions: number }>();
    for (const line of statsOutput.split('\0').filter(Boolean)) {
      const first = line.indexOf('\t');
      const second = line.indexOf('\t', first + 1);
      if (first < 0 || second < 0) continue;
      stats.set(line.slice(second + 1), { additions: Number(line.slice(0, first)) || 0, deletions: Number(line.slice(first + 1, second)) || 0 });
    }
    const changed: ChangedFile[] = [];
    const status = statusOutput.split('\0');
    for (let i = 0; i + 1 < status.length; i += 2) {
      const file = status[i + 1];
      if (file) changed.push({ path: file, status: status[i] ?? 'M', ...(stats.get(file) ?? { additions: 0, deletions: 0 }) });
    }
    for (const file of untrackedOutput.split('\0').filter(Boolean)) {
      if (file.startsWith(`${ASSET_INPUT_DIRECTORY}/`)) continue;
      const absolute = resolve(path, file);
      if (!inside(path, absolute)) throw new Error('Git returned a path outside the worktree.');
      let additions = 0;
      const info = await lstat(absolute);
      // Never follow an untracked symlink outside the worktree or load huge generated files.
      if (info.isFile() && info.size <= 16 * 1024 * 1024) {
        const content = await readFile(absolute);
        if (!content.includes(0)) {
          additions = content.length === 0 ? 0 : content.toString('utf8').split('\n').length - (content.at(-1) === 10 ? 1 : 0);
        }
      }
      changed.push({ path: file, status: 'A', additions, deletions: 0 });
    }
    return changed.sort((left, right) => left.path.localeCompare(right.path));
  }
}
