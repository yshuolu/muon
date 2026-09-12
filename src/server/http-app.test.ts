import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentProvider, AgentRequest, AgentResult, WorkspaceProvider } from '../runtime';
import { AgentProcessUnreapedError } from '../runtime';
import type { ArtifactStore } from './ports';
import { DomainError } from './ports';
import { createHttpApp } from './http-app';
import { LocalChiefCommands } from './local-chief-commands';
import { SqliteRepository } from './sqlite-repository';
import { TaskService } from './task-service';

class TestAdapter implements AgentAdapter {
  calls: Array<{ request: AgentRequest; resolve: (result: AgentResult) => void; reject: (error: Error) => void }> = [];
  constructor(readonly provider: AgentProvider) {}
  async available() { return true; }
  run(request: AgentRequest): Promise<AgentResult> {
    return new Promise((resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
      this.calls.push({ request, resolve, reject });
    });
  }
}

const scope = { workspaceId: 'test-workspace', projectId: 'test-project', userId: 'owner' };
let repository: SqliteRepository;
let service: TaskService;
let claude: TestAdapter;
let codex: TestAdapter;
let workspaces: WorkspaceProvider;
let app: ReturnType<typeof createHttpApp>;
let artifacts: ArtifactStore;
let commands: LocalChiefCommands;

beforeEach(async () => {
  repository = new SqliteRepository(':memory:');
  await repository.initialize(scope, {
    id: scope.projectId, workspaceId: scope.workspaceId, ownerUserId: scope.userId,
    name: 'Test project', identifier: 'TST', repositoryPath: '/test/repo',
  }, { maxConcurrentAgents: 1, dispatcherEnabled: false, defaultProvider: 'claude' });
  claude = new TestAdapter('claude'); codex = new TestAdapter('codex');
  workspaces = {
    validateRepository: vi.fn(async path => { if (!path.startsWith('/')) throw new Error('Repository path must be absolute.'); }),
    ensure: vi.fn(async ({ taskId }) => ({ path: `/test/worktrees/${taskId}`, branch: `muon/${taskId}`, baseCommit: 'a'.repeat(40) })),
    changedFiles: vi.fn(async () => []),
  };
  artifacts = { importFile: vi.fn(), read: vi.fn(async () => undefined) };
  commands = new LocalChiefCommands({ apiUrl: 'http://127.0.0.1:4310', scope });
  service = new TaskService({ scope, repository, artifacts, workspaces, adapters: { claude, codex }, chiefCommands: commands });
  await service.initialize();
  app = createHttpApp(service, artifacts, { staticRoot: process.cwd(), access: commands });
});
afterEach(async () => {
  for (const call of [...claude.calls, ...codex.calls]) call.reject(new Error('Test cleanup'));
  await service.stop();
  repository.close();
  vi.restoreAllMocks();
});

