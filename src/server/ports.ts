import type { AppSnapshot, Asset, Attention, ChiefMessage, PlanningChat, Project, Scope, Settings, Task } from '../shared/types';

export interface Repository {
  initialize(scope: Scope, project: Project, settings: Settings): Promise<void>;
  project(scope: Scope): Promise<Project>;
  /** Every project row in a workspace, in creation order, including archived ones. */
  projects(workspaceId: string): Promise<Project[]>;
  saveProject(scope: Scope, project: Project): Promise<void>;
  settings(scope: Scope): Promise<Settings>;
  saveSettings(scope: Scope, settings: Settings): Promise<void>;
  tasks(scope: Scope): Promise<Task[]>;
  task(scope: Scope, id: string): Promise<Task | undefined>;
  insertTask(scope: Scope, task: Task): Promise<Task>;
  saveTask(scope: Scope, task: Task, expectedVersion: number): Promise<Task>;
  assets(scope: Scope): Promise<Asset[]>;
  asset(scope: Scope, id: string): Promise<Asset | undefined>;
  insertAsset(scope: Scope, asset: Asset): Promise<Asset>;
  /** Planning chats persist so a server restart does not lose an in-progress conversation. */
  planningChats(scope: Scope): Promise<PlanningChat[]>;
  savePlanningChat(scope: Scope, chat: PlanningChat): Promise<void>;
  deletePlanningChat(scope: Scope, id: string): Promise<void>;
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
export interface AssetStorage {
  readonly backendId: string;
  /** Creates immutable content. Retrying an identical write is allowed. */
  write(scope: Scope, objectKey: string, data: Uint8Array): Promise<void>;
  read(scope: Scope, objectKey: string): Promise<Uint8Array | undefined>;
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
