import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentProvider, AgentRequest, AgentResult, WorkspaceProvider } from '../runtime';
import type { Scope, Settings, Task } from '../shared/domain';
import type { ArtifactStore } from './ports';
import { SqliteRepository } from './sqlite-repository';
import { TaskService, type ServiceOptions } from './task-service';

interface ControlledCall {
  request: AgentRequest;
  finish: (text: string) => void;
  fail: (error: Error) => void;
}
class ControlledAdapter implements AgentAdapter {
  readonly calls: ControlledCall[] = [];
  ignoreAbort = false;
  constructor(readonly provider: AgentProvider) {}
  async available() { return true; }
  run(request: AgentRequest): Promise<AgentResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (text: string) => {
        if (settled) return;
        settled = true;
        resolve({ text, sessionId: `${this.provider}-session-${this.calls.length}` });
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      request.signal?.addEventListener('abort', () => { if (!this.ignoreAbort) fail(new Error('Run canceled')); }, { once: true });
      this.calls.push({ request, finish, fail });
    });
  }
}

const scope: Scope = { workspaceId: 'workspace', projectId: 'project', userId: 'owner' };
const initialSettings: Settings = { maxConcurrentAgents: 1, dispatcherEnabled: false, defaultProvider: 'claude' };
interface Fixture {
  repo: SqliteRepository;
  service: TaskService;
  claude: ControlledAdapter;
  codex: ControlledAdapter;
  options: ServiceOptions;
  workspaces: WorkspaceProvider;
  artifacts: ArtifactStore;
}
const fixtures: Fixture[] = [];

async function fixture(maxConcurrentAgents = 1): Promise<Fixture> {
  const repo = new SqliteRepository(':memory:');
  await repo.initialize(scope, {
    id: scope.projectId, workspaceId: scope.workspaceId, ownerUserId: scope.userId,
    name: 'Muon test', identifier: 'MUO', repositoryPath: '/test/repository',
  }, { ...initialSettings, maxConcurrentAgents });
  const claude = new ControlledAdapter('claude');
  const codex = new ControlledAdapter('codex');
  const workspaces: WorkspaceProvider = {
    ensure: vi.fn(async ({ taskId }) => ({ path: `/test/worktrees/${taskId}`, branch: `muon/${taskId}`, baseCommit: 'a'.repeat(40) })),
    changedFiles: vi.fn(async () => [{ path: 'src/app.ts', status: 'M', additions: 4, deletions: 1 }]),
    exportChanges: vi.fn(async (workspace) => ({ format: 'git-patch' as const, baseCommit: workspace.baseCommit, headCommit: workspace.baseCommit, sha256: 'f'.repeat(64), patchEncoding: 'utf8' as const, patch: 'diff --git a/src/dependency.ts b/src/dependency.ts\n+export const dependency = 42;\n', files: [{ path: 'src/dependency.ts', status: 'M', additions: 1, deletions: 0 }] })),
  };
  const artifacts: ArtifactStore = {
    importFile: vi.fn(async () => '/api/artifacts/actual-screenshot.png'),
    read: vi.fn(async () => undefined),
  };
  const options = { scope, repository: repo, artifacts, workspaces, adapters: { claude, codex } };
  const service = new TaskService(options);
  await service.initialize();
  const result = { repo, service, claude, codex, options, workspaces, artifacts };
  fixtures.push(result);
  return result;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    const stopping = fixture.service.stop();
    for (const adapter of [fixture.claude, fixture.codex]) for (const call of adapter.calls) call.fail(new Error('Test cleanup'));
    await stopping;
    fixture.repo.close();
  }
});

async function eventually(predicate: () => boolean | Promise<boolean>, description: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await setImmediate();
  }
  throw new Error(`Did not observe ${description}`);
}
async function dispatch(fixture: Fixture) {
  const settings = await fixture.repo.settings(scope);
  await fixture.repo.saveSettings(scope, { ...settings, dispatcherEnabled: true });
  await fixture.service.tick();
}
async function waitForCall(fixture: Fixture, index: number, phase: AgentRequest['phase'], provider: AgentProvider = 'claude') {
  const adapter = fixture[provider];
  await eventually(() => adapter.calls.length > index, `${provider} call ${index}`);
  const call = adapter.calls[index];
  expect(call.request.phase).toBe(phase);
  return call;
}
async function waitForState(fixture: Fixture, taskId: string, status: Task['status'], phase?: Task['phase']) {
  await eventually(async () => {
    const task = await fixture.service.getTask(taskId);
    return task.status === status && (!phase || task.phase === phase);
  }, `${status}${phase ? ` / ${phase}` : ''}`);
  return fixture.service.getTask(taskId);
}
const verification = (result: 'passed' | 'failed' | 'skipped') => JSON.stringify({
  summary: `Regression check ${result}`,
  evidence: [{ kind: 'test', title: 'Regression', description: `Observed ${result}`, result, steps: ['Run the regression test', 'Inspect the rendered task'] }],
});

async function prepareVerification(fixture: Fixture) {
  const task = await fixture.service.createTask({ title: 'Implement the task detail' });
  await dispatch(fixture);
  (await waitForCall(fixture, 0, 'planning')).finish('# RFC\nImplement task details and verify the result.');
  const review = await waitForState(fixture, task.id, 'in_review', 'plan_review');
  await fixture.service.approve(task.id, review.plans[0].id);
  (await waitForCall(fixture, 1, 'building')).finish('Implemented task details in src/app.ts.');
  const call = await waitForCall(fixture, 2, 'verification');
  return { task, call };
}

