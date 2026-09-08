import { mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scope } from '../shared/domain';
import { LocalArtifactStore } from './local-artifacts';
import { DomainError } from './ports';

const scope: Scope = { workspaceId: 'workspace-a', projectId: 'project-a', userId: 'owner-a' };
let temporary: string;
let workspace: string;
let storage: string;
let store: LocalArtifactStore;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'muon-artifacts-'));
  workspace = join(temporary, 'worktree');
  storage = join(temporary, 'artifacts');
  await mkdir(workspace);
  store = new LocalArtifactStore(storage);
});
afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });

function artifactId(url: string) { return url.split('/').at(-1)!; }

describe('LocalArtifactStore', () => {
  it.each([['log', 'text/plain'], ['md', 'text/plain'], ['csv', 'text/plain'], ['json', 'application/json']])('retains %s verification output as inert evidence', async (extension, mime) => {
    const content = 'Actual test output with an error and observed results.\n<script>not executed</script>';
    const source = `verification.${extension}`;
    await writeFile(join(workspace, source), content);
    const url = await store.importFile(scope, 'task-1', workspace, source);
    await rm(join(workspace, source));
    const saved = await store.read(scope, artifactId(url));
    expect(saved?.mime).toBe(mime);
    expect(Buffer.from(saved!.data).toString()).toBe(content);
  });

  it('imports supported evidence as a durable copy with its MIME type', async () => {
    await mkdir(join(workspace, 'evidence'));
    const source = join(workspace, 'evidence', 'result.PNG');
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(source, bytes);
    const url = await store.importFile(scope, 'task-1', workspace, 'evidence/result.PNG');
    expect(url).toMatch(/^\/api\/artifacts\/[a-f0-9-]{36}\.png$/);
    await writeFile(source, 'changed after import');
    const artifact = await store.read(scope, artifactId(url));
    expect(artifact?.mime).toBe('image/png');
    expect(Buffer.from(artifact!.data)).toEqual(bytes);
    expect(Buffer.from((await new LocalArtifactStore(storage).read(scope, artifactId(url)))!.data)).toEqual(bytes);
  });

  it('isolates imported artifacts across both workspace and project', async () => {
    await writeFile(join(workspace, 'steps.txt'), 'Actual verification steps');
    const id = artifactId(await store.importFile(scope, 'task-1', workspace, 'steps.txt'));
    expect(await store.read({ ...scope, projectId: 'other-project' }, id)).toBeUndefined();
    expect(await store.read({ ...scope, workspaceId: 'other-workspace' }, id)).toBeUndefined();
    expect((await store.read(scope, id))?.mime).toBe('text/plain');
  });

  it.each(['workspaceId', 'projectId'] as const)('keeps path-like %s values within managed storage', async key => {
    await writeFile(join(workspace, 'steps.txt'), 'Actual verification steps');
    const scoped = { ...scope, [key]: '..' };
    const id = artifactId(await store.importFile(scoped, 'task-1', workspace, 'steps.txt'));
    const savedFiles = await readdir(storage, { recursive: true });
    expect(savedFiles.some(filename => filename.endsWith(id))).toBe(true);
    expect(Buffer.from((await store.read(scoped, id))!.data).toString()).toBe('Actual verification steps');
    expect(await store.read(scope, id)).toBeUndefined();
  });

  it('rejects absolute paths and relative traversal outside the worktree', async () => {
    const outside = join(temporary, 'outside.txt');
    await writeFile(outside, 'Private outside content');
    await expect(store.importFile(scope, 'task-1', workspace, outside)).rejects.toBeInstanceOf(DomainError);
    await expect(store.importFile(scope, 'task-1', workspace, '../outside.txt')).rejects.toBeInstanceOf(DomainError);
    const sibling = join(temporary, 'worktree-other');
    await mkdir(sibling);
    await writeFile(join(sibling, 'outside.txt'), 'Sibling is not a descendant');
    await expect(store.importFile(scope, 'task-1', workspace, '../worktree-other/outside.txt')).rejects.toBeInstanceOf(DomainError);
  });

  it('rejects file and directory symlinks escaping the worktree', async () => {
    const outside = join(temporary, 'outside.txt');
    await writeFile(outside, 'Private outside content');
    await symlink(outside, join(workspace, 'linked.txt'));
    await symlink(temporary, join(workspace, 'linked-directory'));
    await expect(store.importFile(scope, 'task-1', workspace, 'linked.txt')).rejects.toBeInstanceOf(DomainError);
    await expect(store.importFile(scope, 'task-1', workspace, 'linked-directory/outside.txt')).rejects.toBeInstanceOf(DomainError);
  });

  it('allows a symlink whose resolved file remains inside the worktree', async () => {
    await writeFile(join(workspace, 'actual.txt'), 'Verified');
    await symlink(join(workspace, 'actual.txt'), join(workspace, 'alias.txt'));
    const id = artifactId(await store.importFile(scope, 'task-1', workspace, 'alias.txt'));
    expect(Buffer.from((await store.read(scope, id))!.data).toString()).toBe('Verified');
  });

  it('rejects unsupported content types, directories, and files larger than the evidence limit', async () => {
    await writeFile(join(workspace, 'untrusted.html'), '<script>alert(1)</script>');
    await mkdir(join(workspace, 'directory.png'));
    await writeFile(join(workspace, 'oversized.mp4'), '');
    await truncate(join(workspace, 'oversized.mp4'), 100 * 1024 * 1024 + 1);
    await expect(store.importFile(scope, 'task-1', workspace, 'untrusted.html')).rejects.toBeInstanceOf(DomainError);
    await expect(store.importFile(scope, 'task-1', workspace, 'directory.png')).rejects.toBeInstanceOf(DomainError);
    await expect(store.importFile(scope, 'task-1', workspace, 'oversized.mp4')).rejects.toBeInstanceOf(DomainError);
  });

  it('does not read arbitrary files using an untrusted artifact identifier', async () => {
    await writeFile(join(temporary, 'outside.txt'), 'Private');
    for (const id of ['../../outside.txt', join(temporary, 'outside.txt'), 'not-a-uuid.txt', `${'a'.repeat(36)}.html`]) {
      expect(await store.read(scope, id)).toBeUndefined();
    }
    expect(await store.read(scope, '00000000-0000-0000-0000-000000000000.png')).toBeUndefined();
  });

  it('does not follow a stored artifact symlink to a file outside managed storage', async () => {
    await writeFile(join(workspace, 'actual.txt'), 'An allowed artifact');
    const id = artifactId(await store.importFile(scope, 'task-1', workspace, 'actual.txt'));
    const relativeArtifactPath = (await readdir(storage, { recursive: true })).find(filename => filename.endsWith(id))!;
    const storedArtifact = join(storage, relativeArtifactPath);
    await rm(storedArtifact);
    const outside = join(temporary, 'outside.txt');
    await writeFile(outside, 'Outside managed storage');
    await symlink(outside, storedArtifact);
    expect(await store.read(scope, id)).toBeUndefined();
    expect(await readFile(outside, 'utf8')).toBe('Outside managed storage');
  });

  it('rejects a scoped storage directory replaced with a symlink outside the storage root', async () => {
    await writeFile(join(workspace, 'actual.txt'), 'An allowed artifact');
    const id = artifactId(await store.importFile(scope, 'task-1', workspace, 'actual.txt'));
    const relativeArtifactPath = (await readdir(storage, { recursive: true })).find(filename => filename.endsWith(id))!;
    const scopedDirectory = dirname(join(storage, relativeArtifactPath));
    const outsideDirectory = join(temporary, 'outside-storage');
    await mkdir(outsideDirectory);
    await writeFile(join(outsideDirectory, id), 'Private outside content');
    await rm(scopedDirectory, { recursive: true });
    await symlink(outsideDirectory, scopedDirectory);

    expect(await store.read(scope, id)).toBeUndefined();
    await expect(store.importFile(scope, 'task-1', workspace, 'actual.txt')).rejects.toBeInstanceOf(DomainError);
    expect(await readdir(outsideDirectory)).toEqual([id]);
  });
});
