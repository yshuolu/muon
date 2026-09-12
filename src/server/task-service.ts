import { createHash, randomUUID } from 'node:crypto';
import type { AppSnapshot, Attention, CreateTaskInput, DependencyInput, Evidence, Plan, ResultInput, SessionOutput, PlanDiscussionMessage, PlanningChat, PlanningChatMessage, RetryTaskInput, Scope, Settings, Task } from '../shared/types';
import { AgentProcessUnreapedError, type AgentAdapter, type WorkspaceProvider } from '../runtime';
import { ConflictError, DomainError, type ArtifactStore, type ChiefCommandGateway, type ChiefCommandSession, type Dispatcher, type Repository } from './ports';
import { chiefPrompt, hasPendingPlanDiscussion, parseJsonResult, planningChatPrompt, planRevisionSchema, verificationSchema } from './agent-prompts';

import { currentSessionName, defineWorkflow, sessionPhase, taskWorkflow, type SessionName } from '../shared/workflows';
import { workflowInputSchema } from '../shared/api-contract';
import { buildSessionInput, SessionRunner, SESSION_POLICIES, SESSION_SYSTEM_PROMPT } from './session-runner';
import { createSessions, initializeSessions } from './session-state';

const now = () => new Date().toISOString();
const terminal = (task: Task) => task.status === 'done' || task.status === 'canceled';
type Editable = Partial<Pick<Task, 'title' | 'description' | 'priority' | 'provider' | 'labels' | 'parentId' | 'blockedByIds'>> & { status?: 'backlog' | 'todo' | 'canceled' };
export interface ServiceOptions {
  scope: Scope; repository: Repository; artifacts: ArtifactStore; workspaces: WorkspaceProvider;
  adapters: Record<'claude' | 'codex', AgentAdapter>; demo?: boolean; chiefCommands?: ChiefCommandGateway;
}

