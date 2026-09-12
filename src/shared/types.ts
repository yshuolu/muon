import type { WorkspaceChanges } from '../runtime/contracts';

export type Provider = 'claude' | 'codex';
export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked' | 'canceled';
export type TaskPhase = 'idle' | 'planning' | 'plan_review' | 'building' | 'verification' | 'complete';
export type Priority = 0 | 1 | 2 | 3 | 4;
export interface Scope { workspaceId: string; projectId: string; userId: string }
export interface DependencyInput {
  taskId: string; identifier: string; title: string; capturedAt: string;
  changes: WorkspaceChanges;
}
export interface Plan {
  id: string; version: number; format: 'markdown' | 'html'; content: string;
  status: 'pending' | 'approved' | 'changes_requested'; createdAt: string;
  reviewedAt?: string; reviewedBy?: string; feedback?: string;
  dependencyInputs?: DependencyInput[];
}
export interface PlanDiscussionMessage {
  id: string; role: 'user' | 'assistant'; content: string; createdAt: string;
  /** The RFC being discussed by the owner, or the new RFC returned with an agent reply. */
  planId: string;
  userId?: string;
}
export interface Evidence {
  id: string; kind: 'test' | 'screenshot' | 'recording' | 'note'; title: string;
  description: string; result?: 'passed' | 'failed' | 'skipped';
  steps?: string[]; artifactUrl?: string; createdAt: string;
  runId?: string;
}
export interface ChangedFile { path: string; status: string; additions: number; deletions: number }
export interface Activity { id: string; text: string; createdAt: string }
export interface AgentRun {
  id: string; phase: 'planning' | 'building' | 'verification'; provider: Provider;
  status: 'running' | 'succeeded' | 'failed' | 'canceled'; startedAt: string;
  finishedAt?: string; sessionId?: string; error?: string; planId?: string;
}
export interface Task {
  id: string; identifier: string; workspaceId: string; projectId: string; ownerUserId: string;
  title: string; description: string; status: TaskStatus; phase: TaskPhase;
  priority: Priority; provider: Provider; labels: string[]; parentId: string | null;
  blockedByIds: string[]; plans: Plan[]; evidence: Evidence[]; changedFiles: ChangedFile[];
  activity: Activity[]; summary: string; createdAt: string; updatedAt: string;
  completedAt?: string; version: number; runId?: string; sessionId?: string;
  worktree?: { path: string; branch: string; baseCommit: string };
  error?: string;
  runs?: AgentRun[];
  planDiscussion?: PlanDiscussionMessage[];
  kind?: 'coding' | 'group';
  recovery?: { mode: 'retry' | 'fix' | 'replan'; feedback: string; requestedAt: string };
}
export interface Attention {
  id: string; taskId: string; kind: 'plan_approval' | 'completed' | 'project_completed' | 'blocked';
  title: string; description: string; createdAt: string; readAt?: string;
}
export interface Project {
  id: string; workspaceId: string; name: string; identifier: string;
  repositoryPath: string; ownerUserId: string;
}
export interface Settings { maxConcurrentAgents: number; dispatcherEnabled: boolean; defaultProvider: Provider }
export interface ChiefMessage { id: string; role: 'user' | 'assistant'; content: string; createdAt: string; taskIds?: string[] }
export interface AgentRuntimeConfig { model: string; thinking: string }
export interface AppSnapshot {
  scope: Scope; project: Project; settings: Settings; tasks: Task[];
  attention: Attention[]; messages: ChiefMessage[];
  runtime: { activeRuns: number; chiefRunning: boolean; chiefActivity?: string | null; providers: Record<Provider, boolean>; config?: Record<Provider, AgentRuntimeConfig>; demo: boolean };
}
export interface CreateTaskInput {
  title: string; description?: string; provider?: Provider; priority?: Priority;
  status?: 'backlog' | 'todo'; labels?: string[]; parentId?: string | null; blockedByIds?: string[];
  kind?: 'coding' | 'group';
}
export interface RetryTaskInput { mode?: 'retry' | 'fix' | 'replan'; feedback?: string }
export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog', todo: 'Todo', in_progress: 'In progress', in_review: 'In review',
  done: 'Done', blocked: 'Blocked', canceled: 'Canceled',
};
export const PHASE_LABELS: Record<TaskPhase, string> = {
  idle: 'Queued', planning: 'Planning', plan_review: 'Plan review', building: 'Building',
  verification: 'Verification', complete: 'Complete',
};
export const PRIORITY_LABELS: Record<Priority, string> = { 0: 'No priority', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };
