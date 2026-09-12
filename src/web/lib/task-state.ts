import type { AppSnapshot, Task } from '../../shared/types';

export function queueReasons(task: Task, snapshot: AppSnapshot): string[] {
  if (task.kind === 'group' && !['done', 'canceled'].includes(task.status)) {
    const children = snapshot.tasks.filter(item => item.parentId === task.id);
    if (!children.length) return ['Add subtasks to define this group’s work'];
    const canceled = children.filter(item => item.status === 'canceled');
    if (canceled.length) return [`${canceled.length} canceled subtask${canceled.length === 1 ? '' : 's'} require a scope decision. Open them and remove them from this group if they are no longer in scope.`];
    const reasons = [`${children.filter(item => item.status === 'done').length} of ${children.length} subtasks completed`];
    const blockers = task.blockedByIds.map(id => snapshot.tasks.find(item => item.id === id)).filter(item => item?.status !== 'done');
    if (blockers.length) reasons.push(`Waiting for ${blockers.map(item => item?.identifier ?? 'an unavailable dependency').join(', ')}`);
    return reasons;
  }
  if (task.status !== 'todo') return [];
  const reasons: string[] = [];
  const blockers = task.blockedByIds.map(id => snapshot.tasks.find(item => item.id === id)).filter(item => item?.status !== 'done');
  if (blockers.length) reasons.push(`Waiting for ${blockers.map(item => item ? `${item.identifier}${item.status === 'canceled' ? ' (canceled)' : ''}` : 'an unavailable dependency').join(', ')}`);
  const children = snapshot.tasks.filter(item => item.parentId === task.id && !['done', 'canceled'].includes(item.status));
  if (children.length) reasons.push(`Waiting for ${children.length} unfinished subtask${children.length === 1 ? '' : 's'}`);
  const canceledChildren = snapshot.tasks.filter(item => item.parentId === task.id && item.status === 'canceled');
  if (canceledChildren.length) reasons.push(`${canceledChildren.length} canceled subtask${canceledChildren.length === 1 ? '' : 's'} require a scope decision. Open them and remove them from this parent if they are no longer in scope.`);
  if (!snapshot.project.repositoryPath) reasons.push('Choose a repository in Settings');
  if (!snapshot.runtime.providers[task.provider]) reasons.push(`${task.provider === 'claude' ? 'Claude Code' : 'Codex'} is not installed or not on the server’s path`);
  if (!snapshot.settings.dispatcherEnabled) reasons.push('Automatic dispatch is paused');
  if (snapshot.runtime.activeRuns >= snapshot.settings.maxConcurrentAgents) reasons.push('All agent slots are occupied');
  if (!reasons.length) reasons.push(task.phase === 'building' ? 'Plan approved · Build is next in the queue' : task.phase === 'verification' ? 'Verification is next in the queue' : 'Ready for planning · Waiting for dispatch');
  return reasons;
}

export function relationCandidates(tasks: Task[], currentId?: string, parentId?: string | null) {
  const excluded = new Set([currentId, parentId].filter(Boolean));
  // A child cannot wait on its ancestors: parents already wait on their children.
  let ancestor = tasks.find(task => task.id === parentId);
  while (ancestor && !excluded.has(ancestor.parentId ?? '')) {
    if (ancestor.parentId) excluded.add(ancestor.parentId);
    ancestor = tasks.find(task => task.id === ancestor?.parentId);
  }
  return tasks.filter(task => !excluded.has(task.id));
}