async function request(path: string, method = 'GET', body?: unknown, headers?: Record<string, string>) {
  return app.request(`http://localhost:4310${path}`, {
    method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (await check()) return; await delay(5); }
  throw new Error('Expected state did not arrive');
}
async function enableDispatch() {
  await repository.saveSettings(scope, { ...await repository.settings(scope), dispatcherEnabled: true });
  await service.tick();
}

describe('HTTP validation and local boundary', () => {
  it('persists an owner-selected chief model and clears it without replacing other settings', async () => {
    expect((await request('/api/settings', 'PATCH', { chiefModel: '  sonnet[1m]  ' })).status).toBe(200);
    expect(await (await request('/api/settings')).json()).toMatchObject({ chiefModel: 'sonnet[1m]', defaultProvider: 'claude', maxConcurrentAgents: 1 });
    expect((await request('/api/settings', 'PATCH', { chiefModel: null })).status).toBe(200);
    expect((await repository.settings(scope)).chiefModel).toBeNull();
  });

  it.each(['', '   ', '-p', 'model --tools Bash', 'model\nname', 'model;command', 'x'.repeat(201), 42, {}])('rejects invalid chief model settings: %j', async chiefModel => {
    expect((await request('/api/settings', 'PATCH', { chiefModel })).status).toBe(400);
    expect((await repository.settings(scope)).chiefModel).toBeUndefined();
  });

  it('keeps chief model settings owner-only and rejects changing an active request model', async () => {
    await service.sendChief('Organize the project');
    await eventually(() => claude.calls.length === 1);
    const headers = { authorization: `Bearer ${claude.calls[0].request.chiefCli!.token}` };
    expect((await request('/api/settings', 'PATCH', { chiefModel: 'sonnet' }, headers)).status).toBe(403);
    expect((await request('/api/settings', 'PATCH', { chiefModel: 'sonnet' })).status).toBe(409);
    expect((await repository.settings(scope)).chiefModel).toBeUndefined();
  });

  it('validates repository setup through the workspace provider before saving settings', async () => {
    vi.mocked(workspaces.validateRepository!).mockRejectedValue(new Error('No committed Git history.'));
    const result = await request('/api/settings', 'PATCH', { repositoryPath: '/empty/git', projectName: 'Changed name', maxConcurrentAgents: 3 });
    expect(result.status).toBe(400);
    expect((await result.json()).error).toContain('at least one commit');
    expect((await repository.project(scope)).name).toBe('Test project');
    expect((await repository.project(scope)).repositoryPath).toBe('/test/repo');
    expect((await repository.settings(scope)).maxConcurrentAgents).toBe(1);
    vi.mocked(workspaces.validateRepository!).mockResolvedValue();
    expect((await request('/api/settings', 'PATCH', { repositoryPath: '/valid/git' })).status).toBe(200);
    expect((await repository.project(scope)).repositoryPath).toBe('/valid/git');
  });

  it('serves recording byte ranges and rejects unsatisfiable ranges', async () => {
    vi.mocked(artifacts.read).mockResolvedValue({ data: Buffer.from('0123456789'), mime: 'video/webm' });
    const full = await request('/api/artifacts/recording');
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    for (const [range, expected, contentRange] of [
      ['bytes=2-5', '2345', 'bytes 2-5/10'],
      ['bytes=7-', '789', 'bytes 7-9/10'],
      ['bytes=-3', '789', 'bytes 7-9/10'],
    ]) {
      const response = await request('/api/artifacts/recording', 'GET', undefined, { range });
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(contentRange);
      expect(await response.text()).toBe(expected);
    }
    for (const range of ['bytes=10-', 'bytes=7-3', 'bytes=-', 'bytes=-0', 'bytes=0-1,4-5']) {
      const response = await request('/api/artifacts/recording', 'GET', undefined, { range });
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */10');
    }
  });

  it('accepts task groups and validates recovery requests', async () => {
    const creation = await request('/api/tasks', 'POST', { title: 'Release work', kind: 'group', status: 'backlog' });
    expect(creation.status).toBe(201);
    const group = await creation.json();
    expect(group.kind).toBe('group');
    expect((await request(`/api/tasks/${group.id}`, 'PATCH', { kind: 'coding' })).status).toBe(400);
    expect((await request(`/api/tasks/${group.id}/retry`, 'POST', { mode: 'approve' })).status).toBe(400);
    expect((await request(`/api/tasks/${group.id}/retry`, 'POST', { feedback: 'x'.repeat(20_001) })).status).toBe(400);
  });

  it('permits local reads and rejects remote origins and unrecognized hosts', async () => {
    expect((await request('/api/state')).status).toBe(200);
    expect((await request('/api/state', 'GET', undefined, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await app.request('http://evil.example/api/state')).status).toBe(403);
    expect((await request('/api/state', 'GET', undefined, { origin: 'not a URL' })).status).toBe(403);
  });

  it('rejects mutations without JSON and malformed JSON before touching state', async () => {
    expect((await request('/api/tasks', 'POST')).status).toBe(415);
    const response = await app.request('http://localhost:4310/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    expect(response.status).toBe(400);
    expect(await repository.tasks(scope)).toEqual([]);
  });

  it.each([
    { title: 'Try to skip review', status: 'done' },
    { title: 'Try to skip review', phase: 'building' },
    { title: 'Override ownership', ownerUserId: 'someone-else' },
    { title: 'Invalid provider', provider: 'shell' },
    { title: 'Invalid priority', priority: 99 },
    { title: '   ' },
  ])('rejects unsupported task fields and invalid values: %j', async body => {
    expect((await request('/api/tasks', 'POST', body)).status).toBe(400);
    expect(await repository.tasks(scope)).toEqual([]);
  });

  it('validates limits and does not permit approval through a task patch', async () => {
    const created = await request('/api/tasks', 'POST', { title: 'Valid task', status: 'backlog' });
    const task = await created.json();
    expect(created.status).toBe(201);
    expect((await request(`/api/tasks/${task.id}`, 'PATCH', { plans: [{ status: 'approved' }] })).status).toBe(400);
    expect((await request('/api/settings', 'PATCH', { maxConcurrentAgents: 0 })).status).toBe(400);
    expect((await request('/api/settings', 'PATCH', { maxConcurrentAgents: 9 })).status).toBe(400);
    expect((await request('/api/settings', 'PATCH', { maxConcurrentAgents: 2.5 })).status).toBe(400);
    expect((await request('/api/settings', 'PATCH', { repositoryPath: 'relative/path' })).status).toBe(400);
    expect((await request(`/api/tasks/${task.id}/approve`, 'POST', { planId: 'invented' })).status).toBe(409);
    expect((await request('/api/tasks/missing/retry', 'POST', {})).status).toBe(404);
  });

  it('rejects oversized request bodies', async () => {
    expect((await request('/api/chief/messages', 'POST', { content: 'x'.repeat(1024 * 1024) })).status).toBe(413);
    expect(await repository.messages(scope)).toEqual([]);
  });
});

describe('REST record resources', () => {
  it('keeps planning chats disposable and taskifies only on explicit request', async () => {
    const created = await request('/api/planning-chats', 'POST', {});
    expect(created.status).toBe(201);
    const chat = await created.json();
    const sent = await request(`/api/planning-chats/${chat.id}/messages`, 'POST', { content: 'Explore a small API improvement.' });
    expect(sent.status).toBe(202);
    expect(claude.calls[0].request.phase).toBe('chat');
    claude.calls[0].resolve({ text: 'A focused API task with acceptance criteria would be a good next step.' });
    await eventually(async () => (await service.getPlanningChat(chat.id)).messages.length === 2);
    const current = await (await request(`/api/planning-chats/${chat.id}`)).json();
    expect(current.messages).toHaveLength(2);
    expect((await repository.tasks(scope))).toEqual([]);
    expect(await repository.messages(scope)).toEqual([]);
    const taskified = await request(`/api/planning-chats/${chat.id}/taskify`, 'POST', { title: 'API improvement', status: 'backlog' });
    expect(taskified.status).toBe(201);
    const task = await taskified.json();
    expect(task.description).toContain('Explore a small API improvement.');
    expect(task.description).toContain('A focused API task');
    expect((await request(`/api/planning-chats/${chat.id}`)).status).toBe(404);
  });

  it('reads the scoped records as objects and collections, accepting identifiers in task routes', async () => {
    const task = await service.createTask({ title: 'Public task', status: 'backlog' });
    const timestamp = new Date().toISOString();
    const saved = await repository.saveTask(scope, {
      ...task,
      plans: [{ id: 'plan-1', version: 1, format: 'markdown', content: '# RFC', status: 'pending', createdAt: timestamp }],
      evidence: [{ id: 'test-1', kind: 'test', title: 'Unit tests', description: 'All pass', result: 'passed', steps: ['npm test'], createdAt: timestamp }],
      changedFiles: [{ path: 'feature.ts', status: 'added', additions: 5, deletions: 0 }],
      runs: [{ id: 'run-1', phase: 'verification', provider: 'claude', status: 'succeeded', startedAt: timestamp, finishedAt: timestamp }],
    }, task.version);
    const message = { id: 'message-1', role: 'assistant' as const, content: 'Task ready.', createdAt: timestamp, taskIds: [task.id] };
    const attention = { id: 'attention-1', taskId: task.id, kind: 'plan_approval' as const, title: 'Review RFC', description: 'Please review.', createdAt: timestamp };
    await repository.appendMessage(scope, message);
    await repository.putAttention(scope, attention);
    expect(await (await request(`/api/tasks/${task.identifier.toLowerCase()}`)).json()).toEqual(saved);
    for (const [resource, expected] of [
      ['plans', saved.plans], ['evidence', saved.evidence], ['files', saved.changedFiles],
      ['activity', saved.activity], ['runs', saved.runs], ['subtasks', []], ['dependencies', []], ['plan-discussion', []],
    ] as const) {
      const response = await request(`/api/tasks/${task.identifier}/${resource}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(await (await request(`/api/tasks/${task.id}/plans/plan-1`)).json()).toEqual(saved.plans[0]);
    expect(await (await request('/api/project')).json()).toEqual(await repository.project(scope));
    expect(await (await request('/api/settings')).json()).toEqual(await repository.settings(scope));
    expect(await (await request('/api/runtime')).json()).toEqual((await service.snapshot()).runtime);
    expect(await (await request('/api/chief/messages')).json()).toEqual([message]);
    expect(await (await request('/api/attention?unread=true')).json()).toEqual([attention]);
    expect(await (await request('/api/attention?unread=false')).json()).toEqual([]);
    await request(`/api/attention/${attention.id}/read`, 'POST', {});
    expect(await (await request('/api/attention?unread=true')).json()).toEqual([]);
    expect(await (await request('/api/attention?unread=false')).json()).toHaveLength(1);
    expect((await request(`/api/tasks/${task.id}/plans/missing`)).status).toBe(404);
    expect((await request('/api/tasks/missing/evidence')).status).toBe(404);
    expect((await request(`/api/tasks/${task.id}/transcript`)).status).toBe(404);
  });

  it('filters tasks and resolves parent/dependency identifiers across REST mutations', async () => {
    const group = await service.createTask({ title: 'Release', kind: 'group', status: 'backlog' });
    const prerequisite = await service.createTask({ title: 'Infrastructure', status: 'backlog' });
    const response = await request('/api/tasks', 'POST', {
      title: 'Ship API', description: 'Structured record access', status: 'backlog', provider: 'codex',
      parentId: group.identifier.toLowerCase(), blockedByIds: [prerequisite.identifier], labels: ['Public'],
    });
    expect(response.status).toBe(201);
    const task = await response.json();
    expect(task).toMatchObject({ parentId: group.id, blockedByIds: [prerequisite.id] });
    const filtered = await request(`/api/tasks?status=backlog&provider=codex&kind=coding&parentId=${group.identifier}&blockedById=${prerequisite.identifier}&search=public`);
    expect(await filtered.json()).toEqual([task]);
    expect((await (await request('/api/tasks?parentId=null')).json()).map((item: { id: string }) => item.id)).toEqual([group.id, prerequisite.id]);
    expect(await (await request('/api/tasks?kind=group')).json()).toEqual([await service.getTask(group.id)]);
    expect(await (await request('/api/tasks?search=STRUCTURED')).json()).toEqual([task]);
    expect(await (await request('/api/tasks?search=no-match')).json()).toEqual([]);
    expect(await (await request(`/api/tasks/${group.identifier}/subtasks`)).json()).toEqual([task]);
    expect(await (await request(`/api/tasks/${task.identifier}/dependencies`)).json()).toEqual([prerequisite]);
    expect((await request(`/api/tasks/${task.identifier}`, 'PATCH', { parentId: null, blockedByIds: [] })).status).toBe(200);
    expect(await service.getTask(task.id)).toMatchObject({ parentId: null, blockedByIds: [] });
    expect((await request(`/api/tasks/${task.identifier}/cancel`, 'POST', {})).status).toBe(200);
    expect((await service.getTask(task.id)).status).toBe('canceled');
    for (const query of ['status=invalid', 'provider=shell', 'kind=workspace', 'surprise=true', 'search=' + 'x'.repeat(1001)]) {
      expect((await request(`/api/tasks?${query}`)).status).toBe(400);
    }
    expect((await request('/api/tasks?parentId=missing')).status).toBe(404);
    expect((await request('/api/attention?unread=yes')).status).toBe(400);
    expect((await request(`/api/tasks/${prerequisite.id}/cancel`, 'POST', { status: 'done' })).status).toBe(400);
  });

  it('never returns or relates records from another project scope', async () => {
    const task = await service.createTask({ title: 'Local record', status: 'backlog' });
    const foreignScope = { ...scope, workspaceId: 'other-workspace', projectId: 'other-project' };
    await repository.initialize(foreignScope, { id: foreignScope.projectId, workspaceId: foreignScope.workspaceId, ownerUserId: 'other-owner', name: 'Other project', identifier: 'OTHER', repositoryPath: '/other/repo' }, { maxConcurrentAgents: 1, dispatcherEnabled: false, defaultProvider: 'claude' });
    const foreign = await repository.insertTask(foreignScope, { ...task, id: 'foreign-task', title: 'Foreign record', ownerUserId: 'other-owner' });
    await repository.appendMessage(foreignScope, { id: 'foreign-message', role: 'assistant', content: 'Foreign chief result', createdAt: task.createdAt });
    await repository.putAttention(foreignScope, { id: 'foreign-attention', taskId: foreign.id, kind: 'completed', title: 'Foreign attention', description: '', createdAt: task.createdAt });
    expect(await (await request('/api/tasks')).json()).toEqual([task]);
    expect(await (await request('/api/chief/messages')).json()).toEqual([]);
    expect(await (await request('/api/attention')).json()).toEqual([]);
    for (const reference of [foreign.id, foreign.identifier]) {
      expect((await request(`/api/tasks/${reference}`)).status).toBe(404);
      expect((await request(`/api/tasks/${reference}/plans`)).status).toBe(404);
      expect((await request(`/api/tasks/${reference}`, 'PATCH', { title: 'Escape scope' })).status).toBe(404);
      expect((await request('/api/tasks', 'POST', { title: 'Foreign parent', parentId: reference })).status).toBe(400);
      expect((await request(`/api/tasks/${task.id}`, 'PATCH', { blockedByIds: [reference] })).status).toBe(400);
    }
    expect(await repository.task(foreignScope, foreign.id)).toEqual(foreign);
  });

  it('downloads the exact immutable RFC dependency patch, including non-UTF8 bytes', async () => {
    const task = await service.createTask({ title: 'Integration', status: 'backlog' });
    const bytes = Buffer.from([0, 0xff, 0x80, 0x61, 0x0a]);
    await repository.saveTask(scope, { ...task, plans: [{
      id: 'reviewed-plan', version: 1, format: 'markdown', content: '# RFC', status: 'approved', createdAt: task.createdAt,
      dependencyInputs: [{ taskId: 'frozen-task', identifier: 'TST-99', title: 'Snapshot', capturedAt: task.createdAt, changes: {
        format: 'git-patch', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), sha256: 'c'.repeat(64), patchEncoding: 'base64', patch: bytes.toString('base64'), files: [],
      } }],
    }] }, task.version);
    const response = await request(`/api/tasks/${task.identifier}/plans/reviewed-plan/dependencies/tst-99/patch`);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="TST-99-cccccccccccc.patch"');
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await request(`/api/tasks/${task.id}/plans/reviewed-plan/dependencies/missing/patch`)).status).toBe(404);
    expect((await request(`/api/tasks/${task.id}/plans/missing/dependencies/frozen-task/patch`)).status).toBe(404);
  });

  it('authorizes before mutations and observes only successful responses without consuming them', async () => {
    const observed: string[] = [];
    app = createHttpApp(service, artifacts, { access: {
      authorize: request => { if (request.headers.get('authorization') !== 'Bearer allowed') throw new DomainError('Credential rejected.', 403); },
      observe: async (request, response) => { observed.push(`${request.method} ${new URL(request.url).pathname}`); expect(await response.clone().json()).toBeDefined(); },
    } });
    expect((await request('/api/tasks', 'POST', { title: 'Rejected task' })).status).toBe(403);
    expect(await repository.tasks(scope)).toEqual([]);
    const headers = { authorization: 'Bearer allowed' };
    const created = await request('/api/tasks', 'POST', { title: 'Authorized task', status: 'backlog' }, headers);
    expect(created.status).toBe(201);
    expect((await created.json()).title).toBe('Authorized task');
    expect((await request('/api/tasks/missing', 'GET', undefined, headers)).status).toBe(404);
    expect((await request('/api/tasks', 'POST', { title: 'Invalid task', status: 'done' }, headers)).status).toBe(400);
    expect(observed).toEqual(['POST /api/tasks']);
  });
});

describe('RFC discussion API', () => {
  async function pendingTask() {
    const task = await service.createTask({ title: 'Discuss this RFC', status: 'backlog' });
    return repository.saveTask(scope, { ...task, status: 'in_review', phase: 'plan_review', plans: [{
      id: 'original-plan', version: 1, format: 'markdown', content: '# Initial RFC', status: 'pending', createdAt: task.createdAt,
    }] }, task.version);
  }

  it('persists repeated owner comments and agent revisions until the exact latest RFC is approved', async () => {
    const task = await pendingTask();
    const first = await request(`/api/tasks/${task.identifier.toLowerCase()}/plan-discussion`, 'POST', { planId: 'original-plan', content: '  Include keyboard navigation.  ' });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: 'todo', phase: 'planning', planDiscussion: [{ role: 'user', content: 'Include keyboard navigation.', planId: 'original-plan', userId: scope.userId }] });
    expect((await request(`/api/tasks/${task.id}/plan-discussion`, 'POST', { planId: 'original-plan', content: 'Duplicate stale submission.' })).status).toBe(409);
    expect((await request(`/api/tasks/${task.id}/approve`, 'POST', { planId: 'original-plan' })).status).toBe(409);
    await enableDispatch(); await eventually(() => claude.calls.length === 1);
    expect(claude.calls[0].request.phase).toBe('planning');
    claude.calls[0].resolve({ text: JSON.stringify({ reply: 'Keyboard navigation is covered.', content: '# Revised RFC\nKeyboard navigation checks.' }), sessionId: 'revision-session' });
    await eventually(async () => (await service.getTask(task.id)).status === 'in_review');
    const revision = await service.getTask(task.id); const secondPlan = revision.plans.at(-1)!;
    expect(secondPlan.id).not.toBe('original-plan');
    expect((await request(`/api/tasks/${task.id}/plan-discussion`, 'POST', { planId: 'original-plan', content: 'Old plan again.' })).status).toBe(409);
    expect((await request(`/api/tasks/${task.id}/plan-discussion`, 'POST', { planId: secondPlan.id, content: 'Add focus restoration too.' })).status).toBe(200);
    await eventually(() => claude.calls.length === 2);
    expect(claude.calls[1].request.phase).toBe('planning');
    claude.calls[1].resolve({ text: JSON.stringify({ reply: 'Focus restoration is now included.', content: '# Final RFC\nKeyboard navigation and focus restoration.' }), sessionId: 'revision-session' });
    await eventually(async () => (await service.getTask(task.id)).status === 'in_review');
    const discussed = await service.getTask(task.id); const latestPlan = discussed.plans.at(-1)!;
    const discussion = await (await request(`/api/tasks/${task.identifier}/plan-discussion`)).json();
    expect(discussion.map((item: { role: string; content: string }) => [item.role, item.content])).toEqual([
      ['user', 'Include keyboard navigation.'], ['assistant', 'Keyboard navigation is covered.'],
      ['user', 'Add focus restoration too.'], ['assistant', 'Focus restoration is now included.'],
    ]);
    expect(discussion.at(-1).planId).toBe(latestPlan.id);
    expect(discussed.plans).toHaveLength(3);
    await repository.saveSettings(scope, { ...await repository.settings(scope), dispatcherEnabled: false });
    expect((await request(`/api/tasks/${task.id}/approve`, 'POST', { planId: secondPlan.id })).status).toBe(409);
    expect((await request(`/api/tasks/${task.id}/approve`, 'POST', { planId: latestPlan.id })).status).toBe(200);
    expect((await service.getTask(task.id)).phase).toBe('building');
    expect(claude.calls).toHaveLength(2);
    expect((await request(`/api/tasks/${task.id}/plan-discussion`, 'POST', { planId: latestPlan.id, content: 'Too late for this approval.' })).status).toBe(409);
  });

  it('validates comments, keeps legacy requests compatible, and denies chief-authored owner reviews', async () => {
    const task = await pendingTask(); const original = await service.getTask(task.id);
    for (const body of [
      {}, { planId: 'original-plan' }, { planId: '', content: 'Comment' }, { planId: 'original-plan', content: '   ' },
      { planId: 'original-plan', content: 'x'.repeat(20_001) }, { planId: 'original-plan', content: 'Spoof', role: 'assistant' },
    ]) expect((await request(`/api/tasks/${task.id}/plan-discussion`, 'POST', body)).status).toBe(400);
    const grant = await commands.open(scope, new AbortController().signal);
    try {
      const headers = { authorization: `Bearer ${grant.cli.token}` };
      expect((await request(`/api/tasks/${task.id}/plan-discussion`, 'GET', undefined, headers)).status).toBe(200);
      expect((await request(`/api/tasks/${task.id}/plan-discussion`, 'POST', { planId: 'original-plan', content: 'Chief impersonating owner.' }, headers)).status).toBe(403);
      expect(await service.getTask(task.id)).toEqual(original);
    } finally { await grant.close(); }
    expect((await request('/api/tasks/missing/plan-discussion')).status).toBe(404);
    expect((await request('/api/tasks/missing/plan-discussion', 'POST', { planId: 'original-plan', content: 'Missing task.' })).status).toBe(404);
    const legacy = await request(`/api/tasks/${task.id}/request-changes`, 'POST', { planId: 'original-plan', feedback: 'Legacy review feedback.' });
    expect(legacy.status).toBe(200);
    expect((await legacy.json()).planDiscussion).toMatchObject([{ role: 'user', content: 'Legacy review feedback.', planId: 'original-plan' }]);
  });
});

describe('runtime integration regressions', () => {
  it('preserves status when a chief action changes only priority', async () => {
    const task = await service.createTask({ title: 'Priority only', status: 'backlog', priority: 4 });
    expect((await request('/api/chief/messages', 'POST', { content: 'Make this task urgent' })).status).toBe(202);
    await eventually(() => claude.calls.length === 1);
    expect(claude.calls[0].request.phase).toBe('chief');
    expect((await request(`/api/tasks/${task.id}`, 'PATCH', { priority: 1 }, { authorization: `Bearer ${claude.calls[0].request.chiefCli!.token}` })).status).toBe(200);
    claude.calls[0].resolve({ text: 'Priority updated.' });
    await eventually(async () => (await repository.messages(scope)).some(message => message.role === 'assistant'));
    expect(await service.getTask(task.id)).toMatchObject({ status: 'backlog', priority: 1 });
  });

  it('preserves priority when a chief action changes only status', async () => {
    const task = await service.createTask({ title: 'Status only', status: 'backlog', priority: 2 });
    await service.sendChief('Queue this task');
    await eventually(() => claude.calls.length === 1);
    expect((await request(`/api/tasks/${task.id}`, 'PATCH', { status: 'todo' }, { authorization: `Bearer ${claude.calls[0].request.chiefCli!.token}` })).status).toBe(200);
    claude.calls[0].resolve({ text: 'Task queued.' });
    await eventually(async () => (await repository.messages(scope)).some(message => message.role === 'assistant'));
    expect(await service.getTask(task.id)).toMatchObject({ status: 'todo', priority: 2 });
  });

  it('validates the saved worktree again before an approved build', async () => {
    const task = await service.createTask({ title: 'Branch validation' });
    await enableDispatch();
    await eventually(() => claude.calls.length === 1);
    claude.calls[0].resolve({ text: '# RFC\nImplement in this worktree.', sessionId: 'planning-session' });
    await eventually(async () => (await service.getTask(task.id)).status === 'in_review');
    vi.mocked(workspaces.ensure).mockRejectedValue(new Error('Worktree branch changed outside Muon'));
    const reviewed = await service.getTask(task.id);
    await service.approve(task.id, reviewed.plans[0].id);
    await eventually(async () => (await service.getTask(task.id)).status === 'blocked' || claude.calls.length > 1);
    expect(claude.calls).toHaveLength(1);
    expect((await service.getTask(task.id)).error).toContain('branch changed');
  });

  it('cannot launch a newly claimed task after shutdown begins', async () => {
    await service.createTask({ title: 'Shutdown race' });
    await repository.saveSettings(scope, { ...await repository.settings(scope), dispatcherEnabled: true });
    const saveTask = repository.saveTask.bind(repository);
    let claiming = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(repository, 'saveTask').mockImplementation(async (...args) => {
      if (args[1].status === 'in_progress' && args[1].runId) { claiming = true; await gate; }
      return saveTask(...args);
    });
    const tick = service.tick();
    await eventually(() => claiming);
    const stop = service.stop();
    release();
    await Promise.all([stop, tick]);
    await setImmediate();
    expect(claude.calls).toHaveLength(0);
  });

  it('revokes chief API writes when shutdown begins', async () => {
    await service.sendChief('Create a task');
    await eventually(() => claude.calls.length === 1);
    claude.calls[0].resolve({ text: JSON.stringify({ message: 'Created.', actions: [{ type: 'create_task', title: 'Late task', status: 'backlog' }] }) });
    await service.stop();
    expect((await request('/api/tasks', 'POST', { title: 'Late task' }, { authorization: `Bearer ${claude.calls[0].request.chiefCli!.token}` })).status).toBe(401);
    expect(await repository.tasks(scope)).toEqual([]);
  });

  it('accepts only one simultaneous chief request', async () => {
    const responses = await Promise.all([
      request('/api/chief/messages', 'POST', { content: 'First request' }),
      request('/api/chief/messages', 'POST', { content: 'Second request' }),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([202, 409]);
    expect((await repository.messages(scope)).filter(message => message.role === 'user')).toHaveLength(1);
  });

  it('does not recycle a slot when process termination was not confirmed', async () => {
    const first = await service.createTask({ title: 'First task', priority: 1 });
    await service.createTask({ title: 'Queued task', priority: 2 });
    await enableDispatch();
    await eventually(() => claude.calls.length === 1);
    claude.calls[0].reject(new AgentProcessUnreapedError());
    await eventually(async () => (await service.getTask(first.id)).status === 'blocked');
    await setImmediate();
    await service.tick();
    expect(claude.calls).toHaveLength(1);
    expect((await service.snapshot()).runtime.activeRuns).toBe(1);
  });
});
