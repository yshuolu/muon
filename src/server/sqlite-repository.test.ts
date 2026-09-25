import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Asset, Attention, ChiefMessage, Project, Scope, Settings, Task } from '../shared/types';
import { ConflictError } from './ports';
import { SqliteRepository } from './sqlite-repository';

const scope: Scope = { workspaceId: 'workspace-a', projectId: 'project-a', userId: 'owner-a' };
const settings: Settings = { maxConcurrentAgents: 2, dispatcherEnabled: true, defaultProvider: 'claude' };
const timestamp = '2026-09-08T12:00:00.000Z';
const project = (target: Scope = scope): Project => ({
  id: target.projectId, workspaceId: target.workspaceId, ownerUserId: target.userId,
  name: 'Test project', identifier: 'MUO', repositoryPath: '/tmp/test-repository',
});
const task = (id: string, target: Scope = scope): Task => ({
  id, identifier: 'unallocated', workspaceId: target.workspaceId, projectId: target.projectId,
  ownerUserId: target.userId, title: `Task ${id}`, description: 'A persisted task',
  status: 'todo', phase: 'idle', priority: 2, provider: 'claude', labels: [],
  parentId: null, blockedByIds: [], plans: [], evidence: [], changedFiles: [],
  activity: [], summary: '', createdAt: timestamp, updatedAt: timestamp, version: 0,
});
const attention = (id: string, taskId: string, kind: Attention['kind'] = 'plan_approval'): Attention => ({
  id, taskId, kind, title: 'Review RFC', description: 'A plan needs approval.', createdAt: timestamp,
});
const message = (id: string): ChiefMessage => ({ id, role: 'user', content: id, createdAt: timestamp });
const asset = (id: string): Asset => ({
  id, workspaceId: scope.workspaceId, projectId: scope.projectId, name: 'report.md',
  mediaType: 'text/markdown', sizeBytes: 8, sha256: 'a'.repeat(64), storageBackendId: 'local',
  objectKey: id, origin: 'generated', createdAt: timestamp, createdByUserId: scope.userId,
  ownerUserId: scope.userId, visibility: 'private',
});

const opened = new Set<SqliteRepository>();
const directories: string[] = [];
async function repository(filename = ':memory:') {
  const repo = new SqliteRepository(filename);
  opened.add(repo);
  await repo.initialize(scope, project(), settings);
  return repo;
}
function close(repo: SqliteRepository) { repo.close(); opened.delete(repo); }

