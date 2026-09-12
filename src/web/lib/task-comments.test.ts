import { describe, expect, it } from 'vitest';
import type { Task } from '../../shared/types';
import { taskCommentState } from './task-comments';

const task: Task = {
  id: 'task', identifier: 'MUO-1', workspaceId: 'workspace', projectId: 'project', ownerUserId: 'owner',
  title: 'Task conversation', description: '', status: 'done', phase: 'complete', priority: 0, provider: 'claude',
  labels: [], parentId: null, blockedByIds: [], plans: [], evidence: [], changedFiles: [], activity: [], summary: 'Verified result',
  createdAt: '2026-09-12T10:00:00Z', updatedAt: '2026-09-12T10:00:00Z', version: 1, sessionId: 'saved-session',
};

describe('task comments', () => {
  it('allows owner follow-ups during running, blocked, and completed work without reopening the task', () => {
    for (const status of ['in_progress', 'in_review', 'blocked', 'done'] as const) {
      const current = { ...task, status };
      expect(taskCommentState(current, 'owner', true).canComment).toBe(true);
      expect(current.status).toBe(status);
    }
  });

  it('keeps canceled tasks, task groups, other viewers, and in-flight submissions read-only', () => {
    expect(taskCommentState({ ...task, status: 'canceled' }, 'owner', true).canComment).toBe(false);
    expect(taskCommentState({ ...task, kind: 'group' }, 'owner', true).canComment).toBe(false);
    expect(taskCommentState(task, 'another-user', true).canComment).toBe(false);
    expect(taskCommentState(task, 'owner', true, true).canComment).toBe(false);
  });

  it('explains when an unstarted task retains comments until its first planning run', () => {
    const current: Task = { ...task, sessionId: undefined, status: 'backlog', phase: 'idle', followUp: { status: 'queued', commentIds: ['comment'], mode: 'message' } };
    const state = taskCommentState(current, 'owner', true);
    expect(state.canComment).toBe(true);
    expect(state.waitingForStart).toBe(true);
    expect(state.statusLabel).toBe('Saved for planning');
    expect(current.status).toBe('backlog');
    expect(taskCommentState({ ...current, runId: 'planning-run', status: 'in_progress', phase: 'planning' }, 'owner', true).waitingForStart).toBe(false);
  });

  it('keeps comments open while showing a paused queue, interruption, or response', () => {
    const queued: Task = { ...task, followUp: { status: 'queued', commentIds: ['comment'], mode: 'message' } };
    expect(taskCommentState(queued, 'owner', false).statusLabel).toBe('Reply queued · Dispatch paused');
    for (const status of ['queued', 'interrupting', 'responding'] as const) {
      const state = taskCommentState({ ...queued, followUp: { status, commentIds: ['comment'], mode: 'message' } }, 'owner', true);
      expect(state.canComment).toBe(true);
      expect(state.canRetry).toBe(false);
      expect(state.statusLabel).toBeTruthy();
    }
  });

  it('offers failed-reply recovery only to the owner while preserving the error', () => {
    const failed: Task = { ...task, followUp: { status: 'failed', commentIds: ['comment'], mode: 'message', error: 'Sign in and retry the reply.' } };
    expect(taskCommentState(failed, 'owner', true)).toMatchObject({ canRetry: true, statusLabel: 'Reply needs attention', statusDescription: 'Sign in and retry the reply.' });
    expect(taskCommentState(failed, 'another-user', true).canRetry).toBe(false);
    expect(taskCommentState({ ...failed, status: 'canceled' }, 'owner', true).canRetry).toBe(false);
    expect(taskCommentState(failed, 'owner', true, true).canRetry).toBe(false);
  });

  it('makes the renewed approval gate clear while the agent revises an RFC', () => {
    const state = taskCommentState({ ...task, followUp: { status: 'responding', commentIds: ['comment'], mode: 'replan' } }, 'owner', true);
    expect(state.statusLabel).toBe('Revising the RFC');
    expect(state.statusDescription).toContain('new RFC for your approval');
  });
});
