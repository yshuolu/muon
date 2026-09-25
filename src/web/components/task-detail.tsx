import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, CheckCheck, ChevronRight, Code2, File, FileCheck2, FileText, GitBranch, Layers3, Pencil, Plus, ShieldCheck, X } from 'lucide-react';
import type { AppSnapshot, Asset, Priority, Provider, Task } from '../../shared/types';
import { PHASE_LABELS, PRIORITY_LABELS, STATUS_LABELS } from '../../shared/types';
import { api } from '../lib/api';
import { relativeTime } from '../lib/utils';
import { EmptyState, FileChanges, Markdown, PriorityIcon, ProviderBadge, StatusIcon } from './common';
import { Button } from './ui/button';
import { EffortSelect } from './effort-select';
import { MentionTextarea } from './mention-textarea';
import { Dialog } from './ui/dialog';
import { PlanDependencies } from './plan-dependencies';
import { TaskRelations } from './task-relations';
import { TaskRecovery } from './task-recovery';
import { VerificationEvidence } from './verification-evidence';
import { queueReasons } from '../lib/task-state';
import { displayedPlan } from '../lib/plan-review';
import { PlanDiscussion } from './plan-discussion';
import { AssetsPanel } from './assets-panel';
import { AssetReferenceList } from './asset-preview';
import { taskAssetIds } from '../../shared/asset-references';
import { TaskComments } from './task-comments';

type Tab = 'overview' | 'plan' | 'comments' | 'evidence' | 'assets' | 'files';
type PlanPane = 'document' | 'discussion';
interface TaskViewState {
  tab: Tab;
  planVersion: string | null;
  planPane: PlanPane;
  documentPositions: Map<string, number>;
}
const TASK_VIEW_STATES = new Map<string, TaskViewState>();