afterEach(async () => {
  for (const repo of opened) repo.close();
  opened.clear();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('SqliteRepository', () => {
  it('persists immutable assets with project and workspace isolation', async () => {
    const repo = await repository();
    const otherProject = { ...scope, projectId: 'project-b' };
    const otherWorkspace = { ...scope, workspaceId: 'workspace-b' };
    for (const target of [otherProject, otherWorkspace]) await repo.initialize(target, project(target), settings);
    const first = await repo.insertAsset(scope, asset('same-id'));
    await repo.insertAsset(otherProject, { ...asset('same-id'), name: 'Other project.md' });
    await repo.insertAsset(otherWorkspace, { ...asset('same-id'), name: 'Other workspace.md' });
    expect(await repo.assets(scope)).toEqual([first]);
    expect((await repo.asset(otherProject, first.id))?.name).toBe('Other project.md');
    expect((await repo.asset(otherWorkspace, first.id))?.name).toBe('Other workspace.md');
    expect(await repo.asset({ ...scope, projectId: 'missing' }, first.id)).toBeUndefined();
    await expect(repo.insertAsset(scope, { ...first, name: 'Replacement.md' })).rejects.toThrow();
    await expect(repo.insertAsset(scope, { ...first, id: 'duplicate-key' })).rejects.toThrow();
    expect(await repo.asset(scope, first.id)).toEqual(first);
  });

  it('migrates a version 1 database without changing existing task records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'muon-repository-migration-'));
    directories.push(directory);
    const filename = join(directory, 'muon.sqlite');
    let repo = await repository(filename);
    const original = await repo.insertTask(scope, task('first'));
    close(repo);
    const oldDatabase = new DatabaseSync(filename);
    oldDatabase.exec('DROP TABLE assets; PRAGMA user_version = 1;');
    oldDatabase.close();
    repo = await repository(filename);
    expect(await repo.task(scope, original.id)).toEqual(original);
    const stored = await repo.insertAsset(scope, asset('asset-1'));
    close(repo);
    repo = await repository(filename);
    expect(await repo.asset(scope, stored.id)).toEqual(stored);
    expect((await repo.insertTask(scope, task('second'))).identifier).toBe('MUO-2');
    const migratedDatabase = new DatabaseSync(filename);
    expect(migratedDatabase.prepare('PRAGMA user_version').get()?.user_version).toBe(4);
    migratedDatabase.close();
  });

  it('refuses a newer database schema without rewriting its version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'muon-repository-migration-'));
    directories.push(directory);
    const filename = join(directory, 'muon.sqlite');
    const futureDatabase = new DatabaseSync(filename);
    futureDatabase.exec('PRAGMA user_version = 5;');
    futureDatabase.close();
    expect(() => new SqliteRepository(filename)).toThrow('newer version');
    const unchangedDatabase = new DatabaseSync(filename);
    expect(unchangedDatabase.prepare('PRAGMA user_version').get()?.user_version).toBe(5);
    unchangedDatabase.close();
  });

  it('isolates records by both workspace and project even when task IDs match', async () => {
    const repo = await repository();
    const otherProject = { ...scope, projectId: 'project-b' };
    const otherWorkspace = { ...scope, workspaceId: 'workspace-b' };
    for (const target of [otherProject, otherWorkspace]) await repo.initialize(target, project(target), settings);

    const first = await repo.insertTask(scope, task('same-id'));
    await repo.insertTask(otherProject, { ...task('same-id', otherProject), title: 'Other project' });
    await repo.insertTask(otherWorkspace, { ...task('same-id', otherWorkspace), title: 'Other workspace' });
    await repo.putAttention(scope, attention('same-attention', first.id));
    await repo.putAttention(otherProject, attention('same-attention', 'same-id'));
    await repo.appendMessage(scope, message('message-a'));
    await repo.appendMessage(otherProject, message('message-b'));
    await repo.setPendingChief(scope, 'message-a');
    await repo.saveSettings(otherProject, { ...settings, maxConcurrentAgents: 7 });

    expect((await repo.tasks(scope)).map(item => item.title)).toEqual(['Task same-id']);
    expect((await repo.task(otherProject, 'same-id'))?.title).toBe('Other project');
    expect((await repo.task(otherWorkspace, 'same-id'))?.title).toBe('Other workspace');
    expect(await repo.task({ ...scope, projectId: 'missing' }, 'same-id')).toBeUndefined();
    expect((await repo.messages(scope)).map(item => item.id)).toEqual(['message-a']);
    expect((await repo.messages(otherProject)).map(item => item.id)).toEqual(['message-b']);
    expect(await repo.pendingChief(otherProject)).toBeNull();
    expect((await repo.settings(scope)).maxConcurrentAgents).toBe(2);
    await repo.removeAttention(scope, 'same-id');
    expect(await repo.attention(scope)).toEqual([]);
    expect(await repo.attention(otherProject)).toHaveLength(1);
  });

  it('allocates unique identifiers and rolls back sequence increments on a failed insert', async () => {
    const repo = await repository();
    const first = await repo.insertTask(scope, task('first'));
    await expect(repo.insertTask(scope, task('first'))).rejects.toThrow();
    const second = await repo.insertTask(scope, task('second'));
    expect([first.identifier, second.identifier]).toEqual(['MUO-1', 'MUO-2']);
    expect(first.version).toBe(1);
    expect((await repo.tasks(scope)).map(item => item.id)).toEqual(['first', 'second']);
  });

  it('rejects a stale update and preserves the winning complete task snapshot', async () => {
    const repo = await repository();
    const inserted = await repo.insertTask(scope, task('first'));
    const staleCopy = await repo.task(scope, inserted.id);
    const saved = await repo.saveTask(scope, { ...inserted, title: 'Approved outcome', phase: 'planning' }, inserted.version);
    await expect(repo.saveTask(scope, { ...staleCopy!, title: 'Stale overwrite' }, staleCopy!.version)).rejects.toBeInstanceOf(ConflictError);
    expect(saved.version).toBe(2);
    expect(await repo.task(scope, inserted.id)).toEqual(saved);
    await expect(repo.saveTask(scope, task('missing'), 1)).rejects.toBeInstanceOf(ConflictError);
  });

  it('cannot rewrite an allocated identifier into another existing identifier', async () => {
    const repo = await repository();
    const first = await repo.insertTask(scope, task('first'));
    const second = await repo.insertTask(scope, task('second'));
    await expect(repo.saveTask(scope, { ...first, identifier: second.identifier }, first.version)).rejects.toThrow();
    const stored = await repo.tasks(scope);
    expect(stored.find(item => item.id === first.id)?.identifier).toBe(first.identifier);
    expect(new Set(stored.map(item => item.identifier)).size).toBe(stored.length);
  });

  it('upserts attention without duplicating it and removes only the requested kind', async () => {
    const repo = await repository();
    await repo.insertTask(scope, task('first'));
    const approval = attention('approval', 'first');
    await repo.putAttention(scope, approval);
    await repo.putAttention(scope, { ...approval, readAt: timestamp });
    await repo.putAttention(scope, attention('blocked', 'first', 'blocked'));
    expect(await repo.attention(scope)).toHaveLength(2);
    expect((await repo.attention(scope)).find(item => item.id === 'approval')?.readAt).toBe(timestamp);
    await repo.removeAttention(scope, 'first', 'plan_approval');
    expect((await repo.attention(scope)).map(item => item.kind)).toEqual(['blocked']);
    await expect(repo.putAttention(scope, attention('invalid', 'missing-task'))).rejects.toThrow();
  });

  it('does not let scoped updates overwrite a task in another project', async () => {
    const repo = await repository();
    const inserted = await repo.insertTask(scope, task('first'));
    const otherProject = { ...scope, projectId: 'other-project' };
    await repo.initialize(otherProject, project(otherProject), settings);
    await expect(repo.saveTask(otherProject, { ...inserted, title: 'Wrong scope' }, 1)).rejects.toBeInstanceOf(ConflictError);
    expect(await repo.task(scope, inserted.id)).toEqual(inserted);
  });

  it('preserves workflow artifacts, configuration, messages, attention, and sequence after reopening', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'muon-repository-'));
    directories.push(directory);
    const filename = join(directory, 'nested', 'muon.sqlite');
    let repo = await repository(filename);
    const inserted = await repo.insertTask(scope, task('first'));
    const stored = await repo.saveTask(scope, {
      ...inserted, status: 'in_review', phase: 'plan_review',
      plans: [{ id: 'plan-1', version: 1, format: 'markdown', content: '# RFC', status: 'pending', createdAt: timestamp }],
      evidence: [{ id: 'evidence-1', kind: 'test', title: 'Regression test', description: 'Expected result observed', result: 'passed', steps: ['Run the regression'], createdAt: timestamp }],
      changedFiles: [{ path: 'src/app.ts', status: 'M', additions: 3, deletions: 1 }],
      worktree: { path: '/tmp/worktree', branch: 'muon/task-first', baseCommit: 'a'.repeat(40) },
    }, inserted.version);
    await repo.saveSettings(scope, { ...settings, dispatcherEnabled: false, chiefModel: 'sonnet[1m]', chiefSoul: 'Be concise.' });
    await repo.saveProject(scope, { ...project(), name: 'Renamed project' });
    await repo.putAttention(scope, attention('review-first', 'first'));
    await repo.appendMessage(scope, message('message-first'));
    await repo.appendMessage(scope, message('message-second'));
    await repo.setPendingChief(scope, 'message-second');
    close(repo);

    repo = await repository(filename);
    expect(await repo.task(scope, 'first')).toEqual(stored);
    expect((await repo.project(scope)).name).toBe('Renamed project');
    expect(await repo.settings(scope)).toMatchObject({ dispatcherEnabled: false, chiefModel: 'sonnet[1m]', chiefSoul: 'Be concise.' });
    expect(await repo.attention(scope)).toEqual([attention('review-first', 'first')]);
    expect((await repo.messages(scope)).map(item => item.id)).toEqual(['message-first', 'message-second']);
    expect(await repo.pendingChief(scope)).toBe('message-second');
    expect((await repo.insertTask(scope, task('second'))).identifier).toBe('MUO-2');
  });

  it('coordinates identifier allocation and optimistic updates across database connections', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'muon-repository-'));
    directories.push(directory);
    const filename = join(directory, 'muon.sqlite');
    const firstConnection = await repository(filename);
    const secondConnection = await repository(filename);
    const inserted = await firstConnection.insertTask(scope, task('first'));
    const staleCopy = await secondConnection.task(scope, inserted.id);
    const next = await secondConnection.insertTask(scope, task('second'));
    expect(next.identifier).toBe('MUO-2');
    await firstConnection.saveTask(scope, { ...inserted, title: 'Connection one' }, 1);
    await expect(secondConnection.saveTask(scope, { ...staleCopy!, title: 'Connection two' }, 1)).rejects.toBeInstanceOf(ConflictError);
    expect((await secondConnection.task(scope, inserted.id))?.title).toBe('Connection one');
  });
});
