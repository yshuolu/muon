import type { AppSnapshot, Task } from '../../shared/types';
import { currentSessionName, SESSION_LABELS, taskWorkflow } from '../../shared/workflows';

export type TaskTab = 'overview' | 'plan' | 'evidence' | 'files';

export function taskTabs(task: Task): TaskTab[] {
  if (task.kind === 'group') return ['overview'];
  if (taskWorkflow(task).kind === 'develop') return ['overview', 'plan', 'evidence', 'files'];
  const tabs: TaskTab[] = ['overview'];
  if (task.plans.length) tabs.push('plan');
  if (task.evidence.length) tabs.push('evidence');
  if (task.changedFiles.length) tabs.push('files');
  return tabs;
}

export function workflowProgress(task: Task) {
  const sessions = taskWorkflow(task).sessions;
  const currentName = currentSessionName(task);
  const current = sessions.findIndex(session => session.name === currentName);
  const hasSessionState = !!task.sessions?.length;
  return sessions.map((session, index) => {
    const state = task.sessions?.findLast(item => item.name === session.name);
    const waiting = session.name === 'plan' && task.phase === 'plan_review' && task.status === 'in_review';
    return {
      ...session,
      label: SESSION_LABELS[session.name],
      complete: !waiting && (hasSessionState ? state?.status === 'succeeded' : task.status === 'done' || current > index),
      active: task.status !== 'done' && task.phase !== 'idle' && current === index,
      waiting,
    };
  });
}

export function approvedPlanChoices(snapshot: AppSnapshot) {
  return snapshot.tasks.flatMap(task => {
    const plan = task.plans.at(-1);
    if (task.kind === 'group' || task.status === 'canceled' || task.workspaceId !== snapshot.scope.workspaceId || task.projectId !== snapshot.scope.projectId || task.ownerUserId !== snapshot.scope.userId || plan?.status !== 'approved' || snapshot.tasks.some(child => child.parentId === task.id)) return [];
    return [{ task, plan }];
  });
}
