export type AgentProvider = 'claude' | 'codex';
export type AgentPhase = 'planning' | 'building' | 'verification' | 'chief' | 'chat' | 'discussion';

export interface AgentRequest {
  provider: AgentProvider;
  phase: AgentPhase;
  prompt: string;
  cwd: string;
  /** Overrides the configured Claude model for a chief or disposable chat request. */
  model?: string;
  /** Overrides the configured thinking effort for a disposable chat request, such as a document review. */
  effort?: string;
  sessionId?: string;
  signal?: AbortSignal;
  /** Reports the provider-confirmed session at most once, without waiting for a final result. */
  onSessionId?: (sessionId: string) => void;
  onProgress?: (message: string) => void;
  chiefCli?: { command: string; apiUrl: string; token: string };
}

export interface AgentResult {
  text: string;
  sessionId?: string;
}

export interface AgentAdapter {
  provider: AgentProvider;
  run(request: AgentRequest): Promise<AgentResult>;
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
  validateRepository?(repositoryPath: string): Promise<void>;
  /** Turns a plain folder into a repository with an initial commit of its current contents, at the owner's request. */
  initializeRepository?(repositoryPath: string): Promise<void>;
  ensure(input: { repositoryPath: string; taskId: string; baseRef?: string }): Promise<TaskWorkspace>;
  changedFiles(input: { path: string; baseCommit: string }): Promise<ChangedFile[]>;
  exportChanges?(input: TaskWorkspace & { maxBytes?: number }): Promise<WorkspaceChanges>;
  materializeInputs?(workspace: TaskWorkspace, inputs: Array<{ id: string; name: string; sha256: string; data: Uint8Array }>): Promise<Array<{ id: string; name: string; path: string }>>;
}
