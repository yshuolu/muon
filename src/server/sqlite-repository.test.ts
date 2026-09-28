import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Asset, Attention, ChiefMessage, Workspace, Scope, Settings, Task } from '../shared/types';
import { ConflictError } from './ports';
import { SqliteRepository } from './sqlite-repository';

const scope: Scope = { accountId: 'workspace-a', workspaceId: 'workspace-a', userId: 'owner-a' };
const settings: Settings = { maxConcurrentAgents: 2, dispatcherEnabled: true, defaultProvider: 'claude' };
const timestamp = '2026-09-08T12:00:00.000Z';
const workspace = (target: Scope = scope): Workspace => ({
  id: target.workspaceId, accountId: target.accountId, ownerUserId: target.userId,
  name: 'Test workspace', identifier: 'MUO', repositoryPath: '/tmp/test-repository',
});
const task = (id: string, target: Scope = scope): Task => ({
  id, identifier: 'unallocated', accountId: target.accountId, workspaceId: target.workspaceId,
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
  id, accountId: scope.accountId, workspaceId: scope.workspaceId, name: 'report.md',
  mediaType: 'text/markdown', sizeBytes: 8, sha256: 'a'.repeat(64), storageBackendId: 'local',
  objectKey: id, origin: 'generated', createdAt: timestamp, createdByUserId: scope.userId,
  ownerUserId: scope.userId, visibility: 'private',
});

const opened = new Set<SqliteRepository>();
const directories: string[] = [];
async function repository(filename = ':memory:', target: Scope = scope) {
  const repo = new SqliteRepository(filename);
  opened.add(repo);
  await repo.initialize(target, workspace(target), settings);
  return repo;
}

/** The schema Muon wrote before version 5, when the folder unit was a project under a tenant called workspace. */
const LEGACY_DDL = {
  1: `
    CREATE TABLE projects (workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (workspace_id, project_id));
    CREATE TABLE configuration (workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, settings TEXT NOT NULL, next_sequence INTEGER NOT NULL DEFAULT 1, pending_chief TEXT,
      PRIMARY KEY (workspace_id, project_id), FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, project_id));
    CREATE TABLE tasks (workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, identifier TEXT NOT NULL, owner_user_id TEXT NOT NULL, status TEXT NOT NULL,
      phase TEXT NOT NULL, priority INTEGER NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (workspace_id, project_id, id),
      UNIQUE (workspace_id, project_id, identifier), FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, project_id));
    CREATE INDEX task_dispatch ON tasks(workspace_id, project_id, status, priority);
    CREATE TABLE attention (workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (workspace_id, project_id, id), FOREIGN KEY (workspace_id, project_id, task_id) REFERENCES tasks(workspace_id, project_id, id));
    CREATE TABLE chief_messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
      FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, project_id));
    PRAGMA user_version = 1;`,
  2: `
    CREATE TABLE assets (workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, storage_backend_id TEXT NOT NULL, object_key TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (workspace_id, project_id, id), UNIQUE (workspace_id, project_id, storage_backend_id, object_key), FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, project_id));
    PRAGMA user_version = 2;`,
  3: `
    CREATE TABLE planning_chats (workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (workspace_id, project_id, id), FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, project_id));
    PRAGMA user_version = 3;`,
  4: `
    CREATE TABLE asset_comments (workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, asset_id TEXT NOT NULL, request_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (workspace_id, project_id, id), UNIQUE (workspace_id, project_id, asset_id, request_id), FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, project_id));
    CREATE INDEX asset_comment_status ON asset_comments(workspace_id, project_id, asset_id, status);
    PRAGMA user_version = 4;`,
};

