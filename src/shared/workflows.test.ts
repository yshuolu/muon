import { describe, expect, it } from 'vitest';
import { currentSessionName, defineWorkflow, taskWorkflow } from './workflows';

describe('workflow composition', () => {
  it('keeps the Develop workflow identity when an approved plan removes planning', () => {
    const standard = defineWorkflow({ kind: 'develop' });
    const approvedPlan = { taskId: 'task-1', planId: 'approved-v1' };
    const reused = defineWorkflow({ kind: 'develop', params: { approvedPlan } });
    expect(standard.sessions.map(session => session.name)).toEqual(['plan', 'build', 'verify']);
    expect(reused).toMatchObject({ kind: standard.kind, version: standard.version, params: { approvedPlan } });
    expect(reused.sessions.map(session => session.name)).toEqual(['build', 'verify']);
    approvedPlan.planId = 'later-v2';
    expect(reused.params?.approvedPlan?.planId).toBe('approved-v1');
  });

  it('gives Brainstorm and Research their own single-session workflows', () => {
    expect(defineWorkflow({ kind: 'brainstorm' }).sessions).toEqual([{ id: 'brainstorm', name: 'brainstorm' }]);
    expect(defineWorkflow({ kind: 'research' }).sessions).toEqual([{ id: 'research', name: 'research' }]);
  });

  it('preserves the Develop sequence and phase selection for legacy task records', () => {
    expect(taskWorkflow({})).toEqual(defineWorkflow({ kind: 'develop' }));
    expect(currentSessionName({ phase: 'idle' })).toBe('plan');
    expect(currentSessionName({ phase: 'plan_review' })).toBe('plan');
    expect(currentSessionName({ phase: 'building' })).toBe('build');
    expect(currentSessionName({ phase: 'verification' })).toBe('verify');
    expect(currentSessionName({ phase: 'complete' })).toBe('verify');
  });

  it('selects the actual configured session for active and unstarted tasks', () => {
    const workflow = defineWorkflow({ kind: 'develop', params: { approvedPlan: { taskId: 'task-1', planId: 'plan-1' } } });
    expect(currentSessionName({ phase: 'idle', workflow })).toBe('build');
    expect(currentSessionName({
      phase: 'idle', workflow, currentSessionId: 'verification-session',
      sessions: [{ id: 'verification-session', name: 'verify', status: 'pending' }],
    })).toBe('verify');
    expect(currentSessionName({ phase: 'complete', workflow: defineWorkflow({ kind: 'research' }) })).toBe('research');
  });
});
