import type { AppSnapshot, Attention, ChiefMessage, Project, Scope, Settings, Task } from '../shared/types';

export interface Repository {
  initialize(scope: Scope, project: Project, settings: Settings): Promise<void>;
  project(scope: Scope): Promise<Project>;
  saveProject(scope: Scope, project: Project): Promise<void>;
  settings(scope: Scope): Promise<Settings>;
  saveSettings(scope: Scope, settings: Settings): Promise<void>;
  tasks(scope: Scope): Promise<Task[]>;
  task(scope: Scope, id: string): Promise<Task | undefined>;
  insertTask(scope: Scope, task: Task): Promise<Task>;
  saveTask(scope: Scope, task: Task, expectedVersion: number): Promise<Task>;
  attention(scope: Scope): Promise<Attention[]>;
  putAttention(scope: Scope, attention: Attention): Promise<void>;
  removeAttention(scope: Scope, taskId: string, kind?: Attention['kind']): Promise<void>;
  messages(scope: Scope): Promise<ChiefMessage[]>;
  appendMessage(scope: Scope, message: ChiefMessage): Promise<void>;
  enqueueChief(scope: Scope, message: ChiefMessage): Promise<boolean>;
  pendingChief(scope: Scope): Promise<string | null>;
  setPendingChief(scope: Scope, messageId: string | null): Promise<void>;
  close(): void;
}
export interface ArtifactStore {
  importFile(scope: Scope, taskId: string, workspacePath: string, relativePath: string): Promise<string>;
  read(scope: Scope, id: string): Promise<{ data: Uint8Array; mime: string } | undefined>;
}
export interface IdentityProvider { currentScope(): Scope }
export interface Dispatcher { start(): void; stop(): Promise<void>; tick(): Promise<void> }
export interface ChiefCommandSession {
  cli: { command: string; apiUrl: string; token: string };
  taskIds(): string[];
  close(): Promise<void>;
}
// A local implementation supplies a CLI; a remote implementation can issue API credentials.
export interface ChiefCommandGateway { open(scope: Scope, signal: AbortSignal): Promise<ChiefCommandSession> }
export class ConflictError extends Error { constructor() { super('This task changed. Refresh and try again.'); } }
export class DomainError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
