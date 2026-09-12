export type AgentProvider = 'claude' | 'codex';
export type AgentSessionKind = 'brainstorm' | 'research' | 'plan' | 'build' | 'verify' | 'chief' | 'chat';
export type SessionAccess = 'read-only' | 'workspace-write';
export type AgentPhase = 'planning' | 'building' | 'verification' | 'chief' | 'chat';

export interface SessionInput {
  systemPrompt: string;
  instructions: string;
  context: string;
}

interface AgentExecutionOptions {
  provider: AgentProvider;
  cwd: string;
  /** Resume only the provider conversation belonging to this workflow session. */
  sessionId?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  chiefCli?: { command: string; apiUrl: string; token: string };
}

export interface AgentSessionRequest extends AgentExecutionOptions {
  session: AgentSessionKind;
  input: SessionInput;
  access: SessionAccess;
}

/** Compatibility input for callers that have not migrated to named sessions. */
export interface AgentRequest extends AgentExecutionOptions {
  phase: AgentPhase;
  prompt: string;
}

export interface AgentResult {
  text: string;
  sessionId?: string;
}

export interface AgentAdapter {
  provider: AgentProvider;
  run(request: AgentRequest | AgentSessionRequest): Promise<AgentResult>;
  available(): Promise<boolean>;
}

export interface TaskWorkspace {
  path: string;
  branch: string;
  baseCommit: string;
}

export interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface WorkspaceChanges {
  format: 'git-patch';
  baseCommit: string;
  headCommit: string;
  sha256: string;
  patchEncoding: 'utf8' | 'base64';
  patch: string;
  files: ChangedFile[];
}

export interface WorkspaceProvider {
  ensureScratch?(input: { taskId: string }): Promise<{ path: string }>;
  validateRepository?(repositoryPath: string): Promise<void>;
  ensure(input: { repositoryPath: string; taskId: string; baseRef?: string }): Promise<TaskWorkspace>;
  changedFiles(input: { path: string; baseCommit: string }): Promise<ChangedFile[]>;
  exportChanges?(input: TaskWorkspace & { maxBytes?: number }): Promise<WorkspaceChanges>;
}