/** A database file as an installation at the given legacy version would have left it, with rows in every table it had. */
async function legacyDatabase(version: 1 | 4): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'muon-repository-migration-'));
  directories.push(directory);
  const filename = join(directory, 'muon.sqlite');
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON;');
  for (const step of [1, 2, 3, 4] as const) if (step <= version) db.exec(LEGACY_DDL[step]);
  const keys = ['local-workspace', 'local-project'];
  db.prepare('INSERT INTO projects VALUES (?,?,?)').run(...keys, JSON.stringify({ id: 'local-project', workspaceId: 'local-workspace', ownerUserId: 'local-owner', name: 'Legacy project', identifier: 'MUO', repositoryPath: '/repos/legacy' }));
  db.prepare('INSERT INTO configuration (workspace_id, project_id, settings, next_sequence, pending_chief) VALUES (?,?,?,?,?)').run(...keys, JSON.stringify({ ...settings, maxConcurrentAgents: 3 }), 2, 'm1');
  const legacyTask = { ...task('t1'), identifier: 'MUO-1', title: 'Legacy task', workspaceId: 'local-workspace', projectId: 'local-project', ownerUserId: 'local-owner', version: 1 } as Record<string, unknown>;
  delete legacyTask.accountId;
  db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run(...keys, 't1', 'MUO-1', 'local-owner', 'todo', 'idle', 2, 1, JSON.stringify(legacyTask));
  db.prepare('INSERT INTO attention VALUES (?,?,?,?,?,?)').run(...keys, 'project:local-project:completed', 't1', 'project_completed', JSON.stringify({ id: 'project:local-project:completed', taskId: 't1', kind: 'project_completed', title: 'Legacy project is complete', description: 'Done.', createdAt: timestamp }));
  db.prepare('INSERT INTO chief_messages (workspace_id, project_id, id, payload) VALUES (?,?,?,?)').run(...keys, 'm1', JSON.stringify(message('m1')));
  if (version >= 4) {
    const legacyAsset = { ...asset('a1'), workspaceId: 'local-workspace', projectId: 'local-project', ownerUserId: 'local-owner', createdByUserId: 'local-owner', visibility: 'project' } as Record<string, unknown>;
    delete legacyAsset.accountId;
    db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?)').run(...keys, 'a1', 'local', 'a1', JSON.stringify(legacyAsset));
    db.prepare('INSERT INTO planning_chats VALUES (?,?,?,?)').run(...keys, 'c1', JSON.stringify({ id: 'c1', provider: 'claude', model: null, messages: [], createdAt: timestamp, updatedAt: timestamp, busy: false }));
    db.prepare('INSERT INTO asset_comments VALUES (?,?,?,?,?,?,?)').run(...keys, 'ac1', 'a1', 'r1', 'pending', JSON.stringify({ id: 'ac1', assetId: 'a1', requestId: 'r1', content: 'Why?', createdAt: timestamp, updatedAt: timestamp, status: 'pending' }));
  }
  db.close();
  return filename;
}
function close(repo: SqliteRepository) { repo.close(); opened.delete(repo); }

