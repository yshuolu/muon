import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Asset, AssetComment, Attention, ChiefMessage, PlanningChat, Workspace, Scope, Settings, Task } from '../shared/types';
import { ConflictError, type Repository } from './ports';

type Row = Record<string, unknown>;
const decode = <T>(row: Row | undefined): T | undefined => row ? JSON.parse(row.payload as string) as T : undefined;

export class SqliteRepository implements Repository {
  private db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const schemaVersion = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
      if (schemaVersion > 5) throw new Error('This database requires a newer version of Muon.');
      if (schemaVersion < 1) this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (workspace_id, project_id)
      );
      CREATE TABLE IF NOT EXISTS configuration (
        workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, settings TEXT NOT NULL,
        next_sequence INTEGER NOT NULL DEFAULT 1, pending_chief TEXT,
        PRIMARY KEY (workspace_id, project_id),
        FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, project_id)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL,
        identifier TEXT NOT NULL, owner_user_id TEXT NOT NULL, status TEXT NOT NULL,
        phase TEXT NOT NULL, priority INTEGER NOT NULL, version INTEGER NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY (workspace_id, project_id, id),
        UNIQUE (workspace_id, project_id, identifier),
        FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, project_id)
      );
      CREATE INDEX IF NOT EXISTS task_dispatch ON tasks(workspace_id, project_id, status, priority);
      CREATE TABLE IF NOT EXISTS attention (
        workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL,
        task_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (workspace_id, project_id, id),
        FOREIGN KEY (workspace_id, project_id, task_id) REFERENCES tasks(workspace_id, project_id, id)
      );
      CREATE TABLE IF NOT EXISTS chief_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL, project_id TEXT NOT NULL,
        id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
        FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, project_id)
      );
      PRAGMA user_version = 1;
      `);
      if (schemaVersion < 2) this.db.exec(`
        CREATE TABLE assets (
          workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL,
          storage_backend_id TEXT NOT NULL, object_key TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (workspace_id, project_id, id),
          UNIQUE (workspace_id, project_id, storage_backend_id, object_key),
          FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, project_id)
        );
        PRAGMA user_version = 2;
      `);
      if (schemaVersion < 3) this.db.exec(`
        CREATE TABLE IF NOT EXISTS planning_chats (
          workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (workspace_id, project_id, id),
          FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, project_id)
        );
        PRAGMA user_version = 3;
      `);
      if (schemaVersion < 4) this.db.exec(`
        CREATE TABLE IF NOT EXISTS asset_comments (
          workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, asset_id TEXT NOT NULL,
          request_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (workspace_id, project_id, id),
          UNIQUE (workspace_id, project_id, asset_id, request_id),
          FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, project_id)
        );
        CREATE INDEX IF NOT EXISTS asset_comment_status ON asset_comments(workspace_id, project_id, asset_id, status);
        PRAGMA user_version = 4;
      `);
      if (schemaVersion < 5) this.migrateToWorkspaces();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }
  /**
   * Schema version 5: the folder-bound unit is a workspace and the tenant is an account. Versions 1–4 called them
   * project and workspace, so the `projects` table becomes `workspaces` and every table renames `workspace_id` →
   * `account_id` before `project_id` → `workspace_id` (the reverse order collides). SQLite rewrites the composite
   * keys, foreign keys, and indexes; values are untouched. JSON payloads carry the same keys and are rewritten in
   * place, together with asset visibility and the workspace-completion attention rows.
   */
  private migrateToWorkspaces() {
    this.db.exec('ALTER TABLE projects RENAME TO workspaces');
    for (const table of ['workspaces', 'configuration', 'tasks', 'attention', 'chief_messages', 'assets', 'planning_chats', 'asset_comments']) {
      this.db.exec(`ALTER TABLE ${table} RENAME COLUMN workspace_id TO account_id`);
      this.db.exec(`ALTER TABLE ${table} RENAME COLUMN project_id TO workspace_id`);
    }
    type Payload = Record<string, unknown>;
    const rescope = (payload: Payload) => {
      if ('workspaceId' in payload) { payload.accountId = payload.workspaceId; delete payload.workspaceId; }
      if ('projectId' in payload) { payload.workspaceId = payload.projectId; delete payload.projectId; }
    };
    const rewrite = (table: string, transform: (payload: Payload) => void) => {
      const rows = this.db.prepare(`SELECT rowid AS rowid, payload FROM ${table}`).all() as Array<{ rowid: number; payload: string }>;
      const update = this.db.prepare(`UPDATE ${table} SET payload=? WHERE rowid=?`);
      for (const row of rows) {
        const payload = JSON.parse(row.payload) as Payload;
        transform(payload);
        update.run(JSON.stringify(payload), row.rowid);
      }
    };
    rewrite('workspaces', rescope);
    rewrite('tasks', rescope);
    rewrite('assets', payload => { rescope(payload); if (payload.visibility === 'project') payload.visibility = 'workspace'; });
    const completions = this.db.prepare("SELECT rowid AS rowid, id, payload FROM attention WHERE kind='project_completed'").all() as Array<{ rowid: number; id: string; payload: string }>;
    const updateAttention = this.db.prepare('UPDATE attention SET id=?, kind=?, payload=? WHERE rowid=?');
    for (const row of completions) {
      const id = row.id.startsWith('project:') ? `workspace:${row.id.slice('project:'.length)}` : row.id;
      const payload = JSON.parse(row.payload) as Payload;
      payload.kind = 'workspace_completed';
      if (payload.id === row.id) payload.id = id;
      updateAttention.run(id, 'workspace_completed', JSON.stringify(payload), row.rowid);
    }
    this.db.exec('PRAGMA user_version = 5');
  }
  private keys(scope: Scope) { return [scope.accountId, scope.workspaceId]; }
  async initialize(scope: Scope, workspace: Workspace, settings: Settings) {
    this.db.prepare('INSERT OR IGNORE INTO workspaces VALUES (?, ?, ?)').run(...this.keys(scope), JSON.stringify(workspace));
    this.db.prepare('INSERT OR IGNORE INTO configuration (account_id,workspace_id,settings) VALUES (?,?,?)').run(...this.keys(scope), JSON.stringify(settings));
  }
  async workspace(scope: Scope) {
    const workspace = decode<Workspace>(this.db.prepare('SELECT payload FROM workspaces WHERE account_id=? AND workspace_id=?').get(...this.keys(scope)));
    if (!workspace) throw new Error('Workspace not found');
    return workspace;
  }
  async workspaces(accountId: string) {
    return this.db.prepare('SELECT payload FROM workspaces WHERE account_id=? ORDER BY rowid').all(accountId).map(row => decode<Workspace>(row)!);
  }
  async saveWorkspace(scope: Scope, workspace: Workspace) {
    this.db.prepare('UPDATE workspaces SET payload=? WHERE account_id=? AND workspace_id=?').run(JSON.stringify(workspace), ...this.keys(scope));
  }
  async settings(scope: Scope) {
    const row = this.db.prepare('SELECT settings FROM configuration WHERE account_id=? AND workspace_id=?').get(...this.keys(scope));
    if (!row) throw new Error('Settings not found');
    return JSON.parse(row.settings as string) as Settings;
  }
  async saveSettings(scope: Scope, settings: Settings) {
    this.db.prepare('UPDATE configuration SET settings=? WHERE account_id=? AND workspace_id=?').run(JSON.stringify(settings), ...this.keys(scope));
  }
  async tasks(scope: Scope) {
    return this.db.prepare('SELECT payload FROM tasks WHERE account_id=? AND workspace_id=? ORDER BY rowid').all(...this.keys(scope)).map(row => decode<Task>(row)!);
  }
  async task(scope: Scope, id: string) {
    return decode<Task>(this.db.prepare('SELECT payload FROM tasks WHERE account_id=? AND workspace_id=? AND id=?').get(...this.keys(scope), id));
  }
  async assets(scope: Scope) {
    return this.db.prepare('SELECT payload FROM assets WHERE account_id=? AND workspace_id=? ORDER BY rowid').all(...this.keys(scope)).map(row => decode<Asset>(row)!);
  }
  async asset(scope: Scope, id: string) {
    return decode<Asset>(this.db.prepare('SELECT payload FROM assets WHERE account_id=? AND workspace_id=? AND id=?').get(...this.keys(scope), id));
  }
  async insertAsset(scope: Scope, asset: Asset) {
    const saved = { ...asset, accountId: scope.accountId, workspaceId: scope.workspaceId };
    this.db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?)').run(...this.keys(scope), saved.id, saved.storageBackendId, saved.objectKey, JSON.stringify(saved));
    return saved;
  }
  async insertTask(scope: Scope, task: Task) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const config = this.db.prepare('SELECT next_sequence FROM configuration WHERE account_id=? AND workspace_id=?').get(...this.keys(scope));
      const workspace = decode<Workspace>(this.db.prepare('SELECT payload FROM workspaces WHERE account_id=? AND workspace_id=?').get(...this.keys(scope)))!;
      const saved = { ...task, accountId: scope.accountId, workspaceId: scope.workspaceId, identifier: `${workspace.identifier}-${config!.next_sequence}`, version: 1 };
      this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run(...this.keys(scope), saved.id, saved.identifier, saved.ownerUserId, saved.status, saved.phase, saved.priority, saved.version, JSON.stringify(saved));
      this.db.prepare('UPDATE configuration SET next_sequence=next_sequence+1 WHERE account_id=? AND workspace_id=?').run(...this.keys(scope));
      this.db.exec('COMMIT');
      return saved;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async saveTask(scope: Scope, task: Task, expectedVersion: number) {
    const current = await this.task(scope, task.id);
    if (!current || current.version !== expectedVersion) throw new ConflictError();
    if (task.identifier !== current.identifier || task.ownerUserId !== current.ownerUserId) throw new Error('Task identifier and owner are immutable.');
    const saved = { ...task, accountId: scope.accountId, workspaceId: scope.workspaceId, version: expectedVersion + 1 };
    const result = this.db.prepare('UPDATE tasks SET status=?,phase=?,priority=?,version=?,payload=? WHERE account_id=? AND workspace_id=? AND id=? AND version=?').run(saved.status, saved.phase, saved.priority, saved.version, JSON.stringify(saved), ...this.keys(scope), task.id, expectedVersion);
    if (result.changes !== 1) throw new ConflictError();
    return saved;
  }
  async renameTaskIdentifiers(scope: Scope, previous: string, next: string) {
    const prefix = `${previous}-`;
    const rows = this.db.prepare('SELECT id, identifier, payload FROM tasks WHERE account_id=? AND workspace_id=?').all(...this.keys(scope)) as Array<{ id: string; identifier: string; payload: string }>;
    const update = this.db.prepare('UPDATE tasks SET identifier=?, payload=? WHERE account_id=? AND workspace_id=? AND id=?');
    let changed = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        if (!row.identifier.startsWith(prefix)) continue;
        const identifier = `${next}-${row.identifier.slice(prefix.length)}`;
        const task = JSON.parse(row.payload) as Task;
        update.run(identifier, JSON.stringify({ ...task, identifier }), ...this.keys(scope), row.id);
        changed++;
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return changed;
  }
  async assetComments(scope: Scope, assetId: string) {
    return this.db.prepare('SELECT payload FROM asset_comments WHERE account_id=? AND workspace_id=? AND asset_id=? ORDER BY rowid').all(...this.keys(scope), assetId).map(row => decode<AssetComment>(row)!);
  }
  async saveAssetComment(scope: Scope, comment: AssetComment) {
    try {
      this.db.prepare('INSERT INTO asset_comments VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id,workspace_id,id) DO UPDATE SET status=excluded.status, payload=excluded.payload').run(...this.keys(scope), comment.id, comment.assetId, comment.requestId, comment.status, JSON.stringify(comment));
      return comment;
    } catch (error) {
      // A repeated requestId is the same submission; hand back what was stored the first time.
      const existing = decode<AssetComment>(this.db.prepare('SELECT payload FROM asset_comments WHERE account_id=? AND workspace_id=? AND asset_id=? AND request_id=?').get(...this.keys(scope), comment.assetId, comment.requestId));
      if (existing && existing.id !== comment.id) return existing;
      throw error;
    }
  }
  async deleteAssetComment(scope: Scope, id: string) {
    this.db.prepare('DELETE FROM asset_comments WHERE account_id=? AND workspace_id=? AND id=?').run(...this.keys(scope), id);
  }
  async pendingCommentCounts(scope: Scope) {
    const rows = this.db.prepare("SELECT asset_id, COUNT(*) AS pending FROM asset_comments WHERE account_id=? AND workspace_id=? AND status='pending' GROUP BY asset_id").all(...this.keys(scope));
    return Object.fromEntries(rows.map(row => [row.asset_id as string, Number(row.pending)]));
  }
  async planningChats(scope: Scope) {
    return this.db.prepare('SELECT payload FROM planning_chats WHERE account_id=? AND workspace_id=? ORDER BY rowid').all(...this.keys(scope)).map(row => decode<PlanningChat>(row)!);
  }
  async savePlanningChat(scope: Scope, chat: PlanningChat) {
    this.db.prepare('INSERT INTO planning_chats VALUES (?,?,?,?) ON CONFLICT(account_id,workspace_id,id) DO UPDATE SET payload=excluded.payload').run(...this.keys(scope), chat.id, JSON.stringify(chat));
  }
  async deletePlanningChat(scope: Scope, id: string) {
    this.db.prepare('DELETE FROM planning_chats WHERE account_id=? AND workspace_id=? AND id=?').run(...this.keys(scope), id);
  }
  async attention(scope: Scope) {
    return this.db.prepare('SELECT payload FROM attention WHERE account_id=? AND workspace_id=? ORDER BY rowid DESC').all(...this.keys(scope)).map(row => decode<Attention>(row)!);
  }
  async putAttention(scope: Scope, item: Attention) {
    this.db.prepare('INSERT INTO attention VALUES (?,?,?,?,?,?) ON CONFLICT(account_id,workspace_id,id) DO UPDATE SET payload=excluded.payload').run(...this.keys(scope), item.id, item.taskId, item.kind, JSON.stringify(item));
  }
  async removeAttention(scope: Scope, taskId: string, kind?: Attention['kind']) {
    if (kind) this.db.prepare('DELETE FROM attention WHERE account_id=? AND workspace_id=? AND task_id=? AND kind=?').run(...this.keys(scope), taskId, kind);
    else this.db.prepare('DELETE FROM attention WHERE account_id=? AND workspace_id=? AND task_id=?').run(...this.keys(scope), taskId);
  }
  async messages(scope: Scope) {
    return this.db.prepare('SELECT payload FROM chief_messages WHERE account_id=? AND workspace_id=? ORDER BY sequence').all(...this.keys(scope)).map(row => decode<ChiefMessage>(row)!);
  }
  async appendMessage(scope: Scope, message: ChiefMessage) {
    this.db.prepare('INSERT INTO chief_messages(account_id,workspace_id,id,payload) VALUES (?,?,?,?)').run(...this.keys(scope), message.id, JSON.stringify(message));
  }
  async enqueueChief(scope: Scope, message: ChiefMessage) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('UPDATE configuration SET pending_chief=? WHERE account_id=? AND workspace_id=? AND pending_chief IS NULL').run(message.id, ...this.keys(scope));
      if (result.changes !== 1) { this.db.exec('ROLLBACK'); return false; }
      this.db.prepare('INSERT INTO chief_messages(account_id,workspace_id,id,payload) VALUES (?,?,?,?)').run(...this.keys(scope), message.id, JSON.stringify(message));
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async pendingChief(scope: Scope) {
    const row = this.db.prepare('SELECT pending_chief FROM configuration WHERE account_id=? AND workspace_id=?').get(...this.keys(scope));
    return (row?.pending_chief as string | null) ?? null;
  }
  async setPendingChief(scope: Scope, messageId: string | null) {
    this.db.prepare('UPDATE configuration SET pending_chief=? WHERE account_id=? AND workspace_id=?').run(messageId, ...this.keys(scope));
  }
  close() { this.db.close(); }
}
