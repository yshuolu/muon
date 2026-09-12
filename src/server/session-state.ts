import { randomUUID } from 'node:crypto';
import type { AgentSession, Task } from '../shared/types';
import { currentSessionName, sessionPhase, taskWorkflow, type WorkflowDefinition } from '../shared/workflows';

export function createSessions(workflow: WorkflowDefinition): AgentSession[] {
  return workflow.sessions.map(session => ({ id: randomUUID(), name: session.name, status: 'pending' }));
}

/** Migrate the old task-wide conversation into its current logical session only. */
export function initializeSessions(task: Task): Task {
  if (task.kind === 'group' || task.workflow && task.sessions?.length && task.currentSessionId) return task;
  const workflow = taskWorkflow(task);
  const sessions = createSessions(workflow);
  const currentName = currentSessionName({ ...task, sessions: undefined, currentSessionId: undefined });
  const index = sessions.findIndex(session => session.name === currentName);
  const current = sessions[index] ?? sessions[0];
  // A queued next session can still carry the preceding session's legacy ID.
  // Resume only a conversation with evidence that it belongs to this session.
  const previous = task.runs?.findLast(run => run.phase === sessionPhase(current.name) && run.sessionId);
  const providerSessionId = previous?.sessionId ?? (task.phase === 'plan_review' ? task.sessionId : undefined);
  const migrated = sessions.map((session, position): AgentSession => ({
    ...session,
    status: position < index || task.status === 'done' || session.id === current.id && task.phase === 'plan_review'
      ? 'succeeded'
      : session.id === current.id && task.status === 'in_progress' ? 'running'
      : session.id === current.id && task.status === 'blocked' ? 'failed'
      : session.id === current.id && task.status === 'canceled' ? 'canceled' : 'pending',
    ...(session.id === current.id && providerSessionId ? { providerSessionId } : {}),
  }));
  return {
    ...task, workflow, sessions: migrated, currentSessionId: current.id,
    sessionId: providerSessionId,
    activeSessionId: task.runId ? current.id : undefined,
    runs: task.runs?.map(run => {
      const name = currentSessionName({ phase: run.phase });
      return { ...run, sessionName: name, agentSessionId: sessions.find(session => session.name === name)?.id, providerSessionId: run.sessionId };
    }),
  };
}