afterEach(async () => {
  for (const repo of opened) repo.close();
  opened.clear();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('SqliteRepository', () => {
  it('persists immutable assets with account and workspace isolation', async () => {
    const repo = await repository();
    const otherWorkspace = { ...scope, workspaceId: 'workspace-b' };
    const otherAccount = { ...scope, accountId: 'account-b' };
    for (const target of [otherWorkspace, otherAccount]) await repo.initialize(target, workspace(target), settings);
    const first = await repo.insertAsset(scope, asset('same-id'));
    await repo.insertAsset(otherWorkspace, { ...asset('same-id'), name: 'Other workspace.md' });
    await repo.insertAsset(otherAccount, { ...asset('same-id'), name: 'Other account.md' });
    expect(await repo.assets(scope)).toEqual([first]);
    expect((await repo.asset(otherWorkspace, first.id))?.name).toBe('Other workspace.md');
    expect((await repo.asset(otherAccount, first.id))?.name).toBe('Other account.md');
    expect(await repo.asset({ ...scope, workspaceId: 'missing' }, first.id)).toBeUndefined();
    await expect(repo.insertAsset(scope, { ...first, name: 'Replacement.md' })).rejects.toThrow();
    await expect(repo.insertAsset(scope, { ...first, id: 'duplicate-key' })).rejects.toThrow();
    expect(await repo.asset(scope, first.id)).toEqual(first);
  });

  it('migrates a version 1 database without changing existing task records', async () => {
    const filename = await legacyDatabase(1);
    const legacy = { accountId: 'local-workspace', workspaceId: 'local-project', userId: 'local-owner' };
    let repo = await repository(filename, legacy);
    const original = await repo.task(legacy, 't1');
    expect(original).toMatchObject({ id: 't1', identifier: 'MUO-1', accountId: 'local-workspace', workspaceId: 'local-project', title: 'Legacy task' });
    expect(original).not.toHaveProperty('projectId');
    const stored = await repo.insertAsset(legacy, { ...asset('asset-1'), accountId: legacy.accountId, workspaceId: legacy.workspaceId });
    close(repo);
    repo = await repository(filename, legacy);
    expect(await repo.asset(legacy, stored.id)).toEqual(stored);
    expect(await repo.task(legacy, 't1')).toEqual(original);
    expect((await repo.insertTask(legacy, task('second', legacy))).identifier).toBe('MUO-2');
    const migratedDatabase = new DatabaseSync(filename);
    expect(migratedDatabase.prepare('PRAGMA user_version').get()?.user_version).toBe(5);
    migratedDatabase.close();
  });

  it('migrates a version 4 database to accounts and workspaces without losing or renaming any value', async () => {
    const filename = await legacyDatabase(4);
    const legacy = { accountId: 'local-workspace', workspaceId: 'local-project', userId: 'local-owner' };
    const repo = new SqliteRepository(filename);
    opened.add(repo);
    const raw = new DatabaseSync(filename);
    expect(raw.prepare('PRAGMA user_version').get()?.user_version).toBe(5);
    expect(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='workspaces'").get()?.n).toBe(1);
    expect(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='projects' OR sql LIKE '%project%'").get()?.n).toBe(0);
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(raw.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    raw.close();
    expect(await repo.workspace(legacy)).toEqual({ id: 'local-project', accountId: 'local-workspace', ownerUserId: 'local-owner', name: 'Legacy project', identifier: 'MUO', repositoryPath: '/repos/legacy' });
    const migratedTask = await repo.task(legacy, 't1');
    expect(migratedTask).toMatchObject({ identifier: 'MUO-1', accountId: 'local-workspace', workspaceId: 'local-project' });
    expect(migratedTask).not.toHaveProperty('projectId');
    const migratedAsset = await repo.asset(legacy, 'a1');
    expect(migratedAsset).toMatchObject({ accountId: 'local-workspace', workspaceId: 'local-project', visibility: 'workspace' });
    expect(migratedAsset).not.toHaveProperty('projectId');
    expect(await repo.attention(legacy)).toEqual([{ id: 'workspace:local-project:completed', taskId: 't1', kind: 'workspace_completed', title: 'Legacy project is complete', description: 'Done.', createdAt: timestamp }]);
    await repo.removeAttention(legacy, 't1', 'workspace_completed');
    expect(await repo.attention(legacy)).toEqual([]);
    expect((await repo.messages(legacy)).map(item => item.id)).toEqual(['m1']);
    expect(await repo.pendingChief(legacy)).toBe('m1');
    expect((await repo.planningChats(legacy)).map(chat => chat.id)).toEqual(['c1']);
    expect((await repo.assetComments(legacy, 'a1')).map(comment => comment.id)).toEqual(['ac1']);
    expect(await repo.pendingCommentCounts(legacy)).toEqual({ a1: 1 });
    expect((await repo.settings(legacy)).maxConcurrentAgents).toBe(3);
    expect((await repo.insertTask(legacy, task('second', legacy))).identifier).toBe('MUO-2');
    const again = new DatabaseSync(filename);
    expect(() => again.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run('local-workspace', 'local-project', 'dup', 'MUO-1', 'local-owner', 'todo', 'idle', 0, 1, '{}')).toThrow(/UNIQUE constraint failed: tasks.account_id, tasks.workspace_id, tasks.identifier/);
    expect(again.prepare('PRAGMA user_version').get()?.user_version).toBe(5);
    again.close();
    await expect(repo.putAttention(legacy, attention('orphan', 'missing-task'))).rejects.toThrow();
  });

  it('refuses a newer database schema without rewriting its version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'muon-repository-migration-'));
    directories.push(directory);
    const filename = join(directory, 'muon.sqlite');
    const futureDatabase = new DatabaseSync(filename);
    futureDatabase.exec('PRAGMA user_version = 6;');
    futureDatabase.close();
    expect(() => new SqliteRepository(filename)).toThrow('newer version');
    const unchangedDatabase = new DatabaseSync(filename);
    expect(unchangedDatabase.prepare('PRAGMA user_version').get()?.user_version).toBe(6);
    unchangedDatabase.close();
  });

  it('isolates records by both account and workspace even when task IDs match', async () => {
    const repo = await repository();
    const otherWorkspace = { ...scope, workspaceId: 'workspace-b' };
    const otherAccount = { ...scope, accountId: 'account-b' };
    for (const target of [otherWorkspace, otherAccount]) await repo.initialize(target, workspace(target), settings);

    const first = await repo.insertTask(scope, task('same-id'));
    await repo.insertTask(otherWorkspace, { ...task('same-id', otherWorkspace), title: 'Other workspace' });
    await repo.insertTask(otherAccount, { ...task('same-id', otherAccount), title: 'Other account' });
    await repo.putAttention(scope, attention('same-attention', first.id));
    await repo.putAttention(otherWorkspace, attention('same-attention', 'same-id'));
    await repo.appendMessage(scope, message('message-a'));
    await repo.appendMessage(otherWorkspace, message('message-b'));
    await repo.setPendingChief(scope, 'message-a');
    await repo.saveSettings(otherWorkspace, { ...settings, maxConcurrentAgents: 7 });

    expect((await repo.tasks(scope)).map(item => item.title)).toEqual(['Task same-id']);
    expect((await repo.task(otherWorkspace, 'same-id'))?.title).toBe('Other workspace');
    expect((await repo.task(otherAccount, 'same-id'))?.title).toBe('Other account');
    expect(await repo.task({ ...scope, workspaceId: 'missing' }, 'same-id')).toBeUndefined();
    expect((await repo.messages(scope)).map(item => item.id)).toEqual(['message-a']);
    expect((await repo.messages(otherWorkspace)).map(item => item.id)).toEqual(['message-b']);
    expect(await repo.pendingChief(otherWorkspace)).toBeNull();
    expect((await repo.settings(scope)).maxConcurrentAgents).toBe(2);
    await repo.removeAttention(scope, 'same-id');
    expect(await repo.attention(scope)).toEqual([]);
    expect(await repo.attention(otherWorkspace)).toHaveLength(1);
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

  it('does not let scoped updates overwrite a task in another workspace', async () => {
    const repo = await repository();
    const inserted = await repo.insertTask(scope, task('first'));
    const otherWorkspace = { ...scope, workspaceId: 'other-workspace' };
    await repo.initialize(otherWorkspace, workspace(otherWorkspace), settings);
    await expect(repo.saveTask(otherWorkspace, { ...inserted, title: 'Wrong scope' }, 1)).rejects.toBeInstanceOf(ConflictError);
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
    await repo.saveWorkspace(scope, { ...workspace(), name: 'Renamed workspace' });
    await repo.putAttention(scope, attention('review-first', 'first'));
    await repo.appendMessage(scope, message('message-first'));
    await repo.appendMessage(scope, message('message-second'));
    await repo.setPendingChief(scope, 'message-second');
    close(repo);

    repo = await repository(filename);
    expect(await repo.task(scope, 'first')).toEqual(stored);
    expect((await repo.workspace(scope)).name).toBe('Renamed workspace');
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
