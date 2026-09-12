import { describe, expect, it } from 'vitest';
import type { Plan, Task } from '../../shared/types';
import { displayedPlan, planReviewState } from './plan-review';

const first: Plan = { id: 'rfc-1', version: 1, format: 'markdown', content: '# Initial RFC', status: 'changes_requested', createdAt: '2026-09-08T10:00:00Z' };
const second: Plan = { id: 'rfc-2', version: 2, format: 'markdown', content: '# Revised RFC', status: 'pending', createdAt: '2026-09-08T10:05:00Z' };
const review: Task = { id: 'task', identifier: 'MUO-1', workspaceId: 'w', projectId: 'p', ownerUserId: 'owner', title: 'Review task', description: '', status: 'in_review', phase: 'plan_review', priority: 0, provider: 'claude', labels: [], parentId: null, blockedByIds: [], plans: [first, second], evidence: [], changedFiles: [], activity: [], summary: '', createdAt: first.createdAt, updatedAt: second.createdAt, version: 3 };

describe('plan conversation review state', () => {
  it('follows new RFCs by default while preserving an intentionally selected historical version', () => {
    expect(displayedPlan([first], null)?.id).toBe(first.id);
    expect(displayedPlan([first, second], null)?.id).toBe(second.id);
    expect(displayedPlan([first, second], first.id)?.id).toBe(first.id);
    expect(displayedPlan([first, second], 'missing')?.id).toBe(second.id);
  });
  it('never sends comments or approvals against a historical RFC', () => {
    const state = planReviewState(review, first.id, 'owner');
    expect(state.isLatest).toBe(false);
    expect(state.canComment).toBe(false);
    expect(state.canApprove).toBe(false);
  });
  it('closes the approval and posting window immediately after an accepted comment, before polling updates arrive', () => {
    const state = planReviewState(review, second.id, 'owner', { submittedPlanId: second.id });
    expect(state.revising).toBe(true);
    expect(state.queued).toBe(true);
    expect(state.canComment).toBe(false);
    expect(state.canApprove).toBe(false);
  });
  it('keeps discussion paused during queued and active revisions, then permits another turn on the new RFC', () => {
    for (const status of ['todo', 'in_progress'] as const) {
      const state = planReviewState({ ...review, phase: 'planning', status }, second.id, 'owner');
      expect(state.revising).toBe(true);
      expect(state.canComment).toBe(false);
      expect(state.canApprove).toBe(false);
    }
    const revised = { ...second, id: 'rfc-3', version: 3 };
    const state = planReviewState({ ...review, plans: [first, second, revised] }, revised.id, 'owner', { submittedPlanId: second.id });
    expect(state.canComment).toBe(true);
    expect(state.canApprove).toBe(true);
  });
  it('allows a draft to be sent but prevents approval from silently discarding it', () => {
    const state = planReviewState(review, second.id, 'owner', { hasDraft: true });
    expect(state.canComment).toBe(true);
    expect(state.canApprove).toBe(false);
  });
  it('waits for pending or failed task replies before permitting RFC decisions', () => {
    for (const status of ['queued', 'interrupting', 'responding', 'failed'] as const) {
      const state = planReviewState({ ...review, followUp: { status, commentIds: ['comment'], mode: 'message' } }, second.id, 'owner');
      expect(state.discussing).toBe(true);
      expect(state.canComment).toBe(false);
      expect(state.canApprove).toBe(false);
    }
    expect(planReviewState(review, second.id, 'owner').canApprove).toBe(true);
  });
  it('restricts decisions to the owner and never reopens an already approved plan', () => {
    expect(planReviewState(review, second.id, 'another-user').canComment).toBe(false);
    expect(planReviewState(review, second.id, 'another-user').canApprove).toBe(false);
    const approved = { ...review, status: 'todo' as const, phase: 'building' as const, plans: [first, { ...second, status: 'approved' as const }] };
    expect(planReviewState(approved, second.id, 'owner').canComment).toBe(false);
    expect(planReviewState(approved, second.id, 'owner').canApprove).toBe(false);
  });
});
