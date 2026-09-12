import { useState } from 'react';
import { ArrowUpRight, FolderGit2, Plus } from 'lucide-react';
import type { AppSnapshot, CreateTaskInput, Priority, Provider, Task } from '../../shared/types';
import { PRIORITY_LABELS } from '../../shared/types';
import { WORKFLOW_LABELS } from '../../shared/workflows';
import { api } from '../lib/api';
import { approvedPlanChoices } from '../lib/task-workflow';
import { Markdown } from './common';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { TaskRelations } from './task-relations';

export function TaskDialog({ open, onOpenChange, snapshot, parent, initialTitle, initialDescription, planningChatId, onCreated }: {
  open: boolean; onOpenChange: (open: boolean) => void; snapshot: AppSnapshot; parent?: Task; initialTitle?: string; initialDescription?: string; planningChatId?: string; onCreated: (task: Task) => void;
}) {
  const [title, setTitle] = useState(initialTitle ?? '');
  const [kind, setKind] = useState<'coding' | 'group'>('coding');
  const [workflowKind, setWorkflowKind] = useState<NonNullable<CreateTaskInput['workflow']>['kind']>('develop');
  const [approvedPlanId, setApprovedPlanId] = useState('');
  const [description, setDescription] = useState(initialDescription ?? '');
  const [provider, setProvider] = useState<Provider>(parent?.provider ?? snapshot.settings.defaultProvider);
  const [priority, setPriority] = useState<Priority>(parent?.priority ?? 0);
  const [status, setStatus] = useState<'backlog' | 'todo'>('todo');
  const [labels, setLabels] = useState('');
  const [parentId, setParentId] = useState<string | null>(parent?.id ?? null);
  const [blockedByIds, setBlockedByIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const planChoices = approvedPlanChoices(snapshot);
  const selectedPlan = kind === 'coding' && workflowKind === 'develop' ? planChoices.find(choice => choice.plan.id === approvedPlanId) : undefined;
  const importingPlan = kind === 'coding' && workflowKind === 'develop' && !!approvedPlanId;
  function selectApprovedPlan(planId: string) {
    setApprovedPlanId(planId);
    const selected = planChoices.find(choice => choice.plan.id === planId);
    if (selected) {
      setTitle(selected.task.title);
      setDescription(selected.task.description);
      setBlockedByIds([...selected.task.blockedByIds]);
    }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!title.trim()) return;
    if (importingPlan && !selectedPlan) { setError('The selected RFC is no longer available. Choose a current approved plan or prepare a new plan.'); return; }
    setBusy(true); setError(null);
    const workflow: CreateTaskInput['workflow'] = workflowKind === 'develop'
      ? { kind: 'develop', ...(selectedPlan ? { params: { approvedPlan: { taskId: selectedPlan.task.id, planId: selectedPlan.plan.id } } } : {}) }
      : { kind: workflowKind };
    const input: CreateTaskInput = { title: selectedPlan?.task.title ?? title.trim(), kind, description: selectedPlan?.task.description ?? description, provider, priority, status, labels: [...new Set(labels.split(',').map(v => v.trim()).filter(Boolean))], parentId, blockedByIds: selectedPlan?.task.blockedByIds ?? blockedByIds, ...(kind === 'coding' ? { workflow } : {}) };
    try { const task = await api<Task>(planningChatId ? `/planning-chats/${planningChatId}/taskify` : '/tasks', 'POST', input); onCreated(task); onOpenChange(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create task.'); }
    finally { setBusy(false); }
  }
  const dialogDescription = kind === 'group' ? 'Organize related tasks. The group completes when all its subtasks finish successfully.' : workflowKind === 'brainstorm' ? 'Explore possibilities and save a useful set of ideas.' : workflowKind === 'research' ? 'Investigate a question and save findings, sources, and open questions.' : importingPlan ? 'Build and verify the exact scope of an approved RFC.' : 'Plan, then build after your approval and verify the result.';
  return <Dialog open={open} onOpenChange={onOpenChange} title={parent ? 'Create subtask' : planningChatId ? 'Taskify conversation' : 'Create task'} description={dialogDescription} className="new-task-dialog">
    <form onSubmit={submit}>
      <div className="dialog-project"><FolderGit2 size={14} />{snapshot.project.name}{parent && <><span>/</span>{parent.identifier}</>}</div>
      <label className="sr-only" htmlFor="task-title">Task title</label>
      <input id="task-title" className="task-title-input" placeholder="What needs to be done?" value={selectedPlan?.task.title ?? title} onChange={e => setTitle(e.target.value)} readOnly={importingPlan} required maxLength={240} autoFocus />
      <label className="sr-only" htmlFor="task-description">Description</label>
      <textarea maxLength={30000} id="task-description" className="task-description-input" placeholder="Add context, requirements, and what success looks like…" value={selectedPlan?.task.description ?? description} onChange={e => setDescription(e.target.value)} readOnly={importingPlan} rows={6} />
      <div className="form-grid">
        <label>Task type<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="coding">Task</option><option value="group">Task group</option></select></label>
        {kind === 'coding' && <label>Workflow<select value={workflowKind} onChange={event => setWorkflowKind(event.target.value as typeof workflowKind)}>{Object.entries(WORKFLOW_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
        <label>Status<select value={status} onChange={e => setStatus(e.target.value as 'backlog' | 'todo')}><option value="todo">{kind === 'group' ? 'Todo — track subtasks' : 'Todo — ready to dispatch'}</option><option value="backlog">Backlog — save for later</option></select></label>
        {kind === 'coding' && <label>Agent<select value={provider} onChange={e => setProvider(e.target.value as Provider)}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>}
        <label>Priority<select value={priority} onChange={e => setPriority(Number(e.target.value) as Priority)}>{Object.entries(PRIORITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      {kind === 'coding' && workflowKind === 'develop' && <label className="form-label">Plan<select value={approvedPlanId} onChange={event => selectApprovedPlan(event.target.value)}><option value="">Prepare a new plan for my approval</option>{planChoices.map(choice => <option key={choice.plan.id} value={choice.plan.id}>{choice.task.identifier} · {choice.task.title} · RFC v{choice.plan.version}</option>)}{approvedPlanId && !selectedPlan && <option value={approvedPlanId} disabled>Selected RFC is no longer available</option>}</select></label>}
      {importingPlan && <p className="field-hint">The title, description, and dependencies stay within this approved scope. Choose a new plan to change them. This task starts with Build, then Verify.</p>}
      {selectedPlan && <details className="approved-plan-preview"><summary>Read approved RFC v{selectedPlan.plan.version} from {selectedPlan.task.identifier}</summary>{selectedPlan.plan.format === 'html' ? <iframe title="Selected approved RFC" sandbox="" srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">${selectedPlan.plan.content}`} className="plan-html" /> : <Markdown>{selectedPlan.plan.content}</Markdown>}</details>}
      <TaskRelations tasks={snapshot.tasks} parentId={parentId} onParentChange={parent || importingPlan ? undefined : setParentId} blockedByIds={selectedPlan?.task.blockedByIds ?? blockedByIds} onDependenciesChange={setBlockedByIds} dependenciesDisabled={importingPlan} />
      {parentId && <p className="field-hint">{snapshot.tasks.find(task => task.id === parentId)?.kind === 'group' ? 'This task contributes to its parent group’s completion.' : 'The parent waits for its subtasks before starting its own workflow.'}</p>}
      <label className="form-label">Labels<input placeholder="e.g. frontend, improvement" value={labels} onChange={e => setLabels(e.target.value)} /></label>
      {kind === 'coding' && !snapshot.runtime.providers[provider] && <p className="form-notice">{provider === 'claude' ? 'Claude Code' : 'Codex'} is not detected. Install it and sign in before dispatching this task.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-footer"><span><ArrowUpRight size={13} />{kind === 'group' ? 'Add subtasks after creating this group' : status === 'todo' ? 'Dispatches when an agent is available' : 'Kept in backlog until you move it to Todo'}</span><Button type="submit" disabled={!title.trim() || busy}><Plus size={15} />{busy ? 'Creating…' : 'Create task'}</Button></div>
    </form>
  </Dialog>;
}