describe('TaskService workflow', () => {
  it('requires the owner to approve the exact current RFC before a single build can launch', async () => {
    const f = await fixture();
    const task = await f.service.createTask({ title: 'Add results view' });
    await dispatch(f);
    (await waitForCall(f, 0, 'planning')).finish('# RFC\nThe exact proposal to review.');
    const review = await waitForState(f, task.id, 'in_review', 'plan_review');
    await eventually(async () => (await f.service.snapshot()).runtime.activeRuns === 0, 'review releasing the execution slot');
    await f.service.tick();
    expect(f.claude.calls).toHaveLength(1);
    expect((await f.repo.attention(scope)).map(item => item.kind)).toEqual(['plan_approval']);
    await expect(f.service.approve(task.id, 'wrong-rfc')).rejects.toMatchObject({ status: 409 });
    const nonOwner = new TaskService({ ...f.options, scope: { ...scope, userId: 'someone-else' } });
    await expect(nonOwner.approve(task.id, review.plans[0].id)).rejects.toMatchObject({ status: 403 });
    await f.service.markRead(`${task.id}:plan_approval`);
    expect((await f.service.getTask(task.id)).plans[0].status).toBe('pending');

    await f.service.approve(task.id, review.plans[0].id);
    const build = await waitForCall(f, 1, 'building');
    expect(build.request.prompt).toContain('The exact proposal to review.');
    expect(build.request.cwd).toBe(f.claude.calls[0].request.cwd);
    expect((await f.service.getTask(task.id)).plans[0]).toMatchObject({ status: 'approved', reviewedBy: 'owner' });
    await expect(f.service.approve(task.id, review.plans[0].id)).rejects.toMatchObject({ status: 409 });
    await Promise.all(Array.from({ length: 10 }, () => f.service.tick()));
    expect(f.claude.calls).toHaveLength(2);
    expect(await f.repo.attention(scope)).toEqual([]);
  });

  it('blocks an unapproved build even when it is inserted directly into the dispatch queue', async () => {
    const f = await fixture();
    const task = await f.service.createTask({ title: 'Unapproved build' });
    await f.repo.saveTask(scope, { ...task, phase: 'building' }, task.version);
    await dispatch(f);
    const blocked = await waitForState(f, task.id, 'blocked');
    expect(blocked.error).toContain('approval');
    expect(f.claude.calls).toHaveLength(0);
    expect((await f.repo.attention(scope))[0].kind).toBe('blocked');
  });

  it('automatically starts the next Todo task when planning pauses for review', async () => {
    const f = await fixture();
    const first = await f.service.createTask({ title: 'First', priority: 1 });
    const second = await f.service.createTask({ title: 'Second', priority: 2 });
    await dispatch(f);
    const firstRun = await waitForCall(f, 0, 'planning');
    expect(firstRun.request.cwd).toContain(first.id);
    expect(f.claude.calls).toHaveLength(1);
    firstRun.finish('# RFC for first');
    const secondRun = await waitForCall(f, 1, 'planning');
    expect(secondRun.request.cwd).toContain(second.id);
    expect((await f.service.getTask(first.id)).status).toBe('in_review');
    expect((await f.service.snapshot()).runtime.activeRuns).toBe(1);
  });

  it('ranks eligible work by priority and waits for successful dependencies before dispatch', async () => {
    const f = await fixture();
    const prerequisite = await f.service.createTask({ title: 'Prerequisite', priority: 4 });
    const dependent = await f.service.createTask({ title: 'Urgent dependent', priority: 1, blockedByIds: [prerequisite.id] });
    const high = await f.service.createTask({ title: 'Ready high priority', priority: 2 });
    const unset = await f.service.createTask({ title: 'Unprioritized' });
    await dispatch(f);
    const first = await waitForCall(f, 0, 'planning');
    expect(first.request.cwd).toContain(high.id);
    expect((await f.service.getTask(dependent.id)).status).toBe('todo');
    first.finish('# RFC for high priority work');
    const second = await waitForCall(f, 1, 'planning');
    expect(second.request.cwd).toContain(prerequisite.id);

    // A completed prerequisite from another run is visible on the next dispatch decision.
    await f.repo.saveSettings(scope, { ...await f.repo.settings(scope), dispatcherEnabled: false });
    second.finish('# RFC for prerequisite');
    const reviewed = await waitForState(f, prerequisite.id, 'in_review');
    await eventually(async () => (await f.service.snapshot()).runtime.activeRuns === 0, 'all planning slots released');
    await f.repo.saveTask(scope, { ...reviewed, status: 'done', phase: 'complete' }, reviewed.version);
    await dispatch(f);
    expect((await waitForCall(f, 2, 'planning')).request.cwd).toContain(dependent.id);
    expect((await f.service.getTask(unset.id)).status).toBe('todo');
  });

  it('does not treat cancellation of a prerequisite as successful dependency completion', async () => {
    const f = await fixture();
    const prerequisite = await f.service.createTask({ title: 'Canceled prerequisite' });
    const dependent = await f.service.createTask({ title: 'Dependent', blockedByIds: [prerequisite.id] });
    await f.service.editTask(prerequisite.id, { status: 'canceled' });
    await dispatch(f);
    expect(f.claude.calls).toHaveLength(0);
    expect((await f.service.getTask(dependent.id)).status).toBe('todo');
  });

  it('counts the chief against the global limit and resists concurrent dispatcher ticks', async () => {
    const f = await fixture(2);
    await f.service.sendChief('Organize the project');
    const chief = await waitForCall(f, 0, 'chief');
    await f.service.createTask({ title: 'First coding task', priority: 1 });
    await f.service.createTask({ title: 'Second coding task', priority: 2 });
    await f.service.createTask({ title: 'Third coding task', priority: 3 });
    await dispatch(f);
    await waitForCall(f, 1, 'planning');
    await Promise.all(Array.from({ length: 25 }, () => f.service.tick()));
    expect(f.claude.calls).toHaveLength(2);
    expect((await f.service.snapshot()).runtime).toMatchObject({ activeRuns: 2, chiefRunning: true });
    chief.finish(JSON.stringify({ message: 'The project is organized.', actions: [] }));
    await waitForCall(f, 2, 'planning');
    expect((await f.service.snapshot()).runtime).toMatchObject({ activeRuns: 2, chiefRunning: false });
    expect((await f.repo.messages(scope)).map(item => item.content)).toEqual(['Organize the project', 'The project is organized.']);
  });

  it('persists a chief priority-only update without erasing the task status', async () => {
    const f = await fixture();
    const task = await f.service.createTask({ title: 'Prioritize this', status: 'backlog', priority: 4 });
    await f.service.sendChief('Make this task urgent');
    (await waitForCall(f, 0, 'chief')).finish(JSON.stringify({
      message: 'Moved the task to urgent priority.',
      actions: [{ type: 'update_task', taskId: task.id, priority: 1 }],
    }));
    await eventually(async () => (await f.repo.pendingChief(scope)) === null, 'chief action applied');
    expect(await f.service.getTask(task.id)).toMatchObject({ priority: 1, status: 'backlog', phase: 'idle' });
    const response = (await f.repo.messages(scope)).at(-1)!;
    expect(response.taskIds).toEqual([task.id]);
    expect(response.content).not.toContain('could not be applied');
  });

  it('creates a parent and linked child from references in a single chief result', async () => {
    const f = await fixture(2);
    await dispatch(f);
    await f.service.sendChief('Break the feature into a parent task and implementation task');
    (await waitForCall(f, 0, 'chief')).finish(JSON.stringify({
      message: 'Created the feature and its implementation task.',
      actions: [
        { type: 'create_task', kind: 'group', ref: 'feature', title: 'Feature outcome', status: 'todo' },
        { type: 'create_task', title: 'Implement the feature', parentId: '@feature', status: 'todo' },
      ],
    }));
    await eventually(async () => (await f.repo.pendingChief(scope)) === null, 'chief task decomposition');
    const tasks = await f.repo.tasks(scope);
    expect(tasks).toHaveLength(2);
    const parent = tasks.find(task => task.title === 'Feature outcome')!;
    const child = tasks.find(task => task.title === 'Implement the feature')!;
    expect(parent).toMatchObject({ kind: 'group', status: 'todo', phase: 'idle', parentId: null });
    expect(child.parentId).toBe(parent.id);
    const planning = await waitForCall(f, 1, 'planning');
    expect(planning.request.cwd).toContain(child.id);
    expect(f.claude.calls.filter(call => call.request.cwd.includes(parent.id))).toHaveLength(0);
    expect((await f.repo.messages(scope)).at(-1)).toMatchObject({ taskIds: [parent.id, child.id] });
  });

  it('regenerates an RFC from review feedback and requires approval of the new revision', async () => {
    const f = await fixture();
    const task = await f.service.createTask({ title: 'Iterate on the proposal' });
    await dispatch(f);
    (await waitForCall(f, 0, 'planning')).finish('# RFC v1\nOriginal proposal.');
    const firstReview = await waitForState(f, task.id, 'in_review');
    await f.service.requestChanges(task.id, firstReview.plans[0].id, 'Include keyboard navigation and accessibility tests.');
    const replanning = await waitForCall(f, 1, 'planning');
    expect(replanning.request.prompt).toContain('Include keyboard navigation and accessibility tests.');
    expect(replanning.request.sessionId).toBeUndefined();
    replanning.finish('# RFC v2\nIncludes keyboard navigation and accessibility tests.');
    const secondReview = await waitForState(f, task.id, 'in_review');
    expect(secondReview.plans.map(plan => [plan.version, plan.status])).toEqual([[1, 'changes_requested'], [2, 'pending']]);
    expect(secondReview.plans[1].id).not.toBe(secondReview.plans[0].id);
    await expect(f.service.approve(task.id, firstReview.plans[0].id)).rejects.toMatchObject({ status: 409 });
    expect(f.claude.calls.filter(call => call.request.phase === 'building')).toHaveLength(0);
    await f.service.approve(task.id, secondReview.plans[1].id);
    expect((await waitForCall(f, 2, 'building')).request.prompt).toContain('Includes keyboard navigation and accessibility tests.');
  });

  it.each(['passed', 'failed', 'skipped'] as const)('retains %s verification evidence and reports the correct terminal outcome', async result => {
    const f = await fixture();
    const { task, call } = await prepareVerification(f);
    call.finish(verification(result));
    const saved = await waitForState(f, task.id, result === 'passed' ? 'done' : 'blocked');
    expect(saved.evidence).toHaveLength(1);
    expect(saved.evidence[0]).toMatchObject({ kind: 'test', result, steps: ['Run the regression test', 'Inspect the rendered task'] });
    expect(saved.evidence[0].runId).toBe(saved.runs?.at(-1)?.id);
    expect(saved.changedFiles).toEqual([{ path: 'src/app.ts', status: 'M', additions: 4, deletions: 1 }]);
    expect(saved.phase).toBe(result === 'passed' ? 'complete' : 'verification');
    expect(Boolean(saved.completedAt)).toBe(result === 'passed');
    const expectedKind = result === 'passed' ? 'completed' : 'blocked';
    await eventually(async () => (await f.repo.attention(scope)).some(item => item.kind === expectedKind), 'verification attention');
    expect((await f.repo.attention(scope)).filter(item => item.kind === expectedKind)).toHaveLength(1);
    expect(f.workspaces.ensure).toHaveBeenCalledTimes(3);
    expect(new Set(vi.mocked(f.workspaces.ensure).mock.calls.map(([input]) => input.taskId)).size).toBe(1);
  });

  it('persists three distinct succeeded coding runs and their approved RFC association', async () => {
    const f = await fixture();
    const { task, call } = await prepareVerification(f);
    call.finish(verification('passed'));
    const saved = await waitForState(f, task.id, 'done');
    const runs = saved.runs!;
    expect(runs.map(run => [run.phase, run.status])).toEqual([
      ['planning', 'succeeded'], ['building', 'succeeded'], ['verification', 'succeeded'],
    ]);
    expect(new Set(runs.map(run => run.id)).size).toBe(3);
    for (const run of runs) {
      expect(run.provider).toBe('claude');
      expect(run.startedAt).toBeTruthy();
      expect(run.finishedAt).toBeTruthy();
      expect(run.sessionId).toBeTruthy();
    }
    expect(runs[0].planId).toBeUndefined();
    expect(runs[1].planId).toBe(saved.plans[0].id);
    expect(runs[2].planId).toBe(saved.plans[0].id);
    expect((await f.repo.task(scope, task.id))?.runs).toEqual(runs);
  });

  it('retains a failed verification attempt when a retry succeeds', async () => {
    const f = await fixture();
    const { task, call } = await prepareVerification(f);
    call.finish(verification('failed'));
    const blocked = await waitForState(f, task.id, 'blocked');
    const failedRun = blocked.runs!.at(-1)!;
    expect(failedRun).toMatchObject({ phase: 'verification', status: 'failed' });
    expect(failedRun.error).toContain('Verification did not pass');
    await eventually(async () => (await f.service.snapshot()).runtime.activeRuns === 0, 'failed attempt releasing capacity');
    await f.service.retry(task.id);
    (await waitForCall(f, 3, 'verification')).finish(verification('passed'));
    const completed = await waitForState(f, task.id, 'done');
    expect(completed.runs?.map(run => run.status)).toEqual(['succeeded', 'succeeded', 'failed', 'succeeded']);
    expect(completed.runs?.find(run => run.id === failedRun.id)).toEqual(failedRun);
    expect(completed.runs?.at(-1)?.id).not.toBe(failedRun.id);
    expect(completed.runs?.at(-1)?.planId).toBe(completed.plans[0].id);
    expect(completed.evidence.map(item => item.result)).toEqual(['failed', 'passed']);
    expect((await f.repo.task(scope, task.id))?.runs).toEqual(completed.runs);
  });

  it('acknowledges project completion until new backlog work makes the project incomplete', async () => {
    const f = await fixture();
    const canceled = await f.service.createTask({ title: 'Removed from scope', status: 'backlog' });
    await f.service.editTask(canceled.id, { status: 'canceled' });
    const { task, call } = await prepareVerification(f);
    call.finish(verification('passed'));
    await waitForState(f, task.id, 'done');
    await eventually(async () => (await f.repo.attention(scope)).some(item => item.kind === 'project_completed'), 'project completion notice');
    const completion = (await f.repo.attention(scope)).find(item => item.kind === 'project_completed')!;
    expect(completion.taskId).toBe(task.id);
    expect(completion.title).toBe('Muon test is complete');
    expect(completion.description).toContain('1 completed coding task');
    expect(completion.description).toContain('1 task was canceled');
    expect((await f.repo.attention(scope)).filter(item => item.kind === 'completed')).toHaveLength(1);

    await f.service.markRead(completion.id);
    const acknowledged = (await f.repo.attention(scope)).find(item => item.kind === 'project_completed')!;
    expect(acknowledged.readAt).toBeTruthy();
    await f.service.tick();
    await f.service.tick();
    expect((await f.repo.attention(scope)).filter(item => item.kind === 'project_completed')).toEqual([acknowledged]);

    await f.service.createTask({ title: 'A new idea', status: 'backlog' });
    await f.service.tick();
    expect((await f.repo.attention(scope)).filter(item => item.kind === 'project_completed')).toEqual([]);
    expect((await f.repo.attention(scope)).filter(item => item.kind === 'completed')).toHaveLength(1);
  });

  it('does not report an empty or entirely canceled project as completed', async () => {
    const f = await fixture();
    await f.service.tick();
    expect((await f.repo.attention(scope)).some(item => item.kind === 'project_completed')).toBe(false);
    const first = await f.service.createTask({ title: 'Canceled one', status: 'backlog' });
    const second = await f.service.createTask({ title: 'Canceled two', status: 'backlog' });
    await f.service.editTask(first.id, { status: 'canceled' });
    await f.service.editTask(second.id, { status: 'canceled' });
    await f.service.tick();
    expect((await f.repo.attention(scope)).some(item => item.kind === 'project_completed')).toBe(false);
    expect(f.claude.calls).toHaveLength(0);
  });

  it('does not accept verification prose without concrete test steps as proof of completion', async () => {
    const f = await fixture();
    const { task, call } = await prepareVerification(f);
    call.finish(JSON.stringify({ summary: 'All good', evidence: [{ kind: 'test', title: 'Everything', description: 'Passed', result: 'passed' }] }));
    const saved = await waitForState(f, task.id, 'blocked');
    expect(saved.completedAt).toBeUndefined();
    expect(saved.error).toContain('concrete steps');
  });

  it.each(['failed', 'passed'] as const)('retains %s test results and valid assets when another attachment fails to import', async result => {
    const f = await fixture();
    const { task, call } = await prepareVerification(f);
    vi.mocked(f.artifacts.importFile).mockImplementation(async (_scope, _task, _workspace, path) => {
      if (path === 'missing-recording.webm') throw new Error('Recording file does not exist.');
      if (path === 'install.log') throw new Error('Log could not be read.');
      return '/api/artifacts/valid-screenshot.png';
    });
    call.finish(JSON.stringify({ summary: `npm installation ${result}; browser evidence captured.`, evidence: [
      { kind: 'test', title: 'Install dependencies', description: `Observed npm ${result}.`, result, steps: ['npm ci --cache .muon-cache/npm'], artifactPath: 'install.log' },
      { kind: 'screenshot', title: 'Application screen', description: 'Actual rendered view.', artifactPath: 'valid-screenshot.png' },
      { kind: 'recording', title: 'Interaction recording', description: 'Caption for the unavailable recording.', artifactPath: 'missing-recording.webm' },
    ] }));
    const saved = await waitForState(f, task.id, 'blocked', 'verification');
    expect(saved.summary).toBe(`npm installation ${result}; browser evidence captured.`);
    expect(saved.evidence.find(item => item.title === 'Install dependencies')).toMatchObject({ kind: 'test', result, steps: ['npm ci --cache .muon-cache/npm'], description: expect.stringContaining(`Observed npm ${result}.`) });
    expect(saved.evidence.find(item => item.title === 'Application screen')?.artifactUrl).toBe('/api/artifacts/valid-screenshot.png');
    expect(saved.evidence.find(item => item.title === 'Interaction recording')).toMatchObject({ kind: 'note', description: expect.stringContaining('Recording file does not exist.') });
    expect(saved.evidence.filter(item => item.title.startsWith('Store attachment:'))).toHaveLength(2);
    expect(saved.evidence.filter(item => item.title.startsWith('Store attachment:')).every(item => item.result === 'failed' && !!item.steps?.length)).toBe(true);
    expect(saved.evidence.every(item => item.runId === saved.runs?.at(-1)?.id)).toBe(true);
    expect(saved.error).toContain('2 evidence attachments');
    expect(saved.completedAt).toBeUndefined();
    expect(saved.runs?.at(-1)?.status).toBe('failed');
    expect(saved.changedFiles).toHaveLength(1);
  });

  it('cannot resurrect a canceled task when a provider delivers its result late', async () => {
    const f = await fixture();
    f.claude.ignoreAbort = true;
    const task = await f.service.createTask({ title: 'Cancel this task' });
    await dispatch(f);
    const planning = await waitForCall(f, 0, 'planning');
    await f.service.editTask(task.id, { status: 'canceled' });
    expect(planning.request.signal?.aborted).toBe(true);
    planning.finish('# A late RFC that must be discarded');
    await eventually(async () => (await f.service.snapshot()).runtime.activeRuns === 0, 'canceled run slot released');
    const saved = await f.service.getTask(task.id);
    expect(saved.status).toBe('canceled');
    expect(saved.runId).toBeUndefined();
    expect(saved.plans).toEqual([]);
    expect(saved.changedFiles).toEqual([{ path: 'src/app.ts', status: 'M', additions: 4, deletions: 1 }]);
    expect(await f.repo.attention(scope)).toEqual([]);
    await f.service.tick();
    expect(f.claude.calls).toHaveLength(1);
  });

  it('marks interrupted persisted runs blocked during restart and retains their worktree', async () => {
    const f = await fixture();
    const task = await f.service.createTask({ title: 'Interrupted build' });
    const worktree = { path: '/test/worktrees/interrupted', branch: 'muon/interrupted', baseCommit: 'b'.repeat(40) };
    await f.repo.saveTask(scope, { ...task, status: 'in_progress', phase: 'building', runId: 'interrupted-run', worktree }, task.version);
    const restarted = new TaskService(f.options);
    await restarted.initialize();
    expect((await f.repo.settings(scope)).dispatcherEnabled).toBe(false);
    const saved = await restarted.getTask(task.id);
    expect(saved).toMatchObject({ status: 'blocked', phase: 'building', worktree });
    expect(saved.runId).toBeUndefined();
    expect(saved.error).toContain('server stopped');
    expect((await f.repo.attention(scope))[0].kind).toBe('blocked');
    expect(f.claude.calls).toHaveLength(0);
    await restarted.stop();
  });

  it('lets the chief edit all unstarted task metadata and resolve newly created relations', async () => {
    const f = await fixture();
    const task = await f.service.createTask({ title: 'Original task', status: 'backlog' });
    await f.service.sendChief('Refine the task, assign Codex, and organize it under a group with a prerequisite');
    (await waitForCall(f, 0, 'chief')).finish(JSON.stringify({ message: 'Prepared the task organization.', actions: [
      { type: 'create_task', kind: 'group', ref: 'feature', title: 'Feature group', status: 'backlog' },
      { type: 'create_task', ref: 'dependency', title: 'Prerequisite', status: 'backlog' },
      { type: 'update_task', taskId: task.id, title: 'Refined task', description: 'Includes testable acceptance criteria.', priority: 2, provider: 'codex', labels: ['ui', 'accessibility'], parentId: '@feature', blockedByIds: ['@dependency'] },
    ] }));
    await eventually(async () => (await f.repo.pendingChief(scope)) === null, 'full chief task management');
    const tasks = await f.repo.tasks(scope);
    expect(await f.service.getTask(task.id)).toMatchObject({ title: 'Refined task', description: 'Includes testable acceptance criteria.', priority: 2, provider: 'codex', labels: ['ui', 'accessibility'], parentId: tasks.find(item => item.title === 'Feature group')!.id, blockedByIds: [tasks.find(item => item.title === 'Prerequisite')!.id], status: 'backlog' });
    await f.service.sendChief('Remove labels, parent, and dependencies from the refined task');
    (await waitForCall(f, 1, 'chief')).finish(JSON.stringify({ message: 'Removed those relations.', actions: [{ type: 'update_task', taskId: task.id, labels: [], parentId: null, blockedByIds: [] }] }));
    await eventually(async () => (await f.repo.pendingChief(scope)) === null, 'chief relation removal');
    expect(await f.service.getTask(task.id)).toMatchObject({ title: 'Refined task', parentId: null, labels: [], blockedByIds: [], provider: 'codex' });
  });

  it('applies chief cancellation while rejecting edits that would bypass an active RFC', async () => {
    const f = await fixture(2);
    const task = await f.service.createTask({ title: 'Work in review' });
    await dispatch(f);
    (await waitForCall(f, 0, 'planning')).finish('# RFC\nOriginal approved scope.');
    await waitForState(f, task.id, 'in_review');
    await f.service.sendChief('Change the request and cancel the task');
    (await waitForCall(f, 1, 'chief')).finish(JSON.stringify({ message: 'Processed the requested changes.', actions: [
      { type: 'update_task', taskId: task.id, description: 'Scope expansion without review' },
      { type: 'cancel_task', taskId: task.id },
    ] }));
    await eventually(async () => (await f.repo.pendingChief(scope)) === null, 'chief cancellation');
    expect(await f.service.getTask(task.id)).toMatchObject({ status: 'canceled', description: '' });
    expect((await f.repo.messages(scope)).at(-1)?.content).toContain('Only unstarted coding tasks');
    expect(await f.repo.attention(scope)).toEqual([]);
    expect(f.claude.calls.some(call => call.request.phase === 'building')).toBe(false);
  });

  it('rolls up nested task groups after verified subtasks without dispatching a group agent', async () => {
    const f = await fixture();
    const root = await f.service.createTask({ title: 'Feature', kind: 'group' });
    const nested = await f.service.createTask({ title: 'Implementation', kind: 'group', parentId: root.id });
    const child = await f.service.createTask({ title: 'Implement behavior', parentId: nested.id });
    await dispatch(f);
    expect((await waitForCall(f, 0, 'planning')).request.cwd).toContain(child.id);
    f.claude.calls[0].finish('# RFC\nImplement and verify the behavior.');
    const review = await waitForState(f, child.id, 'in_review');
    await f.service.approve(child.id, review.plans[0].id);
    (await waitForCall(f, 1, 'building')).finish('Implemented behavior.');
    (await waitForCall(f, 2, 'verification')).finish(verification('passed'));
    await waitForState(f, child.id, 'done');
    await eventually(async () => (await f.service.getTask(root.id)).status === 'done', 'nested group completion');
    for (const id of [root.id, nested.id]) {
      expect(await f.service.getTask(id)).toMatchObject({ kind: 'group', status: 'done', phase: 'complete', runs: [], plans: [], evidence: [], changedFiles: [] });
    }
    expect((await f.service.getTask(root.id)).summary).toContain('Regression check passed');
    expect(f.claude.calls).toHaveLength(3);
    expect(f.workspaces.ensure).toHaveBeenCalledTimes(3);
    await eventually(async () => (await f.repo.attention(scope)).some(item => item.kind === 'project_completed'), 'group project completion');
    const projectNotice = (await f.repo.attention(scope)).find(item => item.kind === 'project_completed')!;
    expect(projectNotice.description).toContain('1 completed coding task');
    expect(projectNotice.description).toContain('2 task groups');
  });

  it('keeps empty groups and groups with canceled children incomplete, and allows removing a canceled child', async () => {
    const f = await fixture();
    const group = await f.service.createTask({ title: 'Feature', kind: 'group' });
    const canceled = await f.service.createTask({ title: 'Removed work', parentId: group.id, status: 'backlog' });
    await f.service.editTask(canceled.id, { status: 'canceled' });
    await dispatch(f);
    expect(f.claude.calls).toHaveLength(0);
    expect(await f.service.getTask(group.id)).toMatchObject({ status: 'todo', phase: 'idle' });
    expect((await f.repo.attention(scope)).some(item => item.kind === 'completed')).toBe(false);
    await expect(f.service.editTask(group.id, { parentId: canceled.id })).rejects.toThrow('subtasks');
    await f.service.editTask(group.id, { title: 'Revised feature', labels: ['next'] });
    expect(await f.service.getTask(group.id)).toMatchObject({ title: 'Revised feature', labels: ['next'] });
    await f.service.editTask(canceled.id, { parentId: null });
    expect(await f.service.getTask(canceled.id)).toMatchObject({ status: 'canceled', parentId: null });
    expect((await f.service.getTask(group.id)).summary).toBe('0 of 0 subtasks complete.');
    await expect(f.service.editTask(canceled.id, { status: 'todo' })).rejects.toThrow('Only unstarted coding tasks');
  });

  it('reopens a completed group when another child is attached and preserves verified child outcomes', async () => {
    const f = await fixture();
    const group = await f.service.createTask({ title: 'Feature', kind: 'group' });
    const first = await f.service.createTask({ title: 'First piece', status: 'backlog', parentId: group.id });
    const completed = await f.repo.saveTask(scope, { ...first, status: 'done', phase: 'complete', summary: 'Verified first piece', completedAt: new Date().toISOString() }, first.version);
    await f.service.tick();
    expect(await f.service.getTask(group.id)).toMatchObject({ status: 'done', phase: 'complete' });
    await f.service.createTask({ title: 'Next piece', status: 'backlog', parentId: group.id });
    expect(await f.service.getTask(group.id)).toMatchObject({ status: 'todo', phase: 'idle', summary: expect.stringContaining('1 of 2 subtasks complete') });
    expect((await f.service.getTask(group.id)).completedAt).toBeUndefined();
    expect(await f.service.getTask(first.id)).toEqual(completed);
    expect((await f.repo.attention(scope)).some(item => item.taskId === group.id && item.kind === 'completed')).toBe(false);
    expect((await f.repo.attention(scope)).some(item => item.kind === 'project_completed')).toBe(false);
  });

  it('rejects hierarchy/dependency cycles across groups and coding subtasks', async () => {
    const f = await fixture();
    const group = await f.service.createTask({ title: 'Group', kind: 'group', status: 'backlog' });
    const child = await f.service.createTask({ title: 'Child', parentId: group.id, status: 'backlog' });
    await expect(f.service.editTask(child.id, { blockedByIds: [group.id] })).rejects.toThrow('cycle');
    await expect(f.service.editTask(group.id, { parentId: child.id })).rejects.toThrow('cycle');
    expect((await f.service.getTask(child.id)).blockedByIds).toEqual([]);
    expect((await f.service.getTask(group.id)).parentId).toBeNull();
  });

  it('repairs failed verification within the same approved RFC and then verifies again', async () => {
    const f = await fixture();
    const { task, call } = await prepareVerification(f);
    call.finish(verification('failed'));
    const blocked = await waitForState(f, task.id, 'blocked');
    await eventually(async () => (await f.service.snapshot()).runtime.activeRuns === 0, 'verification failure releases capacity');
    await f.service.retry(task.id, { mode: 'fix', feedback: 'Fix the keyboard navigation regression.' });
    const build = await waitForCall(f, 3, 'building');
    expect(build.request.cwd).toBe(call.request.cwd);
    expect(build.request.sessionId).toBeUndefined();
    expect(build.request.prompt).toContain('Fix the keyboard navigation regression.');
    expect(build.request.prompt).toContain('Observed failed');
    expect(build.request.prompt).toContain('does not authorize expanding the RFC');
    expect((await f.service.getTask(task.id)).plans).toEqual(blocked.plans);
    build.finish('Fixed keyboard navigation within the approved task details scope.');
    const verifyAgain = await waitForCall(f, 4, 'verification');
    expect((await f.service.getTask(task.id)).changedFiles).toHaveLength(1);
    verifyAgain.finish(verification('passed'));
    const saved = await waitForState(f, task.id, 'done');
    expect(saved.runs?.map(run => [run.phase, run.status])).toEqual([['planning', 'succeeded'], ['building', 'succeeded'], ['verification', 'failed'], ['building', 'succeeded'], ['verification', 'succeeded']]);
    expect(saved.evidence.map(item => item.result)).toEqual(['failed', 'passed']);
    expect(new Set(saved.evidence.map(item => item.runId)).size).toBe(2);
    expect(saved.recovery).toMatchObject({ mode: 'fix', feedback: 'Fix the keyboard navigation regression.' });
  });

  it('requires approval of a replacement RFC after a blocked task is replanned', async () => {
    const f = await fixture();
    const { task, call } = await prepareVerification(f);
    call.finish(verification('failed'));
    const blocked = await waitForState(f, task.id, 'blocked');
    await eventually(async () => (await f.service.snapshot()).runtime.activeRuns === 0, 'failed verification releases capacity');
    await f.service.retry(task.id, { mode: 'replan', feedback: 'Revise the design to support keyboard navigation.' });
    const replan = await waitForCall(f, 3, 'planning');
    expect(replan.request.prompt).toContain('Revise the design to support keyboard navigation.');
    expect(replan.request.cwd).toBe(call.request.cwd);
    expect((await f.service.getTask(task.id)).plans[0].status).toBe('changes_requested');
    await expect(f.service.approve(task.id, blocked.plans[0].id)).rejects.toMatchObject({ status: 409 });
    replan.finish('# RFC v2\nUpdated keyboard navigation design.');
    const review = await waitForState(f, task.id, 'in_review');
    expect(review.plans.map(plan => plan.status)).toEqual(['changes_requested', 'pending']);
    expect(review.evidence).toEqual(blocked.evidence);
    expect(f.claude.calls.filter(item => item.request.phase === 'building')).toHaveLength(1);
    await expect(f.service.approve(task.id, blocked.plans[0].id)).rejects.toMatchObject({ status: 409 });
    await f.service.approve(task.id, review.plans[1].id);
    const build = await waitForCall(f, 4, 'building');
    expect(build.request.prompt).toContain('Updated keyboard navigation design.');
    expect((await f.service.getTask(task.id)).runs?.at(-1)?.planId).toBe(review.plans[1].id);
  });

  it('does not allow remediation to bypass planning or a revoked RFC approval', async () => {
    const f = await fixture();
    const task = await f.service.createTask({ title: 'Plan failed' });
    await dispatch(f);
    (await waitForCall(f, 0, 'planning')).fail(new Error('Could not inspect repository'));
    await waitForState(f, task.id, 'blocked');
    await eventually(async () => (await f.service.snapshot()).runtime.activeRuns === 0, 'planning failure releases capacity');
    await expect(f.service.retry(task.id, { mode: 'fix' })).rejects.toThrow('Replan instead');
    expect(f.claude.calls).toHaveLength(1);
    const blocked = await f.service.getTask(task.id);
    await f.repo.saveTask(scope, { ...blocked, phase: 'verification' }, blocked.version);
    await expect(f.service.retry(task.id, { mode: 'fix' })).rejects.toThrow('approved RFC');
    expect(f.claude.calls).toHaveLength(1);
  });

  it('freezes actual dependency patches on the RFC and reuses the approved inputs', async () => {
    const f = await fixture();
    const prerequisite = await f.service.createTask({ title: 'Prerequisite', status: 'backlog' });
    await f.repo.saveTask(scope, { ...prerequisite, status: 'done', phase: 'complete', summary: 'Implemented prerequisite and passed regression tests.', worktree: { path: '/test/worktrees/dependency', branch: 'muon/dependency', baseCommit: 'c'.repeat(40) }, changedFiles: [{ path: 'src/dependency.ts', status: 'M', additions: 3, deletions: 0 }] }, prerequisite.version);
    const integration = await f.service.createTask({ title: 'Integrate prerequisite', blockedByIds: [prerequisite.id] });
    await dispatch(f);
    const planning = await waitForCall(f, 0, 'planning');
    expect(planning.request.prompt).not.toContain('/test/worktrees/dependency');
    expect(planning.request.prompt).toContain('Implemented prerequisite and passed regression tests.');
    expect(planning.request.prompt).toContain('src/dependency.ts');
    expect(planning.request.prompt).toContain('export const dependency = 42');
    expect(planning.request.prompt).toContain('only after owner approval');
    planning.finish('# RFC\nIntegrate the supplied dependency snapshot.');
    const review = await waitForState(f, integration.id, 'in_review', 'plan_review');
    expect(review.plans[0].dependencyInputs).toMatchObject([{ taskId: prerequisite.id, changes: { sha256: 'f'.repeat(64), patch: expect.stringContaining('dependency = 42') } }]);
    vi.mocked(f.workspaces.exportChanges!).mockRejectedValue(new Error('The source changed after review.'));
    await f.service.approve(integration.id, review.plans[0].id);
    const building = await waitForCall(f, 1, 'building');
    expect(building.request.prompt).toContain('dependency = 42');
    expect(f.workspaces.exportChanges).toHaveBeenCalledTimes(1);
    building.finish('Integrated the reviewed dependency snapshot.');
    const checking = await waitForCall(f, 2, 'verification');
    expect(checking.request.prompt).toContain('dependency = 42');
    expect(f.workspaces.exportChanges).toHaveBeenCalledTimes(1);
    checking.finish(verification('passed'));
    expect((await waitForState(f, integration.id, 'done')).plans[0].dependencyInputs).toEqual(review.plans[0].dependencyInputs);
  });

  it('expands completed nested dependency groups into unique coding leaf snapshots', async () => {
    const f = await fixture();
    const group = await f.service.createTask({ title: 'Feature', kind: 'group', status: 'backlog' });
    const nested = await f.service.createTask({ title: 'Nested feature', kind: 'group', parentId: group.id, status: 'backlog' });
    const first = await f.service.createTask({ title: 'First leaf', parentId: nested.id, status: 'backlog' });
    const second = await f.service.createTask({ title: 'Second leaf', parentId: group.id, status: 'backlog' });
    for (const task of [first, second]) await f.repo.saveTask(scope, { ...task, status: 'done', phase: 'complete', worktree: { path: `/test/${task.id}`, branch: `muon/${task.id}`, baseCommit: 'c'.repeat(40) } }, task.version);
    const integration = await f.service.createTask({ title: 'Integrate feature', blockedByIds: [group.id, first.id] });
    await dispatch(f);
    const planning = await waitForCall(f, 0, 'planning');
    expect(f.workspaces.exportChanges).toHaveBeenCalledTimes(2);
    expect(planning.request.prompt).toContain(first.identifier);
    expect(planning.request.prompt).toContain(second.identifier);
    planning.finish('# RFC\nIntegrate both completed leaf snapshots.');
    const review = await waitForState(f, integration.id, 'in_review', 'plan_review');
    expect(review.plans[0].dependencyInputs?.map(input => input.taskId).sort()).toEqual([first.id, second.id].sort());
  });

  it('blocks integration before invoking an agent when dependency export is unavailable or too large', async () => {
    const f = await fixture();
    const prerequisite = await f.service.createTask({ title: 'Prerequisite', status: 'backlog' });
    await f.repo.saveTask(scope, { ...prerequisite, status: 'done', phase: 'complete', worktree: { path: '/test/dependency', branch: 'muon/dependency', baseCommit: 'c'.repeat(40) } }, prerequisite.version);
    vi.mocked(f.workspaces.exportChanges!).mockRejectedValue(new Error('Dependency patch exceeds 262144 bytes. No partial patch was supplied.'));
    const integration = await f.service.createTask({ title: 'Integrate large change', blockedByIds: [prerequisite.id] });
    await dispatch(f);
    const blocked = await waitForState(f, integration.id, 'blocked', 'planning');
    expect(blocked.error).toContain('No partial patch');
    expect(blocked.plans).toEqual([]);
    expect(f.claude.calls).toHaveLength(0);
  });

  it('retains optional investigation notes without treating them as failed required tests', async () => {
    const f = await fixture();
    const { task, call } = await prepareVerification(f);
    const response = JSON.parse(verification('passed'));
    response.evidence.push({ kind: 'note', title: 'Optional investigation unavailable', description: 'A supplemental probe outside the approved RFC was denied; required regression checks ran successfully.', result: 'skipped' });
    call.finish(JSON.stringify(response));
    const completed = await waitForState(f, task.id, 'done');
    expect(completed.evidence).toContainEqual(expect.objectContaining({ kind: 'note', result: 'skipped' }));
    expect(completed.evidence).toContainEqual(expect.objectContaining({ kind: 'test', result: 'passed' }));
  });
});
