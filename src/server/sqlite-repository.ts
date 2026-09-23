import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Asset, Attention, ChiefMessage, Project, Scope, Settings, Task } from '../shared/types';
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
      if (schemaVersion > 2) throw new Error('This database requires a newer version of Muon.');
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
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }
  private keys(scope: Scope) { return [scope.workspaceId, scope.projectId]; }
  async initialize(scope: Scope, project: Project, settings: Settings) {
    this.db.prepare('INSERT OR IGNORE INTO projects VALUES (?, ?, ?)').run(...this.keys(scope), JSON.stringify(project));
    this.db.prepare('INSERT OR IGNORE INTO configuration (workspace_id,project_id,settings) VALUES (?,?,?)').run(...this.keys(scope), JSON.stringify(settings));
  }
  async project(scope: Scope) {
    const project = decode<Project>(this.db.prepare('SELECT payload FROM projects WHERE workspace_id=? AND project_id=?').get(...this.keys(scope)));
    if (!project) throw new Error('Project not found');
    return project;
  }
  async projects(workspaceId: string) {
    return this.db.prepare('SELECT payload FROM projects WHERE workspace_id=? ORDER BY rowid').all(workspaceId).map(row => decode<Project>(row)!);
  }
  async saveProject(scope: Scope, project: Project) {
    this.db.prepare('UPDATE projects SET payload=? WHERE workspace_id=? AND project_id=?').run(JSON.stringify(project), ...this.keys(scope));
  }
  async settings(scope: Scope) {
    const row = this.db.prepare('SELECT settings FROM configuration WHERE workspace_id=? AND project_id=?').get(...this.keys(scope));
    if (!row) throw new Error('Settings not found');
    return JSON.parse(row.settings as string) as Settings;
  }
  async saveSettings(scope: Scope, settings: Settings) {
    this.db.prepare('UPDATE configuration SET settings=? WHERE workspace_id=? AND project_id=?').run(JSON.stringify(settings), ...this.keys(scope));
  }
  async tasks(scope: Scope) {
    return this.db.prepare('SELECT payload FROM tasks WHERE workspace_id=? AND project_id=? ORDER BY rowid').all(...this.keys(scope)).map(row => decode<Task>(row)!);
  }
  async task(scope: Scope, id: string) {
    return decode<Task>(this.db.prepare('SELECT payload FROM tasks WHERE workspace_id=? AND project_id=? AND id=?').get(...this.keys(scope), id));
  }
  async assets(scope: Scope) {
    return this.db.prepare('SELECT payload FROM assets WHERE workspace_id=? AND project_id=? ORDER BY rowid').all(...this.keys(scope)).map(row => decode<Asset>(row)!);
  }
  async asset(scope: Scope, id: string) {
    return decode<Asset>(this.db.prepare('SELECT payload FROM assets WHERE workspace_id=? AND project_id=? AND id=?').get(...this.keys(scope), id));
  }
  async insertAsset(scope: Scope, asset: Asset) {
    const saved = { ...asset, workspaceId: scope.workspaceId, projectId: scope.projectId };
    this.db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?)').run(...this.keys(scope), saved.id, saved.storageBackendId, saved.objectKey, JSON.stringify(saved));
    return saved;
  }
  async insertTask(scope: Scope, task: Task) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const config = this.db.prepare('SELECT next_sequence FROM configuration WHERE workspace_id=? AND project_id=?').get(...this.keys(scope));
      const project = decode<Project>(this.db.prepare('SELECT payload FROM projects WHERE workspace_id=? AND project_id=?').get(...this.keys(scope)))!;
      const saved = { ...task, workspaceId: scope.workspaceId, projectId: scope.projectId, identifier: `${project.identifier}-${config!.next_sequence}`, version: 1 };
      this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run(...this.keys(scope), saved.id, saved.identifier, saved.ownerUserId, saved.status, saved.phase, saved.priority, saved.version, JSON.stringify(saved));
      this.db.prepare('UPDATE configuration SET next_sequence=next_sequence+1 WHERE workspace_id=? AND project_id=?').run(...this.keys(scope));
      this.db.exec('COMMIT');
      return saved;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async saveTask(scope: Scope, task: Task, expectedVersion: number) {
    const current = await this.task(scope, task.id);
    if (!current || current.version !== expectedVersion) throw new ConflictError();
    if (task.identifier !== current.identifier || task.ownerUserId !== current.ownerUserId) throw new Error('Task identifier and owner are immutable.');
    const saved = { ...task, workspaceId: scope.workspaceId, projectId: scope.projectId, version: expectedVersion + 1 };
    const result = this.db.prepare('UPDATE tasks SET status=?,phase=?,priority=?,version=?,payload=? WHERE workspace_id=? AND project_id=? AND id=? AND version=?').run(saved.status, saved.phase, saved.priority, saved.version, JSON.stringify(saved), ...this.keys(scope), task.id, expectedVersion);
    if (result.changes !== 1) throw new ConflictError();
    return saved;
  }
  async attention(scope: Scope) {
    return this.db.prepare('SELECT payload FROM attention WHERE workspace_id=? AND project_id=? ORDER BY rowid DESC').all(...this.keys(scope)).map(row => decode<Attention>(row)!);
  }
  async putAttention(scope: Scope, item: Attention) {
    this.db.prepare('INSERT INTO attention VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id,project_id,id) DO UPDATE SET payload=excluded.payload').run(...this.keys(scope), item.id, item.taskId, item.kind, JSON.stringify(item));
  }
  async removeAttention(scope: Scope, taskId: string, kind?: Attention['kind']) {
    if (kind) this.db.prepare('DELETE FROM attention WHERE workspace_id=? AND project_id=? AND task_id=? AND kind=?').run(...this.keys(scope), taskId, kind);
    else this.db.prepare('DELETE FROM attention WHERE workspace_id=? AND project_id=? AND task_id=?').run(...this.keys(scope), taskId);
  }
  async messages(scope: Scope) {
    return this.db.prepare('SELECT payload FROM chief_messages WHERE workspace_id=? AND project_id=? ORDER BY sequence').all(...this.keys(scope)).map(row => decode<ChiefMessage>(row)!);
  }
  async appendMessage(scope: Scope, message: ChiefMessage) {
    this.db.prepare('INSERT INTO chief_messages(workspace_id,project_id,id,payload) VALUES (?,?,?,?)').run(...this.keys(scope), message.id, JSON.stringify(message));
  }
  async enqueueChief(scope: Scope, message: ChiefMessage) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('UPDATE configuration SET pending_chief=? WHERE workspace_id=? AND project_id=? AND pending_chief IS NULL').run(message.id, ...this.keys(scope));
      if (result.changes !== 1) { this.db.exec('ROLLBACK'); return false; }
      this.db.prepare('INSERT INTO chief_messages(workspace_id,project_id,id,payload) VALUES (?,?,?,?)').run(...this.keys(scope), message.id, JSON.stringify(message));
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async pendingChief(scope: Scope) {
    const row = this.db.prepare('SELECT pending_chief FROM configuration WHERE workspace_id=? AND project_id=?').get(...this.keys(scope));
    return (row?.pending_chief as string | null) ?? null;
  }
  async setPendingChief(scope: Scope, messageId: string | null) {
    this.db.prepare('UPDATE configuration SET pending_chief=? WHERE workspace_id=? AND project_id=?').run(messageId, ...this.keys(scope));
  }
  close() { this.db.close(); }
}
