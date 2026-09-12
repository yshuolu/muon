import { describe, expect, it } from 'vitest';
import type { AppSnapshot, Evidence, Task } from '../../shared/types';
import { evidenceAttempts } from '../components/verification-evidence';
import { queueReasons, relationCandidates } from './task-state';

function task(overrides: Partial<Task> = {}): Task {
  return { id: 'task', identifier: 'MUO-1', workspaceId: 'w', projectId: 'p', ownerUserId: 'u', title: 'Task', description: '', status: 'todo', phase: 'idle', priority: 0, provider: 'claude', labels: [], parentId: null, blockedByIds: [], plans: [], evidence: [], changedFiles: [], activity: [], summary: '', createdAt: '2026-09-08T10:00:00Z', updatedAt: '2026-09-08T10:00:00Z', version: 1, ...overrides };
}
function snapshot(tasks: Task[]): AppSnapshot {
  return { scope: { workspaceId: 'w', projectId: 'p', userId: 'u' }, project: { id: 'p', workspaceId: 'w', ownerUserId: 'u', name: 'Project', identifier: 'MUO', repositoryPath: '/tmp/repo' }, settings: { defaultProvider: 'claude', dispatcherEnabled: true, maxConcurrentAgents: 2 }, tasks, attention: [], messages: [], runtime: { activeRuns: 0, chiefRunning: false, providers: { claude: true, codex: true }, demo: false } };
}
const evidence = (id: string, runId: string | undefined, result: Evidence['result'], createdAt = '2026-09-08T10:04:00Z'): Evidence => ({ id, runId, result, kind: 'test', title: id, description: '', createdAt });

describe('verification attempt presentation', () => {
  const runs: NonNullable<Task['runs']> = [{ id: 'first', phase: 'verification', provider: 'claude', status: 'failed', startedAt: '2026-09-08T10:01:00Z' }, { id: 'second', phase: 'verification', provider: 'claude', status: 'succeeded', startedAt: '2026-09-08T10:03:00Z' }];
  it('keeps an earlier failed result out of the completed task’s latest counts', () => {
    const attempts = evidenceAttempts(task({ status: 'done', runs, evidence: [evidence('failure', 'first', 'failed'), evidence('pass', 'second', 'passed')] }));
    expect(attempts.at(-1)?.items.map(item => item.result)).toEqual(['passed']);
    expect(attempts[0].items.map(item => item.result)).toEqual(['failed']);
  });
  it('does not reuse earlier success while a new verification is still running', () => {
    const attempts = evidenceAttempts(task({ runs: [...runs, { id: 'third', phase: 'verification', provider: 'claude', status: 'running', startedAt: '2026-09-08T10:05:00Z' }], evidence: [evidence('pass', 'second', 'passed')] }));
    expect(attempts.at(-1)?.status).toBe('running');
    expect(attempts.at(-1)?.items).toEqual([]);
  });
  it('uses timestamps for evidence saved before attempt IDs existed', () => {
    const attempts = evidenceAttempts(task({ runs, evidence: [evidence('old', undefined, 'failed', '2026-09-08T10:02:00Z'), evidence('new', undefined, 'passed')] }));
    expect(attempts[0].items[0].id).toBe('old');
    expect(attempts.at(-1)?.items[0].id).toBe('new');
  });
});

describe('queue explanations', () => {
  it('keeps canceled dependencies visible as blockers even when capacity is available', () => {
    const current = task({ blockedByIds: ['prerequisite'] });
    expect(queueReasons(current, snapshot([current, task({ id: 'prerequisite', identifier: 'MUO-2', status: 'canceled' })]))).toEqual(['Waiting for MUO-2 (canceled)']);
  });
  it('explains setup, pause, and occupied capacity independently', () => {
    const current = task(); const state = snapshot([current]);
    state.project.repositoryPath = ''; state.runtime.providers.claude = false;
    state.settings.dispatcherEnabled = false; state.runtime.activeRuns = 2;
    expect(queueReasons(current, state)).toHaveLength(4);
  });
  it('shows child progress for groups without suggesting an agent will run the group', () => {
    const group = task({ kind: 'group' }); const child = task({ id: 'child', parentId: group.id });
    const state = snapshot([group, child]); state.project.repositoryPath = ''; state.runtime.providers.claude = false;
    expect(queueReasons(group, state)).toEqual(['0 of 1 subtasks completed']);
  });
  it('excludes ancestors from a child’s dependency choices', () => {
    const grandparent = task({ id: 'grandparent' }); const parent = task({ id: 'parent', parentId: grandparent.id });
    const child = task({ id: 'child', parentId: parent.id }); const sibling = task({ id: 'sibling', parentId: parent.id });
    expect(relationCandidates([grandparent, parent, child, sibling], child.id, parent.id).map(item => item.id)).toEqual(['sibling']);
  });
});
