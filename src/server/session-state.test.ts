import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../runtime';
import type { Task } from '../shared/types';
import { defineWorkflow } from '../shared/workflows';
import { createSessions, initializeSessions } from './session-state';
import { SqliteRepository } from './sqlite-repository';
import { TaskService } from './task-service';

const scope = { workspaceId: 'workspace', projectId: 'project', userId: 'owner' };
const timestamp = '2026-09-11T00:00:00.000Z';
const task = (): Task => ({
  id: 'task', identifier: 'MUO-1', ...scope, ownerUserId: scope.userId,
  title: 'Investigate options', description: '', status: 'todo', phase: 'verification',
  provider: 'claude', priority: 0, parentId: null, blockedByIds: [], labels: [],
  plans: [], evidence: [], changedFiles: [], activity: [], summary: '',
  version: 1, createdAt: timestamp, updatedAt: timestamp,
});

describe('durable agent sessions', () => {
  it('does not transfer a legacy Build conversation to queued Verify', () => {
    const migrated = initializeSessions({
      ...task(), sessionId: 'build-provider-conversation',
      runs: [{ id: 'build-attempt', phase: 'building', provider: 'claude', status: 'succeeded', startedAt: timestamp, sessionId: 'build-provider-conversation' }],
    });
    const verify = migrated.sessions?.find(session => session.id === migrated.currentSessionId);
    expect(verify).toMatchObject({ name: 'verify', status: 'pending' });
    expect(verify?.providerSessionId).toBeUndefined();
    expect(migrated.sessionId).toBeUndefined();
    expect(migrated.runs?.[0]).toMatchObject({ sessionName: 'build', providerSessionId: 'build-provider-conversation' });
    expect(initializeSessions(migrated)).toBe(migrated);
  });

  it('retains a legacy Plan conversation for further owner review only', () => {
    const migrated = initializeSessions({ ...task(), phase: 'plan_review', status: 'in_review', sessionId: 'plan-conversation' });
    expect(migrated.sessions?.filter(session => session.providerSessionId)).toEqual([
      expect.objectContaining({ name: 'plan', status: 'succeeded', providerSessionId: 'plan-conversation' }),
    ]);
    expect(migrated.currentSessionId).toBe(migrated.sessions?.find(session => session.name === 'plan')?.id);
  });

  it('retains session identity and attempt inputs when an interrupted task is reopened', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'muon-session-state-'));
    const filename = join(directory, 'muon.sqlite');
    let repository = new SqliteRepository(filename);
    try {
      await repository.initialize(scope, {
        id: scope.projectId, workspaceId: scope.workspaceId, ownerUserId: scope.userId,
        name: 'Session test', identifier: 'MUO', repositoryPath: '',
      }, { dispatcherEnabled: true, maxConcurrentAgents: 1, defaultProvider: 'claude' });
      const workflow = defineWorkflow({ kind: 'research' });
      const session = createSessions(workflow)[0];
      const input = { systemPrompt: 'Shared instructions', instructions: 'Research this question', context: 'Frozen dependency report' };
      await repository.insertTask(scope, {
        ...task(), workflow, phase: 'researching', status: 'in_progress', runId: 'attempt',
        currentSessionId: session.id, activeSessionId: session.id,
        sessions: [{ ...session, status: 'running', input, providerSessionId: 'research-conversation' }],
        runs: [{ id: 'attempt', phase: 'researching', provider: 'claude', status: 'running', startedAt: timestamp, agentSessionId: session.id, sessionName: 'research', input }],
      });
      repository.close();
      repository = new SqliteRepository(filename);
      const adapter: AgentAdapter = { provider: 'claude', available: async () => true, run: async () => { throw new Error('Startup must not execute a session.'); } };
      const service = new TaskService({
        scope, repository, adapters: { claude: adapter, codex: { ...adapter, provider: 'codex' } },
        artifacts: { importFile: async () => '', read: async () => undefined },
        workspaces: { ensure: async () => { throw new Error('Research must not create a worktree.'); }, changedFiles: async () => [] },
      });
      await service.initialize();
      const recovered = await service.getTask('task');
      expect(recovered).toMatchObject({ status: 'blocked', currentSessionId: session.id, sessions: [{ id: session.id, name: 'research', status: 'failed', providerSessionId: 'research-conversation', input }] });
      expect(recovered.runId).toBeUndefined();
      expect(recovered.runs).toMatchObject([{ id: 'attempt', agentSessionId: session.id, status: 'failed', input }]);
      expect((await repository.settings(scope)).dispatcherEnabled).toBe(false);
      await service.stop();
      repository.close();
      repository = new SqliteRepository(filename);
      expect(await repository.task(scope, 'task')).toEqual(recovered);
    } finally {
      repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