export function TaskDetail({ task, snapshot, onClose, onRefresh, onSelect, onSubtask, onOpenLibrary, backLabel }: { task: Task; snapshot: AppSnapshot; onClose: () => void; onRefresh: () => void; onSelect: (task: Task) => void; onSubtask: (task: Task) => void; onOpenLibrary?: (assetId: string | null) => void; backLabel: string }) {
  const viewKey = JSON.stringify([task.workspaceId, task.projectId, task.id]);
  const cachedView = useRef(TASK_VIEW_STATES.get(viewKey));
  const [tab, setTab] = useState<Tab>(cachedView.current?.tab ?? (task.kind === 'group' ? 'overview' : task.phase === 'plan_review' ? 'plan' : task.status === 'done' ? 'evidence' : 'overview'));
  const [planPane, setPlanPane] = useState<PlanPane>(cachedView.current?.planPane ?? 'discussion');
  const [narrowPlan, setNarrowPlan] = useState(() => window.matchMedia('(max-width: 850px)').matches);
  const documentPane = useRef<HTMLDivElement>(null);
  const documentPositions = useRef(cachedView.current?.documentPositions ?? new Map<string, number>());
  const [busy, setBusy] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [importingPath, setImportingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [labels, setLabels] = useState(task.labels.join(', '));
  const [parentId, setParentId] = useState(task.parentId);
  const [blockedByIds, setBlockedByIds] = useState(task.blockedByIds);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [task.id]);
  const [planVersion, setPlanVersion] = useState<string | null>(cachedView.current?.planVersion ?? null);
  const latestPlan = task.plans.at(-1);
  const plan = displayedPlan(task.plans, planVersion);
  const viewPlanVersion = (id: string) => {
    setPlanVersion(id === latestPlan?.id ? null : id);
    if (narrowPlan) setPlanPane('document');
  };
  useEffect(() => {
    const query = window.matchMedia('(max-width: 850px)');
    const update = () => setNarrowPlan(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    TASK_VIEW_STATES.delete(viewKey);
    TASK_VIEW_STATES.set(viewKey, { tab, planVersion, planPane, documentPositions: documentPositions.current });
    if (TASK_VIEW_STATES.size > 100) {
      const oldest = TASK_VIEW_STATES.keys().next().value;
      if (oldest !== undefined) TASK_VIEW_STATES.delete(oldest);
    }
  }, [viewKey, tab, planVersion, planPane]);
  useLayoutEffect(() => {
    const element = documentPane.current;
    if (!element || !plan || tab !== 'plan' || narrowPlan && planPane !== 'document') return;
    element.scrollTop = documentPositions.current.get(plan.id) ?? 0;
  }, [plan?.id, tab, narrowPlan, planPane]);
  const assetIds = taskAssetIds(task);
  const subtasks = snapshot.tasks.filter(t => t.parentId === task.id);
  const parent = snapshot.tasks.find(t => t.id === task.parentId);
  const isGroup = task.kind === 'group';
  const conversationWorkspace = !isGroup && (tab === 'comments' || tab === 'plan' && Boolean(plan));
  const agentConfig = snapshot.runtime.config?.[task.provider] ?? (task.provider === 'claude' ? { model: 'claude-fable-5-1[1m]', thinking: 'max', bypassPermissions: true } : { model: 'gpt-6-astra', thinking: 'ultra', bypassPermissions: true });
  const waiting = queueReasons(task, snapshot);
  const unstarted = ['backlog', 'todo'].includes(task.status) && task.phase === 'idle';
  const ended = task.status === 'done' || task.status === 'canceled';
  // Scope can change until the RFC is approved; metadata until the task ends; the agent and Backlog/Todo before it starts.
  const canEdit = isGroup ? task.status !== 'canceled' : !ended && task.plans.at(-1)?.status !== 'approved';
  const canEditMeta = isGroup ? task.status !== 'canceled' : !ended;
  const scopeRestartsPlanning = !isGroup && canEdit && !unstarted;
  const canCancel = !['done', 'canceled'].includes(task.status);
  const canRetainFiles = task.ownerUserId === snapshot.scope.userId && !task.runId && task.status !== 'in_progress';
  const footerNote = isGroup ? (task.status === 'done' ? 'All subtasks completed' : `${subtasks.filter(child => child.status === 'done').length} of ${subtasks.length} subtasks completed`) : task.status === 'todo' ? waiting[0] : task.status === 'done' ? (task.worktree ? 'Verification complete · Branch retained' : 'Verification complete')
    : task.status === 'canceled' ? 'Task canceled'
    : task.status === 'blocked' ? 'Resolve the issue, then retry'
    : task.phase === 'plan_review' ? 'Waiting for your approval'
    : task.status === 'in_progress' ? (task.worktree ? 'Working in an isolated worktree' : 'Agent is working')
    : task.status === 'backlog' ? 'Move to Todo when ready'
    : snapshot.settings.dispatcherEnabled ? 'Waiting for an agent · Plans first' : 'Dispatch paused';
  async function mutateTask(path: string, method: string, body: unknown): Promise<Task | null> {
    setBusy(true); setError(null);
    try { const updated = await api<Task>(path, method, body); onRefresh(); return updated; }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update task.'); return null; }
    finally { setBusy(false); }
  }
  const mutate = async (path: string, method: string, body: unknown) => await mutateTask(path, method, body) !== null;
  const update = (body: unknown) => mutate(`/tasks/${task.id}`, 'PATCH', body);
  async function openChangedFile(path: string) {
    setImportingPath(path);
    setError(null);
    try {
      const asset = await api<Asset>(`/tasks/${task.id}/assets/import`, 'POST', { path });
      setSelectedAssetId(asset.id);
      setTab('assets');
      document.getElementById('tab-assets')?.focus();
      onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open this file as an asset.');
    } finally { setImportingPath(null); }
  }
  return <section className="task-detail" aria-label={`${task.identifier}: ${task.title}`}>
    <div className="detail-breadcrumb"><button onClick={onClose}><ArrowLeft size={15} />{backLabel}</button><ChevronRight size={13} /><span>{task.identifier}</span><span className="detail-breadcrumb-spacer" /><Button variant="ghost" size="icon" aria-label="Close task" onClick={onClose}><X size={17} /></Button></div>
    <div className={`detail-scroll${conversationWorkspace ? ' conversation-workspace' : ''}${tab === 'plan' && plan ? ' plan-review-workspace' : ''}`}>
      <div className="detail-main-heading">{parent && <button className="parent-link" onClick={() => onSelect(parent)}><Layers3 size={13} />{parent.identifier}<ChevronRight size={12} />{parent.title}</button>}<div className="detail-title-row"><h1 ref={heading} tabIndex={-1}>{task.title}</h1>{canEdit && <Button variant="ghost" size="icon" aria-label="Edit task" onClick={() => { setTitle(task.title); setDescription(task.description); setLabels(task.labels.join(', ')); setParentId(task.parentId); setBlockedByIds(task.blockedByIds); setEditing(true); }}><Pencil size={15} /></Button>}</div><div className="detail-heading-meta"><span className={`status-pill status-${task.status}`}><StatusIcon status={task.status} />{STATUS_LABELS[task.status]}</span>{isGroup ? <span className="group-kind-badge"><Layers3 size={12} />Task group</span> : <><ProviderBadge provider={task.provider} /><span className="detail-agent-config"><code>{agentConfig.model}</code><span>Thinking: {agentConfig.thinking}</span></span></>}<span className="detail-updated">Updated {relativeTime(task.updatedAt).toLowerCase()}</span></div></div>
      {!isGroup && <div className="workflow-rail" aria-label="Task workflow">{([{ phase: 'planning', label: 'Plan', icon: FileText }, { phase: 'plan_review', label: 'Your review', icon: FileCheck2 }, { phase: 'building', label: 'Build', icon: Code2 }, { phase: 'verification', label: 'Verify', icon: ShieldCheck }] as const).map((step, index) => {
        const current = ['idle', 'planning', 'plan_review', 'building', 'verification', 'complete'].indexOf(task.phase);
        const complete = current > index + 1;
        return <div key={step.phase} className={`workflow-step ${task.phase === step.phase ? 'active' : ''} ${complete ? 'complete' : ''}`}><span>{complete ? <Check size={12} /> : <step.icon size={13} />}</span><b>{step.label}</b>{index < 3 && <i />}</div>;
      })}</div>}
      {task.status === 'blocked' && !isGroup && <TaskRecovery task={task} busy={busy} onRetry={input => mutate(`/tasks/${task.id}/retry`, 'POST', input)} />}
      {task.status === 'canceled' && parent && <div className="queue-explanation"><strong>This canceled task still belongs to {parent.identifier}</strong><p>Remove it from the parent if this work is no longer in scope. Its results and cancellation history stay available.</p><Button size="sm" variant="secondary" disabled={busy} onClick={() => void update({ parentId: null })}>Remove from parent</Button></div>}
      {isGroup && task.error && <p className="task-error">{task.error}</p>}
      {waiting.length > 0 && <div className="queue-explanation"><strong>{isGroup ? 'Group progress' : 'In the queue'}</strong>{waiting.map(reason => <p key={reason}>{reason}</p>)}</div>}
      {error && !(tab === 'plan' && plan) && tab !== 'comments' && <p className="form-error detail-error" role="alert">{error}</p>}
      <div className="detail-tabs" role="tablist" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
        const current = buttons.indexOf(event.target as HTMLButtonElement);
        if (current < 0) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next].click(); buttons[next].focus();
      }}>{([{ id: 'overview', label: 'Overview', count: 0 }, { id: 'plan', label: 'Plan', count: task.plans.length }, { id: 'comments', label: 'Comments', count: task.comments?.length ?? 0 }, { id: 'evidence', label: 'Evidence', count: task.evidence.length }, { id: 'assets', label: 'Assets', count: assetIds.length }, { id: 'files', label: 'Changes', count: task.changedFiles.length }] as const).filter(item => !isGroup || item.id === 'overview' || item.id === 'assets').map(item => <button key={item.id} id={`tab-${item.id}`} aria-controls={`panel-${item.id}`} role="tab" tabIndex={tab === item.id ? 0 : -1} aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}{item.id === 'plan' && latestPlan?.status === 'pending' ? <i className="review-dot" /> : item.count > 0 ? <span>{item.count}</span> : null}</button>)}</div>
      <div className={`detail-tab-content ${tab === 'plan' && plan ? 'plan-tab-content' : tab === 'comments' ? 'comments-tab-content' : tab === 'assets' ? 'assets-tab-content' : ''}`} id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} role="tabpanel">
        {tab === 'overview' && <>
          {assetIds.length > 0 && <button className="task-assets-link" onClick={() => { setTab('assets'); document.getElementById('tab-assets')?.focus(); }}><FileText size={19} /><span><strong>{assetIds.length} {assetIds.length === 1 ? 'referenced file' : 'referenced files'}</strong><small>Read documents and preview files</small></span><span>View assets<ChevronRight size={14} /></span></button>}
          <div className="overview-grid"><div className="overview-content">{task.summary && <div className="result-summary"><div className="section-label"><CheckCheck size={15} />{isGroup ? 'Group result' : 'Agent’s final result'}</div><Markdown>{task.summary}</Markdown></div>}<div className="section-label">Description</div>{task.description ? <Markdown>{task.description}</Markdown> : <p className="muted">No description yet. Add context to help your agent get started.</p>}
            <div className="section-heading"><h3>Subtasks <span>{subtasks.filter(child => child.status === 'done').length} / {subtasks.length} done</span></h3>{canEditMeta && <Button variant="ghost" size="sm" onClick={() => onSubtask(task)}><Plus size={13} />Add subtask</Button>}</div>
            {subtasks.length ? <><div className="subtask-progress-note">{isGroup ? 'This group completes when all subtasks finish successfully. Each coding subtask has its own plan and results.' : 'This task starts after its subtasks finish. Its RFC covers the remaining integration work.'}</div><div className="subtask-list">{subtasks.map(child => <button key={child.id} onClick={() => onSelect(child)}><StatusIcon status={child.status} /><span className="task-identifier">{child.identifier}</span><span>{child.title}</span><ChevronRight size={13} /></button>)}</div></> : <div className="subtask-empty"><Layers3 size={16} /><span>{canEdit ? 'Break this work into smaller tasks.' : 'This task has no subtasks.'}</span></div>}
            {task.blockedByIds.length > 0 && <><div className="section-heading"><h3>Blocked by</h3></div><div className="subtask-list">{task.blockedByIds.map(id => { const dependency = snapshot.tasks.find(t => t.id === id); return dependency ? <button key={id} onClick={() => onSelect(dependency)}><StatusIcon status={dependency.status} /><span className="task-identifier">{dependency.identifier}</span><span>{dependency.title}</span><ChevronRight size={13} /></button> : <p key={id} className="muted">Dependency unavailable</p>; })}</div></>}
            {task.activity.length > 0 && <><div className="section-heading"><h3>Milestones</h3></div><div className="activity-list">{task.activity.slice().reverse().map(activity => <div key={activity.id}><i /><span>{activity.text}</span><time>{relativeTime(activity.createdAt)}</time></div>)}</div></>}
          </div><aside className="task-properties"><h3>Properties</h3><label>Status<select value={task.status} disabled={busy || !canCancel} onChange={e => void update({ status: e.target.value })}>{!['backlog', 'todo', 'canceled'].includes(task.status) && <option value={task.status}>{STATUS_LABELS[task.status]}</option>}<option value="backlog" disabled={isGroup ? !canEditMeta : !unstarted}>Backlog</option><option value="todo" disabled={isGroup ? !canEditMeta : !unstarted}>Todo</option><option value="canceled">Canceled</option></select></label><label>Priority<div className="property-select"><PriorityIcon priority={task.priority} /><select value={task.priority} disabled={busy || !canEditMeta} onChange={e => void update({ priority: Number(e.target.value) as Priority })}>{Object.entries(PRIORITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div></label>{!isGroup && <label>Agent<select value={task.provider} disabled={busy || !unstarted} onChange={e => void update({ provider: e.target.value as Provider, effort: null })}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>}{!isGroup && <label>Thinking<EffortSelect className="" provider={task.provider} value={task.effort} defaultLevel={agentConfig.thinking} disabled={busy || !canEditMeta} label="Thinking effort" onChange={effort => void update({ effort })} /></label>}<label>Owner<div className="owner-property"><span className="owner-avatar">Y</span>You</div></label><label>Project<div className="project-property"><span className="project-icon">{snapshot.project.name.slice(0, 1).toUpperCase()}</span>{snapshot.project.name}</div></label><label>Labels<div className="property-labels">{task.labels.length ? task.labels.map(label => <span key={label} className="label-badge"><i />{label}</span>) : <span className="muted">None</span>}</div></label>{task.worktree && <label>Branch<div className="branch-property"><GitBranch size={13} /><code>{task.worktree.branch}</code></div></label>}</aside></div>
        </>}
        {tab === 'plan' && !plan && <EmptyState icon={<FileText size={26} />} title="Every good build starts with a plan" description={task.status === 'backlog' ? 'Move this task to Todo when you’re ready. Your agent will prepare an RFC for your approval.' : 'Your agent’s RFC will appear here when planning is complete. You review it before any building begins.'} />}
        {plan && !isGroup && <div className="plan-tab-panel" hidden={tab !== 'plan'}>
          <div className="plan-mobile-switch" role="group" aria-label="Plan view"><button type="button" aria-pressed={planPane === 'document'} onClick={() => setPlanPane('document')}><FileText size={14} />RFC</button><button type="button" aria-pressed={planPane === 'discussion'} onClick={() => setPlanPane('discussion')}>Discussion</button></div>
          <div className={`plan-review-layout plan-pane-${planPane}`}>
          <div className="plan-document-pane" ref={documentPane} hidden={narrowPlan && planPane !== 'document'} onScroll={event => { if (event.currentTarget.clientHeight > 0) documentPositions.current.set(plan.id, event.currentTarget.scrollTop); }} tabIndex={0} aria-label={`RFC version ${plan.version}`}><div className="plan-content"><div className="plan-document-header"><div><span className="document-icon"><FileText size={20} /></span><div><h3>Request for comments</h3><p>{plan.id !== latestPlan?.id ? 'Earlier revision' : task.status === 'canceled' ? 'Task canceled' : task.status === 'blocked' && task.phase === 'planning' ? 'Revision needs attention' : plan.status === 'approved' ? 'Approved by you' : plan.status === 'changes_requested' ? 'A revision is on the way' : 'Ready for your review'} · {relativeTime(plan.createdAt)}</p></div></div><select aria-label="Plan version" value={plan.id} onChange={e => viewPlanVersion(e.target.value)}>{task.plans.map(p => <option key={p.id} value={p.id}>Version {p.version}{p.id === latestPlan?.id ? ' · latest' : ''}</option>)}</select></div>
          {plan.id !== latestPlan?.id && <div className="plan-version-notice"><span>You’re reading version {plan.version}. Version {latestPlan?.version} is the latest.</span><Button size="sm" variant="secondary" onClick={() => setPlanVersion(null)}>View latest version</Button></div>}
          {plan.feedback && !task.planDiscussion?.some(message => message.role === 'user' && message.planId === plan.id) && <div className="plan-feedback"><strong>Your review comment</strong><p>{plan.feedback}</p></div>}
          <PlanDependencies plan={plan} tasks={snapshot.tasks} onSelect={onSelect} />
          {plan.format === 'html' && <AssetReferenceList text={plan.content} />}
          <div className="plan-document">{plan.format === 'html' ? <iframe title={`RFC version ${plan.version}`} sandbox="" srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">${plan.content}`} className="plan-html" /> : <Markdown>{plan.content}</Markdown>}</div>
          </div></div>
          <div className="plan-discussion-slot" hidden={narrowPlan && planPane !== 'discussion'}><PlanDiscussion task={task} viewedPlan={plan} userId={snapshot.scope.userId} dispatcherEnabled={snapshot.settings.dispatcherEnabled} active={tab === 'plan' && (!narrowPlan || planPane === 'discussion')} busy={busy} error={error} onComment={async (planId, content) => {
            const updated = await mutateTask(`/tasks/${task.id}/plan-discussion`, 'POST', { planId, content });
            return updated?.planDiscussion?.findLast(message => message.role === 'user' && message.planId === planId && message.content === content)?.id ?? false;
          }} onApprove={planId => mutate(`/tasks/${task.id}/approve`, 'POST', { planId })} onViewLatest={() => setPlanVersion(null)} onViewVersion={viewPlanVersion} /></div>
          </div>
        </div>}
        {!isGroup && <div className="task-comments-tab" hidden={tab !== 'comments'}><TaskComments task={task} userId={snapshot.scope.userId} dispatcherEnabled={snapshot.settings.dispatcherEnabled} active={tab === 'comments'} busy={busy} error={error} onComment={async input => {
          const updated = await mutateTask(`/tasks/${task.id}/comments`, 'POST', input);
          return updated?.comments?.find(message => message.requestId === input.requestId)?.id ?? false;
        }} onRetry={() => mutate(`/tasks/${task.id}/comments/retry`, 'POST', {})} /></div>}
        {tab === 'evidence' && <VerificationEvidence task={task} />}
        {tab === 'assets' && <AssetsPanel task={task} userId={snapshot.scope.userId} selectedId={selectedAssetId} onSelect={setSelectedAssetId} onRefresh={onRefresh} onOpenLibrary={onOpenLibrary} />}
        {tab === 'files' && (task.changedFiles.length === 0 ? <EmptyState icon={<Code2 size={26} />} title="A clear view of what changed" description="Files changed in this task’s isolated worktree will appear here, with additions and deletions." /> : <div className="files-content">{task.worktree && <div className="files-branch"><GitBranch size={15} /><span>{task.worktree.branch}</span><span>Isolated worktree</span></div>}<div className="files-summary"><strong>{task.changedFiles.length} files changed</strong><FileChanges additions={task.changedFiles.reduce((sum, file) => sum + file.additions, 0)} deletions={task.changedFiles.reduce((sum, file) => sum + file.deletions, 0)} /></div><div className="changed-files">{task.changedFiles.map(file => <div key={file.path}><File size={15} /><code>{file.path}</code><span className="file-status" title={file.status}>{file.status}</span><FileChanges additions={file.additions} deletions={file.deletions} />{!['D', 'deleted'].includes(file.status) && task.worktree && <Button variant="ghost" size="sm" disabled={importingPath !== null || !canRetainFiles} title={canRetainFiles ? 'Retain this file and open its preview' : 'The task owner can retain files after the task has stopped'} onClick={() => void openChangedFile(file.path)} aria-label={`Open ${file.path} as asset`}>{importingPath === file.path ? 'Opening…' : 'Open as asset'}</Button>}</div>)}</div></div>)}
      </div>
    </div>
    <div className="detail-footer"><span><StatusIcon status={task.status} size={13} />{isGroup ? 'Task group' : PHASE_LABELS[task.phase]}</span><span>{task.worktree && <GitBranch size={12} />}{footerNote}</span></div>
    <Dialog open={editing} onOpenChange={setEditing} title="Edit task" description={scopeRestartsPlanning ? 'Changing the title or description stops the current planning and prepares a new RFC for your approval.' : 'Keep the task’s goals and acceptance criteria clear.'}><form className="edit-task-form" onSubmit={async e => { e.preventDefault(); if (await update({ title: title.trim(), description, labels: [...new Set(labels.split(',').map(value => value.trim()).filter(Boolean))], parentId, blockedByIds })) setEditing(false); }}><label>Title<input value={title} onChange={e => setTitle(e.target.value)} required maxLength={240} /></label><label>Description<MentionTextarea value={description} onChange={setDescription} rows={7} maxLength={30000} placement="below" /></label><label>Labels<input value={labels} onChange={event => setLabels(event.target.value)} placeholder="frontend, improvement" /></label><TaskRelations tasks={snapshot.tasks} currentId={task.id} parentId={parentId} onParentChange={setParentId} blockedByIds={blockedByIds} onDependenciesChange={setBlockedByIds} />{error && <p role="alert" className="form-error">{error}</p>}<div className="dialog-footer"><Button variant="ghost" type="button" onClick={() => setEditing(false)}>Cancel</Button><Button type="submit" disabled={busy || !title.trim()}>{busy ? 'Saving…' : 'Save task'}</Button></div></form></Dialog>
  </section>;
}
