import type { WorkspaceChanges } from '../runtime/contracts';
import type { SessionInput } from '../runtime/contracts';
import type { ApprovedPlanRef, SessionName, WorkflowDefinition, WorkflowInput } from './workflows';

export type Provider = 'claude' | 'codex';
export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked' | 'canceled';
export type TaskPhase = 'idle' | 'planning' | 'plan_review' | 'building' | 'verification' | 'brainstorming' | 'researching' | 'complete';
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
  resultInputs?: ResultInput[];
  source?: ApprovedPlanRef;
  baseCommit?: string;
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
export interface SessionAttempt {
  id: string; phase: 'planning' | 'building' | 'verification' | 'brainstorming' | 'researching'; provider: Provider;
  status: 'running' | 'succeeded' | 'failed' | 'canceled'; startedAt: string;
  finishedAt?: string; sessionId?: string; error?: string; planId?: string;
  agentSessionId?: string; sessionName?: SessionName; providerSessionId?: string;
  input?: SessionInput; inputDigest?: string;
}
/** Compatibility name for the existing REST runs resource. */
export type AgentRun = SessionAttempt;
export interface AgentSession {
  id: string; name: SessionName;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled';
  providerSessionId?: string;
  input?: SessionInput;
  inputDigest?: string;
}
export interface SessionOutput {
  id: string; sessionId: string; runId: string; kind: 'ideas' | 'report';
  content: string; format: 'markdown'; createdAt: string;
}
export interface ResultInput {
  taskId: string; identifier: string; summary: string; outputs: SessionOutput[];
  sha256: string; capturedAt: string;
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
  workflow?: WorkflowDefinition;
  sessions?: AgentSession[];
  activeSessionId?: string;
  currentSessionId?: string;
  sessionSystemPrompt?: string;
  outputs?: SessionOutput[];
  planDiscussion?: PlanDiscussionMessage[];
  kind?: 'coding' | 'group';
  recovery?: { mode: 'retry' | 'resume' | 'fix' | 'replan'; feedback: string; requestedAt: string };
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
export interface PlanningChatMessage { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }
export interface PlanningChat { id: string; messages: PlanningChatMessage[]; createdAt: string; updatedAt: string; busy: boolean; activity?: string | null; error?: string }
export interface AgentRuntimeConfig { model: string; thinking: string; bypassPermissions: boolean }
export interface AppSnapshot {
  scope: Scope; project: Project; settings: Settings; tasks: Task[];
  attention: Attention[]; messages: ChiefMessage[];
  runtime: { activeRuns: number; chiefRunning: boolean; chiefActivity?: string | null; providers: Record<Provider, boolean>; config?: Record<Provider, AgentRuntimeConfig>; demo: boolean };
}
export interface CreateTaskInput {
  title: string; description?: string; provider?: Provider; priority?: Priority;
  status?: 'backlog' | 'todo'; labels?: string[]; parentId?: string | null; blockedByIds?: string[];
  kind?: 'coding' | 'group';
  workflow?: WorkflowInput;
}
export interface RetryTaskInput { mode?: 'retry' | 'resume' | 'fix' | 'replan'; feedback?: string }
export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog', todo: 'Todo', in_progress: 'In progress', in_review: 'In review',
  done: 'Done', blocked: 'Blocked', canceled: 'Canceled',
};
export const PHASE_LABELS: Record<TaskPhase, string> = {
  idle: 'Queued', planning: 'Planning', plan_review: 'Plan review', building: 'Building',
  verification: 'Verification', brainstorming: 'Brainstorming', researching: 'Researching', complete: 'Complete',
};
export const PRIORITY_LABELS: Record<Priority, string> = { 0: 'No priority', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };
