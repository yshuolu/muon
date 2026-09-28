export type AgentProvider = 'claude' | 'codex';
export type AgentPhase = 'planning' | 'building' | 'verification' | 'chief' | 'chat' | 'discussion';

export interface ScratchFile { path: string; data: Uint8Array }

export interface AgentRequest {
  provider: AgentProvider;
  phase: AgentPhase;
  prompt: string;
  cwd: string;
  /** Overrides the configured Claude model for a chief or disposable chat request. */
  model?: string;
  /** Overrides the configured thinking effort for this run. */
  effort?: string;
  /** Read-only copies placed in an advisory session's scratch working directory before it starts, by relative path. */
  files?: ScratchFile[];
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

export interface TaskWorktree {
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

export interface WorktreeChanges {
  format: 'git-patch';
  baseCommit: string;
  headCommit: string;
  sha256: string;
  patchEncoding: 'utf8' | 'base64';
  patch: string;
  files: ChangedFile[];
}

export interface TaskCommit { sha: string; subject: string; authoredAt: string }

export interface IntegrationResult {
  /** The branch checked out in the owner's repository that now contains the task's commits. */
  branch: string;
  headBefore: string;
  headAfter: string;
  /** The task's commits as they now appear on that branch, oldest first. */
  commits: TaskCommit[];
}

export interface WorktreeProvider {
  validateRepository?(repositoryPath: string): Promise<void>;
  /** The task branch's own commits (not yet on the repository's checked-out branch), oldest first. */
  commits?(input: TaskWorktree): Promise<TaskCommit[]>;
  /**
   * Commits leftover work on the task branch, rebases the branch onto the repository's checked-out branch, and
   * fast-forwards that branch. Rejects, leaving everything as it was, when the checkout is dirty or detached or
   * the rebase conflicts.
   */
  integrate?(input: TaskWorktree & { message: string }): Promise<IntegrationResult>;
  /** Turns a plain folder into a repository with an initial commit of its current contents, at the owner's request. */
  initializeRepository?(repositoryPath: string): Promise<void>;
  ensure(input: { repositoryPath: string; taskId: string; baseRef?: string }): Promise<TaskWorktree>;
  changedFiles(input: { path: string; baseCommit: string }): Promise<ChangedFile[]>;
  exportChanges?(input: TaskWorktree & { maxBytes?: number }): Promise<WorktreeChanges>;
  materializeInputs?(worktree: TaskWorktree, inputs: Array<{ id: string; name: string; sha256: string; data: Uint8Array }>): Promise<Array<{ id: string; name: string; path: string }>>;
}
