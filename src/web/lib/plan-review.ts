import type { Plan, Task } from '../../shared/domain';

export function displayedPlan(plans: Plan[], selectedId: string | null) {
  return plans.find(plan => plan.id === selectedId) ?? plans.at(-1);
}

export function planReviewState(task: Task, viewedPlanId: string, userId: string, options: { busy?: boolean; submittedPlanId?: string | null; hasDraft?: boolean } = {}) {
  const latest = task.plans.at(-1);
  const isLatest = latest?.id === viewedPlanId;
  const isOwner = task.ownerUserId === userId;
  const locallyQueued = options.submittedPlanId === latest?.id && task.phase === 'plan_review';
  const revising = task.phase === 'planning' && ['todo', 'in_progress'].includes(task.status);
  const reviewable = task.status === 'in_review' && task.phase === 'plan_review' && latest?.status === 'pending' && !locallyQueued;
  return {
    latest, isLatest, isOwner, revising: revising || locallyQueued,
    queued: task.status === 'todo' && revising || locallyQueued,
    canComment: Boolean(isOwner && isLatest && reviewable && !options.busy),
    canApprove: Boolean(isOwner && isLatest && reviewable && !options.busy && !options.hasDraft),
  };
}
