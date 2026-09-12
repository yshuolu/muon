import type { Task } from '../../shared/types';

export function taskCommentState(task: Task, userId: string, dispatcherEnabled: boolean, busy = false) {
  const isOwner = task.ownerUserId === userId;
  const canComment = isOwner && task.kind !== 'group' && task.status !== 'canceled' && !busy;
  const waitingForStart = !task.sessionId && !task.runId && task.phase === 'idle';
  const followUp = task.followUp;
  const revising = followUp?.mode === 'replan';
  let statusLabel: string | undefined;
  let statusDescription: string | undefined;
  if (followUp?.status === 'queued') {
    statusLabel = waitingForStart ? 'Saved for planning' : `${revising ? 'Revision' : 'Reply'} queued${dispatcherEnabled ? '' : ' · Dispatch paused'}`;
    statusDescription = waitingForStart ? 'Your comments will be included when this task starts.' : 'Your comment is saved. The agent will respond here.';
  } else if (followUp?.status === 'interrupting') {
    statusLabel = 'Pausing the agent';
    statusDescription = 'Your comment is saved. The agent is stopping its current work before responding.';
  } else if (followUp?.status === 'responding') {
    statusLabel = revising ? 'Revising the RFC' : 'Agent is replying';
    statusDescription = revising ? 'The agent will reply here and prepare a new RFC for your approval in Plan.' : 'The reply will appear in this conversation.';
  } else if (followUp?.status === 'failed') {
    statusLabel = revising ? 'Revision needs attention' : 'Reply needs attention';
    statusDescription = followUp.error ?? 'The agent could not finish its reply. Your comment is saved.';
  }
  return { isOwner, canComment, waitingForStart, statusLabel, statusDescription, canRetry: canComment && followUp?.status === 'failed' };
}
