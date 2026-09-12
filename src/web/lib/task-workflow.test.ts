import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AppSnapshot, Task } from '../../shared/types';
import { defineWorkflow } from '../../shared/workflows';
import { TaskDetail } from '../components/task-detail';
import { TaskRecovery } from '../components/task-recovery';
import { WorkflowRail } from '../components/workflow-rail';
import { approvedPlanChoices, taskTabs, workflowProgress } from './task-workflow';
import { queueReasons } from './task-state';

function task(overrides: Partial<Task> = {}): Task {
  return { id: 'task', identifier: 'MUO-1', workspaceId: 'w', projectId: 'p', ownerUserId: 'u', title: 'Task', description: '', status: 'todo', phase: 'idle', priority: 0, provider: 'claude', labels: [], parentId: null, blockedByIds: [], plans: [], evidence: [], changedFiles: [], activity: [], summary: '', createdAt: '2026-09-11T10:00:00Z', updatedAt: '2026-09-11T10:00:00Z', version: 1, ...overrides };
}

function snapshot(tasks: Task[]): AppSnapshot {
  return { scope: { workspaceId: 'w', projectId: 'p', userId: 'u' }, project: { id: 'p', workspaceId: 'w', ownerUserId: 'u', name: 'Project', identifier: 'MUO', repositoryPath: '' }, settings: { defaultProvider: 'claude', dispatcherEnabled: true, maxConcurrentAgents: 2 }, tasks, attention: [], messages: [], runtime: { activeRuns: 0, chiefRunning: false, providers: { claude: true, codex: true }, demo: false } };
}

describe('workflow presentation', () => {
  it.each(['brainstorm', 'research'] as const)('lets %s queue without a repository and keeps coding placeholders out of its tabs', kind => {
    const current = task({ workflow: defineWorkflow({ kind }) });
    expect(queueReasons(current, snapshot([current]))).toEqual([`Ready to ${kind} · Waiting for dispatch`]);
    expect(taskTabs(current)).toEqual(['overview']);
    expect(queueReasons(task(), snapshot([]))).toContain('Choose a repository in Settings');
  });

  it('preserves noncoding evidence when a task has actual records', () => {
    const current = task({ workflow: defineWorkflow({ kind: 'research' }), evidence: [{ id: 'note', kind: 'note', title: 'Source', description: 'Relevant material', createdAt: '2026-09-11T10:00:00Z' }] });
    expect(taskTabs(current)).toEqual(['overview', 'evidence']);
  });

  it('renders approval as a wait within Plan, with no separate review session', () => {
    const current = task({ status: 'in_review', phase: 'plan_review' });
    const progress = workflowProgress(current);
    expect(progress.map(session => session.name)).toEqual(['plan', 'build', 'verify']);
    expect(progress[0]).toMatchObject({ waiting: true, active: true, complete: false });
    const markup = renderToStaticMarkup(createElement(WorkflowRail, { task: current }));
    expect(markup.match(/class="workflow-step /g)).toHaveLength(3);
    expect(markup).toContain('Awaiting your approval');
  });

  it('omits Plan for an approved-plan Develop workflow', () => {
    const current = task({ workflow: defineWorkflow({ kind: 'develop', params: { approvedPlan: { taskId: 'source', planId: 'approved' } } }), phase: 'building' });
    expect(workflowProgress(current).map(session => session.name)).toEqual(['build', 'verify']);
  });

  it('uses current session state after remediation rather than earlier success', () => {
    const current = task({ workflow: defineWorkflow(), status: 'in_progress', phase: 'building', currentSessionId: 'build-2', sessions: [
      { id: 'plan', name: 'plan', status: 'succeeded' },
      { id: 'build', name: 'build', status: 'succeeded' },
      { id: 'verify', name: 'verify', status: 'succeeded' },
      { id: 'build-2', name: 'build', status: 'running' },
      { id: 'verify-2', name: 'verify', status: 'pending' },
    ] });
    expect(workflowProgress(current).map(session => [session.name, session.complete, session.active])).toEqual([
      ['plan', true, false], ['build', false, true], ['verify', false, false],
    ]);
  });

  it('shows a saved research output in Overview without claiming verification', () => {
    const current = task({ status: 'done', phase: 'complete', workflow: defineWorkflow({ kind: 'research' }), summary: 'Short summary', outputs: [{ id: 'report', sessionId: 'research', runId: 'run', kind: 'report', content: 'Durable research findings with sources.', format: 'markdown', createdAt: '2026-09-11T10:00:00Z' }] });
    const markup = renderToStaticMarkup(createElement(TaskDetail, { task: current, snapshot: snapshot([current]), onClose: () => {}, onRefresh: () => {}, onSelect: () => {}, onSubtask: () => {}, backLabel: 'All tasks' }));
    expect(markup).toContain('Durable research findings with sources.');
    expect(markup).toContain('Outcome saved');
    expect(markup).not.toContain('Verification complete');
    expect(markup).not.toContain('id="tab-plan"');
    expect(markup).not.toContain('id="tab-evidence"');
    expect(markup).not.toContain('id="tab-files"');
  });

  it('offers noncoding recovery without fix or replan and uses the current provider session', () => {
    const current = task({ status: 'blocked', phase: 'researching', workflow: defineWorkflow({ kind: 'research' }), currentSessionId: 'research', sessionId: 'stale', sessions: [{ id: 'research', name: 'research', status: 'failed' }] });
    const markup = renderToStaticMarkup(createElement(TaskRecovery, { task: current, busy: false, onRetry: async () => true }));
    expect(markup).toContain('value="retry"');
    expect(markup).not.toContain('value="fix"');
    expect(markup).not.toContain('value="replan"');
    expect(markup).not.toContain('value="resume"');
  });
});

describe('approved-plan choices', () => {
  it('offers current owner approvals with reusable scope only', () => {
    const source = task({ plans: [{ id: 'approved', version: 1, format: 'markdown', content: '# Approved scope', status: 'approved', createdAt: '2026-09-11T10:00:00Z' }] });
    const stale = task({ ...source, id: 'stale', plans: [...source.plans, { ...source.plans[0], id: 'pending', version: 2, status: 'pending' }] });
    const anotherOwner = task({ ...source, id: 'other-owner', ownerUserId: 'other' });
    const anotherProject = task({ ...source, id: 'other-project', projectId: 'other' });
    const parent = task({ ...source, id: 'parent' });
    const child = task({ id: 'child', parentId: parent.id });
    expect(approvedPlanChoices(snapshot([source, stale, anotherOwner, anotherProject, parent, child])).map(choice => choice.task.id)).toEqual([source.id]);
  });
});
