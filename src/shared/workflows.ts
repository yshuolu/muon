import type { Task, TaskPhase } from './types';

export type WorkflowKind = 'brainstorm' | 'research' | 'develop';
export type SessionName = 'brainstorm' | 'research' | 'plan' | 'build' | 'verify';
export interface ApprovedPlanRef { taskId: string; planId: string }
export interface DevelopParams { approvedPlan?: ApprovedPlanRef }
export type WorkflowInput =
  | { kind: 'brainstorm' | 'research' }
  | { kind: 'develop'; params?: DevelopParams };

export interface SessionDefinition {
  id: string;
  name: SessionName;
}

export interface WorkflowDefinition {
  kind: WorkflowKind;
  version: 1;
  params?: DevelopParams;
  sessions: readonly SessionDefinition[];
}

/** A workflow is a sequence of agent sessions; owner review belongs to the task plane. */
export function defineWorkflow(input: WorkflowInput = { kind: 'develop' }): WorkflowDefinition {
  const names: SessionName[] = input.kind === 'develop'
    ? [...(input.params?.approvedPlan ? [] : ['plan' as const]), 'build', 'verify']
    : [input.kind];
  return {
    kind: input.kind,
    version: 1,
    ...(input.kind === 'develop' && input.params?.approvedPlan
      ? { params: { approvedPlan: { ...input.params.approvedPlan } } }
      : {}),
    sessions: names.map(name => ({ id: name, name })),
  };
}

/** Records written before workflows existed use the original Develop sequence. */
export function taskWorkflow(task: Pick<Task, 'workflow'>): WorkflowDefinition {
  return task.workflow ?? defineWorkflow();
}

export function sessionPhase(name: SessionName): TaskPhase {
  const phases = {
    brainstorm: 'brainstorming', research: 'researching', plan: 'planning',
    build: 'building', verify: 'verification',
  } as const;
  return phases[name];
}

export function currentSessionName(task: Pick<Task, 'phase' | 'workflow' | 'sessions' | 'currentSessionId'>): SessionName {
  const current = task.sessions?.find(session => session.id === task.currentSessionId);
  if (current) return current.name;
  if (task.phase === 'planning' || task.phase === 'plan_review') return 'plan';
  if (task.phase === 'building') return 'build';
  if (task.phase === 'verification') return 'verify';
  if (task.phase === 'brainstorming') return 'brainstorm';
  if (task.phase === 'researching') return 'research';
  const sessions = taskWorkflow(task).sessions;
  return (task.phase === 'complete' ? sessions.at(-1) : sessions[0])!.name;
}

export const SESSION_LABELS: Record<SessionName, string> = {
  brainstorm: 'Brainstorm', research: 'Research', plan: 'Plan', build: 'Build', verify: 'Verify',
};
export const WORKFLOW_LABELS: Record<WorkflowKind, string> = {
  brainstorm: 'Brainstorm', research: 'Research', develop: 'Develop',
};