export class TaskService implements Dispatcher {
  readonly scope: Scope;
  private active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private ticking = false;
  private tickAgain = false;
  private tickIdle: Promise<void> = Promise.resolve();
  private settingsIdle: Promise<void> = Promise.resolve();
  private mutatingRepository = false;
  private stopped = false;
  private chiefActive = false;
  private chiefActivity: string | null = null;
  private planningChats = new Map<string, PlanningChat>();
  private planningChatReservations = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private availability = { claude: false, codex: false };
  private get repo() { return this.options.repository; }
  constructor(private options: ServiceOptions) { this.scope = options.scope; }
  async initialize() {
    const results = await Promise.allSettled([this.options.adapters.claude.available(), this.options.adapters.codex.available()]);
    this.availability = { claude: results[0].status === 'fulfilled' && results[0].value, codex: results[1].status === 'fulfilled' && results[1].value };
    let interrupted = false;
    for (const record of await this.repo.tasks(this.scope)) {
      const migrated = initializeSessions(record);
      const task = migrated === record ? record : await this.repo.saveTask(this.scope, migrated, record.version);
      if (task.runId || task.status === 'in_progress') {
        interrupted = true;
        const saved = await this.change(task, { status: 'blocked', runId: undefined, error: 'The local server stopped during this run. Review the worktree, then retry.' }, 'Run interrupted; worktree and results retained.');
        await this.notify(saved, 'blocked', saved.error!);
      }
      if (task.status === 'in_review' && task.phase === 'plan_review') await this.notify(task, 'plan_approval', 'Review the RFC before implementation starts.');
      if (task.status === 'done') await this.notify(task, 'completed', task.summary);
      if (task.status === 'blocked') await this.notify(task, 'blocked', task.error ?? 'This task needs attention.');
    }
    if (await this.repo.pendingChief(this.scope)) {
      interrupted = true;
      await this.repo.appendMessage(this.scope, { id: randomUUID(), role: 'assistant', content: 'The previous request was interrupted when the server stopped. Any tasks already created have been retained. Review the task list before sending the request again.', createdAt: now() });
      await this.repo.setPendingChief(this.scope, null);
    }
    if (interrupted) await this.repo.saveSettings(this.scope, { ...await this.repo.settings(this.scope), dispatcherEnabled: false });
  }
  start() { this.timer = setInterval(() => { void this.tick().catch(console.error); }, 1000); this.timer.unref(); void this.tick().catch(console.error); }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.tickIdle;
    await this.settingsIdle;
    for (const run of this.active.values()) run.abort.abort();
    await Promise.allSettled([...this.active.values()].map(run => run.done));
  }
  async snapshot(): Promise<AppSnapshot> {
    const [project, settings, tasks, attention, messages, pending] = await Promise.all([this.repo.project(this.scope), this.repo.settings(this.scope), this.repo.tasks(this.scope), this.repo.attention(this.scope), this.repo.messages(this.scope), this.repo.pendingChief(this.scope)]);
    const config = {
      claude: { model: process.env.MUON_CLAUDE_MODEL ?? 'claude-fable-5-1[1m]', thinking: process.env.MUON_CLAUDE_EFFORT ?? 'max', bypassPermissions: process.env.MUON_AGENT_BYPASS_PERMISSIONS !== '0' },
      codex: { model: process.env.MUON_CODEX_MODEL ?? 'gpt-6-astra', thinking: process.env.MUON_CODEX_REASONING_EFFORT ?? 'ultra', bypassPermissions: process.env.MUON_AGENT_BYPASS_PERMISSIONS !== '0' },
    } as const;
    return { scope: this.scope, project, settings, tasks, attention, messages, runtime: { activeRuns: this.active.size, chiefRunning: this.chiefActive || !!pending, chiefActivity: this.chiefActive ? this.chiefActivity : null, providers: this.availability, config, demo: !!this.options.demo } };
  }
  async getTask(id: string) {
    const task = await this.repo.task(this.scope, id);
    if (!task) throw new DomainError('Task not found.', 404);
    const migrated = initializeSessions(task);
    return migrated === task ? task : this.repo.saveTask(this.scope, migrated, task.version);
  }
  private async change(task: Task, patch: Partial<Task>, activity?: string) {
    let runs = patch.runs ?? task.runs ?? [];
    let sessions = patch.sessions ?? task.sessions ?? [];
    const currentSessionId = patch.currentSessionId ?? task.currentSessionId;
    if (patch.runId && patch.runId !== task.runId) {
      const session = sessions.find(item => item.id === currentSessionId);
      if (!session) throw new DomainError('The task has no current agent session.');
      runs = [...runs, {
        id: patch.runId, phase: sessionPhase(session.name) as NonNullable<Task['runs']>[number]['phase'],
        provider: task.provider, status: 'running', startedAt: now(), planId: task.plans.at(-1)?.id,
        agentSessionId: session.id, sessionName: session.name,
      }];
      sessions = sessions.map(item => item.id === session.id ? { ...item, status: 'running' } : item);
      patch.activeSessionId = session.id;
    } else if (task.runId && Object.hasOwn(patch, 'runId') && !patch.runId) {
      const status = patch.status === 'blocked' ? 'failed' : patch.status === 'canceled' ? 'canceled' : 'succeeded';
      const providerSessionId = patch.sessionId ?? sessions.find(item => item.id === task.activeSessionId)?.providerSessionId;
      runs = runs.map(run => run.id === task.runId ? { ...run, status, finishedAt: now(), sessionId: providerSessionId, providerSessionId, error: patch.error } : run);
      sessions = sessions.map(session => session.id === task.activeSessionId ? { ...session, status, providerSessionId } : session);
      patch.activeSessionId = undefined;
    }
    return this.repo.saveTask(this.scope, { ...task, ...patch, sessions, runs, updatedAt: now(), activity: activity ? [...task.activity, { id: randomUUID(), text: activity, createdAt: now() }] : task.activity }, task.version);
  }

  private async notify(task: Task, kind: Attention['kind'], description: string) {
    const id = `${task.id}:${kind}`;
    const existing = (await this.repo.attention(this.scope)).find(item => item.id === id);
    await this.repo.putAttention(this.scope, { id, taskId: task.id, kind, title: task.title, description, createdAt: existing?.createdAt ?? now(), readAt: existing?.readAt });
  }
  private continuation(task: Task): Pick<Task, 'currentSessionId' | 'phase' | 'status' | 'completedAt'> {
    const definitions = taskWorkflow(task).sessions;
    const index = definitions.findIndex(session => session.name === currentSessionName(task));
    if (index < 0) throw new DomainError('The current session is not part of this workflow.');
    const next = definitions[index + 1];
    if (!next) return { currentSessionId: task.currentSessionId, phase: 'complete', status: 'done', completedAt: now() };
    const session = task.sessions?.find(item => item.name === next.name);
    if (!session) throw new DomainError('The next workflow session is missing.');
    return { currentSessionId: session.id, phase: sessionPhase(next.name), status: 'todo', completedAt: undefined };
  }
  private async reconcileProjectCompletion() {
    const tasks = await this.repo.tasks(this.scope);
    const existing = (await this.repo.attention(this.scope)).find(item => item.kind === 'project_completed');
    const completed = tasks.filter(task => task.status === 'done');
    if (!completed.length || tasks.some(task => !terminal(task))) {
      if (existing) await this.repo.removeAttention(this.scope, existing.taskId, 'project_completed');
      return;
    }
    if (existing) return;
    const project = await this.repo.project(this.scope);
    const last = completed.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const canceled = tasks.filter(task => task.status === 'canceled').length;
    const codingCount = completed.filter(task => task.kind !== 'group' && taskWorkflow(task).kind === 'develop').length;
    const groupCount = completed.filter(task => task.kind === 'group').length;
    const knowledgeCount = completed.length - codingCount - groupCount;
    await this.repo.putAttention(this.scope, { id: `project:${project.id}:completed`, taskId: last.id, kind: 'project_completed', title: `${project.name} is complete`, description: `${codingCount} completed coding task${codingCount === 1 ? ' has' : 's have'} passed verification.${knowledgeCount ? ` ${knowledgeCount} research or brainstorming task${knowledgeCount === 1 ? ' has' : 's have'} saved results.` : ''}${groupCount ? ` ${groupCount} task group${groupCount === 1 ? ' has' : 's have'} all subtasks complete.` : ''}${canceled ? ` ${canceled} task${canceled === 1 ? ' was' : 's were'} canceled.` : ''} No project work remains in the queue or backlog. Results and applicable evidence are ready for your review.`, createdAt: now() });
  }
  private async reconcileGroups() {
    const tasks = await this.repo.tasks(this.scope);
    const byId = new Map(tasks.map(task => [task.id, task]));
    const visited = new Set<string>();
    const reconcile = async (id: string): Promise<void> => {
      if (visited.has(id)) return;
      visited.add(id);
      const task = byId.get(id)!;
      if (task.kind !== 'group' || task.status === 'canceled') return;
      const children = tasks.filter(child => child.parentId === id);
      for (const relatedId of [...children.map(child => child.id), ...task.blockedByIds]) await reconcile(relatedId);
      const currentChildren = children.map(child => byId.get(child.id)!);
      const complete = currentChildren.length > 0 && currentChildren.every(child => child.status === 'done') && task.blockedByIds.every(blockerId => byId.get(blockerId)?.status === 'done');
      const status = complete ? 'done' : task.status === 'done' ? 'todo' : task.status;
      const summary = `${currentChildren.filter(child => child.status === 'done').length} of ${currentChildren.length} subtasks complete.${currentChildren.length ? '\n\n' + currentChildren.map(child => `${child.identifier}: ${child.title} — ${child.status}${child.summary ? '\n' + child.summary : ''}`).join('\n\n') : ''}`;
      if (task.status === status && task.summary === summary) return;
      let saved: Task;
      try {
        saved = await this.change(task, { status, phase: complete ? 'complete' : 'idle', summary, completedAt: complete ? task.completedAt ?? now() : undefined }, task.status === status ? undefined : complete ? 'All subtasks completed. Task group completed.' : 'New subtask work reopened this task group.');
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        byId.set(id, await this.getTask(id));
        return;
      }
      byId.set(id, saved);
      if (complete) await this.notify(saved, 'completed', `All ${currentChildren.length} subtasks are complete. Review their individual results and evidence.`);
      else await this.repo.removeAttention(this.scope, id, 'completed');
    };
    for (const task of tasks) await reconcile(task.id);
  }
  private async validateRelations(id: string, parentId: string | null, blockedByIds: string[]) {
    const tasks = await this.repo.tasks(this.scope);
    for (const relation of [parentId, ...blockedByIds].filter(Boolean)) {
      if (relation === id) throw new DomainError('A task cannot depend on or parent itself.');
      if (!tasks.some(task => task.id === relation)) throw new DomainError('Related tasks must belong to this project.');
    }
    const parent = tasks.find(task => task.id === parentId);
    const current = tasks.find(task => task.id === id);
    if (parent && parentId !== current?.parentId && (parent.kind === 'group' ? parent.status === 'canceled' : !['backlog', 'todo'].includes(parent.status) || parent.phase !== 'idle')) throw new DomainError('Add subtasks to an active task group or before their coding parent starts.');
    const candidate = { id, parentId, blockedByIds };
    const nodes = [...tasks.filter(task => task.id !== id), candidate];
    const children = (taskId: string) => nodes.filter(task => task.parentId === taskId).map(task => task.id);
    const visiting = new Set<string>(); const done = new Set<string>();
    const visit = (taskId: string): void => {
      if (visiting.has(taskId)) throw new DomainError('This relation would create a hierarchy or dependency cycle.');
      if (done.has(taskId)) return;
      visiting.add(taskId);
      const node = nodes.find(item => item.id === taskId);
      for (const next of [...(node?.blockedByIds ?? []), ...children(taskId)]) visit(next);
      visiting.delete(taskId); done.add(taskId);
    };
    for (const node of nodes) visit(node.id);
  }
  private async approvedPlanInput(input: CreateTaskInput): Promise<Plan | undefined> {
    const reference = input.workflow?.kind === 'develop' ? input.workflow.params?.approvedPlan : undefined;
    if (!reference) return undefined;
    const source = await this.getTask(reference.taskId);
    const plan = source.plans.at(-1);
    if (source.ownerUserId !== this.scope.userId || plan?.reviewedBy !== this.scope.userId) {
      throw new DomainError('Only the owner may reuse an approved plan.', 403);
    }
    if (source.kind === 'group' || taskWorkflow(source).kind !== 'develop' || source.status === 'canceled'
      || plan?.id !== reference.planId || plan.status !== 'approved' || !plan.reviewedAt) {
      throw new DomainError('The supplied plan is not the current approved RFC.', 409);
    }
    const dependencies = (ids: string[]) => [...new Set(ids)].sort().join('\0');
    if (input.title.trim() !== source.title || (input.description ?? '') !== source.description
      || dependencies(input.blockedByIds ?? []) !== dependencies(source.blockedByIds)) {
      throw new DomainError('An approved plan can only be reused with its original title, description, and dependencies. Create a new plan for changed scope.');
    }
    if ((await this.repo.tasks(this.scope)).some(task => task.parentId === source.id)) {
      throw new DomainError('Plans with subtasks require a new integration plan.');
    }
    const baseCommit = plan.baseCommit ?? source.worktree?.baseCommit;
    if (!baseCommit && !this.options.demo) throw new DomainError('The approved plan has no retained repository base. Create a new plan.');
    return { ...plan, id: randomUUID(), version: 1, source: { ...reference }, baseCommit };
  }

  async createTask(input: CreateTaskInput) {
    if (!input.title.trim()) throw new DomainError('Task title cannot be empty.');
    if (input.workflow) input = { ...input, workflow: workflowInputSchema.parse(input.workflow) };
    if (input.kind === 'group' && input.workflow) throw new DomainError('Task groups do not have agent workflows.');
    const workflow = input.kind === 'group' ? undefined : defineWorkflow(input.workflow);
    const approvedPlan = await this.approvedPlanInput(input);
    const sessions = workflow ? createSessions(workflow) : [];
    const id = randomUUID(); const timestamp = now();
    await this.validateRelations(id, input.parentId ?? null, input.blockedByIds ?? []);
    const settings = await this.repo.settings(this.scope);
    const task = await this.repo.insertTask(this.scope, {
      id, identifier: '', ...this.scope, ownerUserId: this.scope.userId,
      title: input.title.trim(), description: input.description ?? '', status: input.status ?? 'todo', phase: approvedPlan ? 'building' : 'idle', kind: input.kind ?? 'coding',
      priority: input.priority ?? 0, provider: input.provider ?? settings.defaultProvider, labels: [...new Set(input.labels?.map(label => label.trim()) ?? [])],
      parentId: input.parentId ?? null, blockedByIds: [...new Set(input.blockedByIds ?? [])], plans: approvedPlan ? [approvedPlan] : [], planDiscussion: [], evidence: [], changedFiles: [],
      workflow, sessions, currentSessionId: sessions[0]?.id, outputs: [], sessionSystemPrompt: SESSION_SYSTEM_PROMPT,
      summary: '', runs: [], activity: [{ id: randomUUID(), text: 'Task created.', createdAt: timestamp }], createdAt: timestamp, updatedAt: timestamp, version: 1,
    });
    await this.reconcileGroups();
    await this.reconcileProjectCompletion();
    void this.tick().catch(console.error);
    return this.getTask(task.id);
  }
  async editTask(id: string, input: Editable) {
    input = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Editable;
    const task = await this.getTask(id);
    if (input.status === 'canceled') {
      if (task.status === 'done') throw new DomainError('Completed tasks cannot be canceled.');
      this.active.get(task.id)?.abort.abort();
      const saved = await this.change(task, { status: 'canceled', runId: undefined }, 'Task canceled. Worktree retained.');
      await this.repo.removeAttention(this.scope, id);
      await this.reconcileGroups();
      await this.reconcileProjectCompletion();
      return saved;
    }
    if (task.status === 'canceled' && input.parentId === null && Object.keys(input).every(key => key === 'parentId')) {
      const saved = await this.change(task, { parentId: null }, 'Canceled task removed from its parent. Results retained.');
      await this.reconcileGroups();
      await this.reconcileProjectCompletion();
      return saved;
    }
    const unstartedImport = !!task.workflow?.params?.approvedPlan && !task.runId && !task.runs?.length
      && ['backlog', 'todo'].includes(task.status);
    if (unstartedImport) {
      if (Object.keys(input).some(key => !['status', 'priority', 'provider', 'labels'].includes(key))) {
        throw new DomainError('The imported RFC fixes this task’s scope. Create a new plan to change the title, description, or dependencies.');
      }
    } else if (task.kind === 'group' ? task.status === 'canceled' : !['backlog', 'todo'].includes(task.status) || task.phase !== 'idle') {
      throw new DomainError('Only unstarted tasks and active task groups can be edited. Use plan feedback or retry for work already underway.');
    }
    if (input.title !== undefined) {
      if (!input.title.trim()) throw new DomainError('Task title cannot be empty.');
      input.title = input.title.trim();
    }
    if (input.labels) input.labels = [...new Set(input.labels.map(label => label.trim()))];
    await this.validateRelations(id, input.parentId === undefined ? task.parentId : input.parentId, input.blockedByIds ?? task.blockedByIds);
    const saved = await this.change(task, input, 'Task updated.');
    await this.reconcileGroups();
    await this.reconcileProjectCompletion();
    void this.tick().catch(console.error);
    return this.getTask(saved.id);
  }
  async approve(id: string, planId: string) {
    const task = await this.getTask(id);
    if (task.ownerUserId !== this.scope.userId) throw new DomainError('Only the task owner may approve its RFC.', 403);
    const current = task.plans.at(-1);
    if (task.status !== 'in_review' || task.phase !== 'plan_review' || current?.id !== planId || current.status !== 'pending') throw new DomainError('This RFC is no longer awaiting approval. Refresh to review the latest version.', 409);
    const plans = task.plans.map(plan => plan.id === planId ? { ...plan, status: 'approved' as const, reviewedAt: now(), reviewedBy: this.scope.userId } : plan);
    const saved = await this.change(task, { ...this.continuation(task), plans, sessionId: undefined, error: undefined }, `RFC v${current.version} approved by owner. Implementation queued.`);
    await this.repo.removeAttention(this.scope, id, 'plan_approval');
    void this.tick().catch(console.error);
    return saved;
  }
  async requestChanges(id: string, planId: string, feedback: string) {
    return this.commentOnPlan(id, planId, feedback);
  }
  async commentOnPlan(id: string, planId: string, content: string) {
    const task = await this.getTask(id);
    if (task.ownerUserId !== this.scope.userId) throw new DomainError('Only the task owner may review its RFC.', 403);
    const feedback = content.trim();
    if (!feedback || feedback.length > 20_000) throw new DomainError('Plan comments must contain between 1 and 20,000 characters.');
    const current = task.plans.at(-1);
    if (task.kind === 'group' || task.runId || task.status !== 'in_review' || task.phase !== 'plan_review' || current?.id !== planId || current.status !== 'pending') throw new DomainError('This RFC is no longer awaiting review. Wait for the latest revision before commenting.', 409);
    const timestamp = now();
    const message: PlanDiscussionMessage = { id: randomUUID(), role: 'user', content: feedback, createdAt: timestamp, planId, userId: this.scope.userId };
    const plans = task.plans.map(plan => plan.id === planId ? { ...plan, status: 'changes_requested' as const, feedback, reviewedAt: timestamp, reviewedBy: this.scope.userId } : plan);
    // The comment and revoked review are one versioned write: a concurrent approval
    // or comment can win, but neither can silently overwrite the other.
    const saved = await this.change(task, { plans, planDiscussion: [...(task.planDiscussion ?? []), message], status: 'todo', phase: 'planning', error: undefined }, `Owner commented on RFC v${current.version}. Plan revision queued.`);
    await this.repo.removeAttention(this.scope, id, 'plan_approval');
    void this.tick().catch(console.error);
    return saved;
  }
  async retry(id: string, input: RetryTaskInput = {}) {
    if (this.active.has(id)) throw new DomainError('The previous agent has not confirmed shutdown. Inspect and stop it before restarting Muon.');
    const task = await this.getTask(id);
    if (task.status !== 'blocked') throw new DomainError('Only blocked tasks can be retried.');
    if (task.kind === 'group') throw new DomainError('Task groups do not run agents. Resolve their subtasks instead.');
    const mode = input.mode ?? 'retry';
    if (!['retry', 'resume', 'fix', 'replan'].includes(mode)) throw new DomainError('Unknown recovery mode.');
    const currentName = currentSessionName(task);
    const currentSession = task.sessions?.find(session => session.id === task.currentSessionId);
    if (mode === 'resume' && !currentSession?.providerSessionId) throw new DomainError('This task has no saved provider session to resume. Retry the current session instead.');
    if ((mode === 'fix' || mode === 'replan') && taskWorkflow(task).kind !== 'develop') throw new DomainError('Only Develop tasks can fix an implementation or replan. Retry this session instead.');
    if (mode === 'fix' && currentName !== 'build' && currentName !== 'verify') throw new DomainError('Only implementation or verification failures can return to building. Replan instead.');
    if (mode === 'replan' && task.ownerUserId !== this.scope.userId) throw new DomainError('Only the task owner may request a replacement RFC.', 403);
    const name = mode === 'replan' ? 'plan' : mode === 'fix' ? 'build' : currentName;
    if (SESSION_POLICIES[name].requiresApprovedPlan && task.plans.at(-1)?.status !== 'approved') throw new DomainError('An approved RFC is required before implementation.');
    const workflow = mode === 'replan' ? defineWorkflow() : taskWorkflow(task);
    const existing = task.sessions ?? [];
    const start = workflow.sessions.findIndex(session => session.name === name);
    const sessions = workflow.sessions.map((definition, index) => {
      const session = existing.find(item => item.name === definition.name) ?? createSessions({ ...workflow, sessions: [definition] })[0];
      return index < start || mode === 'resume' ? session : { ...session, status: 'pending' as const, providerSessionId: undefined, input: undefined, inputDigest: undefined };
    });
    const feedback = input.feedback?.trim() ?? '';
    const plans = mode === 'replan' ? task.plans.map((plan, index) => index === task.plans.length - 1 ? { ...plan, status: 'changes_requested' as const, feedback: feedback || 'Replan after the interrupted or failed task.', reviewedAt: now(), reviewedBy: this.scope.userId } : plan) : task.plans;
    const recovery = { mode, feedback, requestedAt: now() };
    const saved = await this.change(task, {
      status: 'todo', phase: sessionPhase(name), workflow, sessions, currentSessionId: sessions[start].id,
      error: undefined, runId: undefined, sessionId: mode === 'resume' ? currentSession?.providerSessionId : undefined, plans, recovery,
    }, mode === 'replan' ? 'Replanning requested. A new RFC requires owner approval before implementation.' : mode === 'fix' ? 'Implementation remediation queued within the approved RFC.' : mode === 'resume' ? 'Interrupted session resume queued.' : 'Session retry queued.');
    await this.repo.removeAttention(this.scope, id, 'blocked');
    void this.tick().catch(console.error);
    return saved;
  }
  async markRead(id: string) {
    const attention = (await this.repo.attention(this.scope)).find(item => item.id === id);
    if (!attention) throw new DomainError('Attention item not found.', 404);
    await this.repo.putAttention(this.scope, { ...attention, readAt: now() });
  }
  async updateSettings(input: Partial<Settings> & { repositoryPath?: string; projectName?: string }) {
    // Serialize configuration writes, including a harmless name/limit save racing a repository switch.
    const previousSettings = this.settingsIdle;
    let releaseSettings!: () => void;
    this.settingsIdle = new Promise<void>(resolve => { releaseSettings = resolve; });
    await previousSettings;
    try {
      const { repositoryPath, projectName, ...settings } = input;
      const project = await this.repo.project(this.scope);
      const changingRepository = repositoryPath !== undefined && repositoryPath !== project.repositoryPath;
      if (changingRepository) {
        this.mutatingRepository = true;
        // Let an already-admitted dispatch decision settle before checking capacity; block new ticks.
        await this.tickIdle;
        if (this.active.size) throw new DomainError('Pause and wait for active agents before changing the repository.');
        if ((await this.repo.tasks(this.scope)).some(task => task.worktree && !terminal(task))) throw new DomainError('Finish or cancel tasks with worktrees before changing the repository.');
        if (repositoryPath) {
          try { await this.options.workspaces.validateRepository?.(repositoryPath); }
          catch (error) { throw new DomainError(`Choose a Git repository root with at least one commit. ${error instanceof Error ? error.message : ''}`.trim()); }
        }
      }
      if (changingRepository || projectName !== undefined) {
        await this.repo.saveProject(this.scope, { ...project, ...(changingRepository ? { repositoryPath } : {}), ...(projectName !== undefined ? { name: projectName } : {}) });
      }
      await this.repo.saveSettings(this.scope, { ...await this.repo.settings(this.scope), ...settings });
    } finally {
      this.mutatingRepository = false;
      releaseSettings();
      void this.tick().catch(console.error);
    }
  }
  async sendChief(content: string) {
    if (this.chiefActive) throw new DomainError('The chief of staff is still active. Wait for it to finish.', 409);
    const message = { id: randomUUID(), role: 'user' as const, content, createdAt: now() };
    if (!await this.repo.enqueueChief(this.scope, message)) throw new DomainError('The chief of staff is already working. Wait for the final response.', 409);
    void this.tick().catch(console.error);
    return message;
  }
  createPlanningChat(): PlanningChat {
    const timestamp = now();
    const chat: PlanningChat = { id: randomUUID(), messages: [], createdAt: timestamp, updatedAt: timestamp, busy: false, activity: null };
    this.planningChats.set(chat.id, chat);
    return chat;
  }
  getPlanningChat(id: string): PlanningChat {
    const chat = this.planningChats.get(id);
    if (!chat) throw new DomainError('Planning chat not found or already discarded.', 404);
    return chat;
  }
  async sendPlanningChat(id: string, content: string) {
    const chat = this.getPlanningChat(id);
    if (chat.busy || this.planningChatReservations.has(id)) throw new DomainError('The planning chat is still waiting for a reply.', 409);
    const settings = await this.repo.settings(this.scope);
    if (this.active.size + this.planningChatReservations.size >= settings.maxConcurrentAgents) throw new DomainError('All agent slots are busy. Wait for one to become available.', 409);
    this.planningChatReservations.add(id);
    const project = await this.repo.project(this.scope);
    const message: PlanningChatMessage = { id: randomUUID(), role: 'user', content, createdAt: now() };
    chat.messages = [...chat.messages, message]; chat.updatedAt = now(); chat.error = undefined; chat.busy = true; chat.activity = 'Thinking through your idea…';
    const abort = new AbortController();
    const key = `planning-chat:${id}`;
    const done = Promise.resolve().then(async () => {
      const cwd = await this.readOnlyDirectory(`chat-${id}`, project.repositoryPath);
      const result = await this.options.adapters.claude.run({ provider: 'claude', session: 'chat', access: 'read-only', input: { systemPrompt: SESSION_SYSTEM_PROMPT, instructions: planningChatPrompt(project, chat.messages), context: JSON.stringify({ project, messages: chat.messages }) }, cwd, signal: abort.signal, onProgress: activity => { if (this.planningChats.get(id) === chat) chat.activity = activity; } });
      if (this.planningChats.get(id) !== chat || abort.signal.aborted) return;
      const reply: PlanningChatMessage = { id: randomUUID(), role: 'assistant', content: result.text.trim(), createdAt: now() };
      chat.messages = [...chat.messages, reply]; chat.updatedAt = now();
    }).catch(error => {
      if (this.planningChats.get(id) !== chat || abort.signal.aborted) return;
      chat.error = error instanceof Error ? error.message : String(error); chat.updatedAt = now();
    }).finally(() => {
      chat.busy = false; chat.activity = null; this.active.delete(key); this.planningChatReservations.delete(id); void this.tick().catch(console.error);
    });
    this.active.set(key, { abort, done });
    return message;
  }
  async taskifyPlanningChat(id: string, input: CreateTaskInput) {
    const chat = this.getPlanningChat(id);
    if (chat.busy) throw new DomainError('Wait for the planning reply before creating the task.', 409);
    const transcript = chat.messages.map(message => `**${message.role === 'user' ? 'You' : 'Planning partner'}:**\n${message.content}`).join('\n\n');
    const context = transcript ? `\n\n## Planning conversation\n\n${transcript}` : '';
    const importingPlan = input.workflow?.kind === 'develop' && input.workflow.params?.approvedPlan;
    const description = importingPlan ? input.description ?? '' : `${input.description ?? ''}${context}`.slice(0, 30_000);
    const task = await this.createTask({ ...input, description });
    this.planningChats.delete(id);
    return task;
  }
  discardPlanningChat(id: string) {
    this.getPlanningChat(id);
    this.active.get(`planning-chat:${id}`)?.abort.abort();
    this.planningChats.delete(id);
  }
  async tick() {
    if (this.stopped || this.mutatingRepository) return;
    if (this.ticking) { this.tickAgain = true; return this.tickIdle; }
    this.ticking = true;
    let releaseTick!: () => void;
    this.tickIdle = new Promise<void>(resolve => { releaseTick = resolve; });
    try {
      do {
        this.tickAgain = false;
        await this.dispatchOnce();
      } while (this.tickAgain && !this.stopped && !this.mutatingRepository);
    } finally { this.ticking = false; releaseTick(); }
  }
  private async dispatchOnce() {
      await this.reconcileGroups();
      await this.reconcileProjectCompletion();
      const settings = await this.repo.settings(this.scope);
      if (this.active.size >= settings.maxConcurrentAgents) return;
      const pending = await this.repo.pendingChief(this.scope);
      if (this.stopped) return;
      if (pending && !this.chiefActive) this.launchChief();
      if (!settings.dispatcherEnabled) return;
      const project = await this.repo.project(this.scope);
      const tasks = await this.repo.tasks(this.scope);
      const eligible = tasks.filter(task => task.kind !== 'group' && task.status === 'todo' && !task.runId && !this.active.has(task.id)
        && task.blockedByIds.every(id => tasks.find(item => item.id === id)?.status === 'done')
        && tasks.filter(item => item.parentId === task.id).every(item => item.status === 'done'));
      eligible.sort((a, b) => (a.priority || 5) - (b.priority || 5) || a.createdAt.localeCompare(b.createdAt));
      for (const task of eligible) {
        if (this.active.size >= settings.maxConcurrentAgents || this.stopped) break;
        const name = currentSessionName(task);
        const policy = SESSION_POLICIES[name];
        if (policy.requiresRepository && !project.repositoryPath) continue;
        if (!taskWorkflow(task).sessions.some(session => session.name === name)) {
          const saved = await this.change(task, { status: 'blocked', error: 'The current session is not part of this workflow.' });
          await this.notify(saved, 'blocked', saved.error!);
          continue;
        }
        if (policy.requiresApprovedPlan && task.plans.at(-1)?.status !== 'approved') {
          const saved = await this.change(task, { status: 'blocked', error: 'The latest RFC requires owner approval.' }, 'Dispatch blocked: no approved RFC.');
          await this.notify(saved, 'blocked', saved.error!); continue;
        }
        const definitions = taskWorkflow(task).sessions;
        const previous = definitions.slice(0, definitions.findIndex(session => session.name === name));
        if (previous.some(definition => task.sessions?.find(session => session.name === definition.name)?.status !== 'succeeded')) {
          const saved = await this.change(task, { status: 'blocked', error: 'An earlier workflow session has not completed. Retry the unfinished session first.' });
          await this.notify(saved, 'blocked', saved.error!);
          continue;
        }
        try {
          const claimed = await this.change(task, { runId: randomUUID(), status: 'in_progress', phase: sessionPhase(name) }, `${name[0].toUpperCase()}${name.slice(1)} session started.`);
          if (this.stopped) { await this.change(claimed, { status: 'todo', runId: undefined }); break; }
          this.launchSession(claimed, name);
        } catch (error) { if (!(error instanceof ConflictError)) throw error; }
      }
  }
  private launchSession(task: Task, name: SessionName) {
    const abort = new AbortController();
    let canRelease = true;
    const done = Promise.resolve().then(() => this.runSession(task, name, abort.signal)).catch(async error => {
      if (error instanceof AgentProcessUnreapedError) canRelease = false;
      await this.fail(task.id, task.runId!, error);
      if (!canRelease) {
        const current = await this.getTask(task.id);
        const saved = await this.change(current, { error: error.message }, 'Agent shutdown is unconfirmed. Its capacity slot is retained.');
        await this.notify(saved, 'blocked', saved.error!);
      }
    }).finally(async () => {
      if (canRelease) {
        const current = await this.getTask(task.id);
        if (current.status === 'canceled' && current.worktree) {
          try {
            const changedFiles = await this.options.workspaces.changedFiles(current.worktree);
            await this.change(current, { changedFiles });
          } catch { /* Cancellation has already been persisted; retain its last known file list. */ }
        }
        this.active.delete(task.id);
      }
      void this.tick().catch(console.error);
    });
    this.active.set(task.id, { abort, done });
  }
  private async readOnlyDirectory(taskId: string, repositoryPath: string): Promise<string> {
    if (repositoryPath) return repositoryPath;
    if (!this.options.workspaces.ensureScratch) throw new DomainError('The workspace provider cannot prepare a repository-free session.');
    return (await this.options.workspaces.ensureScratch({ taskId })).path;
  }
  private async runSession(task: Task, name: SessionName, signal: AbortSignal) {
    const project = await this.repo.project(this.scope);
    const policy = SESSION_POLICIES[name];
    if (policy.requiresRepository && !project.repositoryPath) throw new DomainError('Set a Git repository path in workspace settings to start Develop tasks.');
    let current = await this.getTask(task.id);
    if (current.runId !== task.runId || signal.aborted) return;
    let worktree = current.worktree;
    let cwd: string;
    if (policy.requiresRepository) {
      worktree = await this.options.workspaces.ensure({
        repositoryPath: project.repositoryPath, taskId: task.id,
        baseRef: current.plans.at(-1)?.baseCommit,
      });
      if (current.worktree && (current.worktree.path !== worktree.path || current.worktree.branch !== worktree.branch || current.worktree.baseCommit !== worktree.baseCommit)) throw new DomainError('The task worktree identity changed. Inspect its branch and base before retrying.');
      cwd = worktree.path;
      current = await this.getTask(task.id);
      if (current.runId !== task.runId || signal.aborted) return;
      current = await this.change(current, { worktree });
    } else {
      cwd = await this.readOnlyDirectory(task.id, project.repositoryPath);
    }
    const allTasks = await this.repo.tasks(this.scope);
    const related = new Map<string, Task>();
    const visitRelated = (item: Task) => {
      if (related.has(item.id)) return;
      if (item.id === task.id || item.status !== 'done') throw new DomainError('Integration inputs must come from completed tasks.');
      related.set(item.id, item);
      if (item.kind === 'group') {
        const children = allTasks.filter(child => child.parentId === item.id);
        if (!children.length) throw new DomainError('A dependency group must have completed subtasks before integration.');
        for (const child of children) visitRelated(child);
        for (const id of item.blockedByIds) {
          const dependency = allTasks.find(candidate => candidate.id === id);
          if (!dependency) throw new DomainError('A completed group dependency is no longer available.');
          visitRelated(dependency);
        }
      }
    };
    for (const item of allTasks.filter(item => item.parentId === task.id || current.blockedByIds.includes(item.id))) visitRelated(item);
    const relatedTasks = [...related.values()];
    let dependencyInputs: DependencyInput[] = [];
    let resultInputs: ResultInput[];
    if (!policy.requiresApprovedPlan) {
      resultInputs = relatedTasks.filter(item => item.kind !== 'group').map(item => {
        const result = { taskId: item.id, identifier: item.identifier, summary: item.summary, outputs: item.outputs ?? [] };
        return { ...result, sha256: createHash('sha256').update(JSON.stringify(result)).digest('hex'), capturedAt: now() };
      });
      let totalBytes = Buffer.byteLength(JSON.stringify(resultInputs));
      if (totalBytes > 512 * 1024) throw new DomainError('Combined dependency results exceed 512 KiB. Split this task.');
      if (name === 'plan') for (const dependency of relatedTasks.filter(item => item.kind !== 'group' && taskWorkflow(item).kind === 'develop')) {
        if (!this.options.workspaces.exportChanges || !dependency.worktree) {
          if (this.options.demo) continue;
          throw new DomainError(`Cannot export completed task ${dependency.identifier}. Its workspace provider must supply the dependency's actual changes before an integration RFC can be reviewed.`);
        }
        const changes = await this.options.workspaces.exportChanges(dependency.worktree);
        totalBytes += Buffer.byteLength(changes.patch);
        if (totalBytes > 512 * 1024) throw new DomainError('Combined dependency patches exceed 512 KiB. Split this integration task; no partial context was supplied.');
        dependencyInputs.push({ taskId: dependency.id, identifier: dependency.identifier, title: dependency.title, capturedAt: now(), changes });
      }
    } else {
      const approved = current.plans.at(-1);
      if (!approved || approved.status !== 'approved' || approved.reviewedBy !== current.ownerUserId) throw new DomainError('The latest RFC requires owner approval.');
      dependencyInputs = approved.dependencyInputs ?? [];
      resultInputs = approved.resultInputs ?? [];
      if (!this.options.demo && relatedTasks.some(item => item.kind !== 'group' && taskWorkflow(item).kind === 'develop' && !dependencyInputs.some(input => input.taskId === item.id))) throw new DomainError('The approved RFC has no snapshot of these dependency changes. Request a new RFC before integrating them.');
      if (relatedTasks.some(item => item.kind !== 'group' && taskWorkflow(item).kind !== 'develop' && !resultInputs.some(input => input.taskId === item.id))) throw new DomainError('The approved RFC has no snapshot of these dependency results. Request a new RFC.');
    }
    current = await this.getTask(task.id);
    if (current.runId !== task.runId || signal.aborted) return;
    const session = current.sessions?.find(item => item.id === current.activeSessionId);
    if (!session || session.name !== name) throw new DomainError('The active agent session changed.');
    const frozenRelated = relatedTasks.map(item => {
      const result = resultInputs.find(input => input.taskId === item.id);
      return result ? { ...item, summary: result.summary, outputs: result.outputs } : item;
    });
    const input = buildSessionInput(current, name, frozenRelated, dependencyInputs, resultInputs);
    const inputDigest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    current = await this.change(current, {
      sessions: current.sessions!.map(item => item.id === session.id ? { ...item, input, inputDigest } : item),
      runs: current.runs?.map(run => run.id === current.runId ? { ...run, input, inputDigest } : run),
    });
    if (signal.aborted || this.stopped) return;
    const result = await new SessionRunner(this.options.adapters).run(session, input, {
      provider: current.provider, cwd, signal,
    });
    current = await this.getTask(task.id);
    if (current.runId !== task.runId || signal.aborted) return;
    if (!result.text.trim()) throw new DomainError('The agent returned no final result.');
    if (result.text.length > 300_000) throw new DomainError('The session result exceeds 300,000 characters.');
    if (name === 'brainstorm' || name === 'research') {
      const output: SessionOutput = {
        id: randomUUID(), sessionId: session.id, runId: task.runId!,
        kind: name === 'brainstorm' ? 'ideas' : 'report', content: result.text.trim(), format: 'markdown', createdAt: now(),
      };
      const saved = await this.change(current, {
        outputs: [...(current.outputs ?? []), output], summary: output.content,
        ...this.continuation(current), runId: undefined,
        sessionId: result.sessionId,
      }, `${name === 'brainstorm' ? 'Brainstorm' : 'Research'} session completed. Result saved.`);
      await this.notify(saved, 'completed', saved.summary);
      return;
    }
    if (!worktree) throw new DomainError('Develop sessions require an isolated worktree.');
    if (name === 'plan') {
      let revision: { reply: string; content: string } | undefined;
      if (hasPendingPlanDiscussion(current)) {
        try { revision = planRevisionSchema.parse(parseJsonResult(result.text)); }
        catch { throw new DomainError('The agent did not return a valid review reply and complete revised RFC. Your comment is saved; retry planning to continue the conversation.'); }
      }
      const content = revision?.content ?? result.text;
      const plan = { id: randomUUID(), version: current.plans.length + 1, format: !revision && /^\s*(<!doctype html|<html)/i.test(content) ? 'html' as const : 'markdown' as const, content, status: 'pending' as const, createdAt: now(), dependencyInputs, resultInputs, baseCommit: worktree.baseCommit };
      const planDiscussion: PlanDiscussionMessage[] = revision ? [...(current.planDiscussion ?? []), { id: randomUUID(), role: 'assistant', content: revision.reply, createdAt: plan.createdAt, planId: plan.id }] : current.planDiscussion ?? [];
      const saved = await this.change(current, { plans: [...current.plans, plan], planDiscussion, phase: 'plan_review', status: 'in_review', runId: undefined, sessionId: result.sessionId ?? current.sessionId }, `RFC v${plan.version} is ready for owner review.`);
      await this.notify(saved, 'plan_approval', 'Review and approve the RFC to start implementation.');
      return;
    }
    if (name === 'build') {
      const changedFiles = await this.options.workspaces.changedFiles(worktree);
      current = await this.getTask(task.id);
      if (current.runId !== task.runId || signal.aborted) return;
      await this.change(current, { ...this.continuation(current), summary: result.text, changedFiles, runId: undefined, sessionId: result.sessionId }, 'Implementation finished. Verification queued.');
      return;
    }
    const verification = verificationSchema.parse(parseJsonResult(result.text));
    const evidence: Evidence[] = [];
    let failedAttachments = 0;
    for (const item of verification.evidence) {
      const { artifactPath, ...record } = item;
      const identity = { id: randomUUID(), createdAt: now(), runId: task.runId };
      try {
        const artifactUrl = artifactPath ? await this.options.artifacts.importFile(this.scope, task.id, worktree.path, artifactPath) : undefined;
        evidence.push({ ...record, ...identity, artifactUrl });
      } catch (error) {
        failedAttachments += 1;
        const message = error instanceof Error ? error.message : String(error);
        const description = `${record.description}\n\nAttachment ${artifactPath} could not be stored: ${message}`;
        // Preserve the observed test result/caption even when its optional supporting asset is unavailable.
        evidence.push({ ...record, ...identity, kind: record.kind === 'screenshot' || record.kind === 'recording' ? 'note' : record.kind, description });
        evidence.push({ id: randomUUID(), kind: 'test', title: `Store attachment: ${record.title}`, description: `Evidence attachment could not be retained: ${message}`, result: 'failed', steps: [`Import ${artifactPath} from the task worktree into managed evidence storage.`], createdAt: now(), runId: task.runId });
      }
    }
    const changedFiles = await this.options.workspaces.changedFiles(worktree);
    current = await this.getTask(task.id);
    if (current.runId !== task.runId || signal.aborted) return;
    const testEvidence = evidence.filter(item => item.kind === 'test');
    const verified = testEvidence.some(item => item.result === 'passed') && !testEvidence.some(item => item.result === 'failed' || item.result === 'skipped');
    const error = verified ? undefined : failedAttachments ? `Verification requires attention: ${failedAttachments} evidence attachment${failedAttachments === 1 ? '' : 's'} could not be stored. Test steps, results, and available assets were retained. Inspect the evidence before retrying.` : 'Verification did not pass all reported tests. Inspect the evidence, then retry verification, fix the implementation, or request a new RFC.';
    const saved = await this.change(current, { ...(verified ? this.continuation(current) : { status: 'blocked' as const, phase: 'verification' as const, completedAt: undefined }), evidence: [...current.evidence, ...evidence], changedFiles, summary: verification.summary, runId: undefined, sessionId: result.sessionId, error }, verified ? 'Verification passed. Task completed; branch retained for review.' : 'Verification requires attention.');
    await this.notify(saved, verified ? 'completed' : 'blocked', verified ? verification.summary : saved.error!);
  }
  private async fail(id: string, runId: string, error: unknown) {
    const task = await this.getTask(id);
    if (task.runId !== runId || task.status === 'canceled') return;
    let changedFiles = task.changedFiles;
    if (task.worktree) try { changedFiles = await this.options.workspaces.changedFiles(task.worktree); } catch { /* Preserve the primary execution failure. */ }
    const message = error instanceof Error ? error.message : String(error);
    const latest = await this.getTask(id);
    if (latest.runId !== runId) return;
    const saved = await this.change(latest, { status: 'blocked', runId: undefined, changedFiles, error: message }, 'Agent stopped; owner attention needed.');
    await this.notify(saved, 'blocked', message);
  }
  private launchChief() {
    this.chiefActive = true;
    this.chiefActivity = 'Preparing workspace context…';
    const abort = new AbortController();
    let canRelease = true;
    let commands: ChiefCommandSession | undefined;
    const done = Promise.resolve().then(async () => {
      const [project, messages] = await Promise.all([this.repo.project(this.scope), this.repo.messages(this.scope)]);
      if (!this.options.chiefCommands && !this.options.demo) throw new DomainError('The chief command interface is not configured. Start Muon through its HTTP server.');
      if (this.stopped || abort.signal.aborted) return;
      this.chiefActivity = 'Connecting task controls…';
      commands = await this.options.chiefCommands?.open(this.scope, abort.signal);
      if (this.stopped || abort.signal.aborted) return;
      this.chiefActivity = 'Running Claude Code…';
      const cwd = await this.readOnlyDirectory(`chief-${createHash('sha256').update(JSON.stringify(this.scope)).digest('hex').slice(0, 16)}`, project.repositoryPath);
      if (this.stopped || abort.signal.aborted) return;
      const result = await this.options.adapters.claude.run({ provider: 'claude', session: 'chief', access: 'read-only', input: { systemPrompt: SESSION_SYSTEM_PROMPT, instructions: chiefPrompt(project, messages, commands?.cli.command), context: JSON.stringify({ project }) }, cwd, signal: abort.signal, onProgress: activity => { this.chiefActivity = activity; }, chiefCli: commands?.cli });
      if (this.stopped || abort.signal.aborted) return;
      const content = result.text.trim();
      if (!content || content.length > 30_000) throw new DomainError('The chief returned an empty or oversized final response. Applied task changes are retained.');
      this.chiefActivity = 'Applying task updates…';
      // Task operations have already gone through CLI -> REST -> TaskService. A
      // model's final text is display-only and never interpreted as commands.
      await this.repo.appendMessage(this.scope, { id: randomUUID(), role: 'assistant', content, createdAt: now(), taskIds: commands?.taskIds() ?? [] });
    }).catch(async error => {
      if (error instanceof AgentProcessUnreapedError) canRelease = false;
      await this.repo.appendMessage(this.scope, { id: randomUUID(), role: 'assistant', content: `I couldn't complete this request. ${error instanceof Error ? error.message : String(error)} Any task changes already saved through the CLI are retained.`, createdAt: now(), taskIds: commands?.taskIds() ?? [] });
    }).finally(async () => {
      await commands?.close().catch(error => console.error("Chief command cleanup failed", error));
      await this.repo.setPendingChief(this.scope, null);
      if (canRelease) { this.chiefActive = false; this.chiefActivity = null; this.active.delete('chief'); }
      void this.tick().catch(console.error);
    });
    this.active.set('chief', { abort, done });
  }
}
