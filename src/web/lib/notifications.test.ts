import { describe, expect, it } from 'vitest';
import type { AppSnapshot, Task } from '../../shared/types';
import { snapshotNotifications } from './notifications';

function task(overrides: Partial<Task> & Pick<Task, 'id' | 'identifier'>): Task {
  return { workspaceId: 'w', projectId: 'p', ownerUserId: 'u', title: 'Task', description: '', status: 'todo', phase: 'idle', priority: 0, provider: 'claude', labels: [], parentId: null, blockedByIds: [], plans: [], evidence: [], changedFiles: [], activity: [], summary: '', createdAt: '2026-09-24T10:00:00Z', updatedAt: '2026-09-24T10:00:00Z', version: 1, ...overrides };
}
function snapshot(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return { scope: { workspaceId: 'w', projectId: 'p', userId: 'u' }, project: { id: 'p', workspaceId: 'w', ownerUserId: 'u', name: 'Project', identifier: 'MUO', repositoryPath: '/repo' }, settings: { defaultProvider: 'claude', dispatcherEnabled: true, maxConcurrentAgents: 2 }, tasks: [], attention: [], messages: [], runtime: { activeRuns: 0, chiefRunning: false, providers: { claude: true, codex: true }, demo: false }, ...overrides };
}
const at = '2026-09-24T10:05:00Z';

describe('snapshot notifications', () => {
  it('announces nothing for the first snapshot or after switching projects', () => {
    const next = snapshot({ attention: [{ id: 'a1', taskId: 't1', kind: 'completed', title: 'Done', description: '', createdAt: at }] });
    expect(snapshotNotifications(null, next)).toEqual([]);
    const other = snapshot({ project: { id: 'other', workspaceId: 'w', ownerUserId: 'u', name: 'Other', identifier: 'OTH', repositoryPath: '/other' } });
    expect(snapshotNotifications(other, next)).toEqual([]);
  });

  it('notifies once per new attention record with the task label', () => {
    const done = task({ id: 't1', identifier: 'MUO-1', title: 'Ship it', status: 'done' });
    const previous = snapshot({ tasks: [done], attention: [{ id: 'old', taskId: 't1', kind: 'plan_approval', title: 'Old', description: '', createdAt: at }] });
    const next = snapshot({ tasks: [done], attention: [...previous.attention,
      { id: 'a-done', taskId: 't1', kind: 'completed', title: 'Ship it', description: '', createdAt: at },
      { id: 'a-blocked', taskId: 't1', kind: 'blocked', title: 'Ship it', description: '', createdAt: at },
      { id: 'a-project', taskId: 't1', kind: 'project_completed', title: 'Project is complete', description: '', createdAt: at },
    ] });
    expect(snapshotNotifications(previous, next)).toEqual([
      { kind: 'completed', title: 'Task done', body: 'MUO-1 · Ship it', tag: 'attention:a-done', taskId: 't1' },
      { kind: 'blocked', title: 'A task needs your help', body: 'MUO-1 · Ship it', tag: 'attention:a-blocked', taskId: 't1' },
      { kind: 'project_completed', title: 'Project complete', body: 'Project is complete', tag: 'attention:a-project', taskId: 't1' },
    ]);
    expect(snapshotNotifications(next, next)).toEqual([]);
  });

  it('notifies for new assistant replies from the chief, task comments, and RFC discussions only', () => {
    const before = task({ id: 't1', identifier: 'MUO-1', title: 'Ship it', comments: [{ id: 'c1', role: 'user', content: 'Hi', createdAt: at }], planDiscussion: [] });
    const after = task({ ...before, comments: [...before.comments!, { id: 'c2', role: 'assistant', content: 'A long reply '.repeat(20), createdAt: at }], planDiscussion: [{ id: 'd1', role: 'user', content: 'Change it', createdAt: at, planId: 'p1' }, { id: 'd2', role: 'assistant', content: 'Revised', createdAt: at, planId: 'p2' }] });
    const previous = snapshot({ tasks: [before], messages: [{ id: 'm1', role: 'user', content: 'Plan the week', createdAt: at }] });
    const next = snapshot({ tasks: [after, task({ id: 'new', identifier: 'MUO-2', comments: [{ id: 'c9', role: 'assistant', content: 'Unknown task', createdAt: at }] })], messages: [...previous.messages, { id: 'm2', role: 'assistant', content: 'Here is the plan.', createdAt: at }, { id: 'm3', role: 'user', content: 'Thanks', createdAt: at }] });
    const notifications = snapshotNotifications(previous, next);
    expect(notifications.map(item => item.tag)).toEqual(['chief:m2', 'comment:c2', 'discussion:d2']);
    expect(notifications[0]).toMatchObject({ kind: 'chief', title: 'Chief of staff replied', body: 'Here is the plan.' });
    expect(notifications[1].body.length).toBeLessThanOrEqual(110);
    expect(notifications[1].body.startsWith('MUO-1 · A long reply')).toBe(true);
    expect(notifications[2]).toMatchObject({ kind: 'discussion', taskId: 't1', body: 'MUO-1 · Ship it' });
  });
});
