import { describe, expect, it } from 'vitest';
import { createTaskSchema, editTaskSchema, listTasksQuerySchema } from './api-contract';

describe('workflow API contracts', () => {
  it('accepts the supported workflows and an exact approved-plan reference', () => {
    for (const kind of ['brainstorm', 'research', 'develop']) {
      expect(createTaskSchema.parse({ title: 'Task', workflow: { kind } }).workflow).toEqual({ kind });
    }
    const workflow = { kind: 'develop', params: { approvedPlan: { taskId: 'MUO-2', planId: 'plan-v1' } } };
    expect(createTaskSchema.parse({ title: 'Task', workflow }).workflow).toEqual(workflow);
    expect(listTasksQuerySchema.parse({ workflow: 'research' })).toEqual({ workflow: 'research' });
    expect(createTaskSchema.parse({ title: 'Legacy task' }).workflow).toBeUndefined();
  });

  it('rejects unsupported composition, invalid references, and workflow edits', () => {
    for (const workflow of [
      { kind: 'unknown' },
      { kind: 'research', params: { approvedPlan: { taskId: 'MUO-2', planId: 'plan-v1' } } },
      { kind: 'develop', params: { approvedPlan: { taskId: '', planId: 'plan-v1' } } },
      { kind: 'develop', params: { approvedPlan: { taskId: 'MUO-2', planId: '' } } },
      { kind: 'develop', sessions: [{ name: 'build' }] },
    ]) expect(createTaskSchema.safeParse({ title: 'Task', workflow }).success).toBe(false);
    expect(editTaskSchema.safeParse({ workflow: { kind: 'research' } }).success).toBe(false);
    expect(listTasksQuerySchema.safeParse({ workflow: 'unknown' }).success).toBe(false);
  });
});
