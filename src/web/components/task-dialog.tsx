import { useState } from 'react';
import { ArrowUpRight, FolderGit2, Plus } from 'lucide-react';
import type { AppSnapshot, CreateTaskInput, Priority, Provider, Task } from '../../shared/domain';
import { PRIORITY_LABELS } from '../../shared/domain';
import { api } from '../lib/api';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { TaskRelations } from './task-relations';

export function TaskDialog({ open, onOpenChange, snapshot, parent, onCreated }: {
  open: boolean; onOpenChange: (open: boolean) => void; snapshot: AppSnapshot; parent?: Task; onCreated: (task: Task) => void;
}) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'coding' | 'group'>('coding');
  const [description, setDescription] = useState('');
  const [provider, setProvider] = useState<Provider>(parent?.provider ?? snapshot.settings.defaultProvider);
  const [priority, setPriority] = useState<Priority>(parent?.priority ?? 0);
  const [status, setStatus] = useState<'backlog' | 'todo'>('todo');
  const [labels, setLabels] = useState('');
  const [parentId, setParentId] = useState<string | null>(parent?.id ?? null);
  const [blockedByIds, setBlockedByIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!title.trim()) return;
    setBusy(true); setError(null);
    const input: CreateTaskInput = { title: title.trim(), kind, description, provider, priority, status, labels: [...new Set(labels.split(',').map(v => v.trim()).filter(Boolean))], parentId, blockedByIds };
    try { const task = await api<Task>('/tasks', 'POST', input); onCreated(task); onOpenChange(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create task.'); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange} title={parent ? 'Create subtask' : 'Create task'} description={kind === 'group' ? 'Organize related tasks. The group completes when all its subtasks finish successfully.' : 'Your agent plans first. Building begins after you approve the RFC.'} className="new-task-dialog">
    <form onSubmit={submit}>
      <div className="dialog-project"><FolderGit2 size={14} />{snapshot.project.name}{parent && <><span>/</span>{parent.identifier}</>}</div>
      <label className="sr-only" htmlFor="task-title">Task title</label>
      <input id="task-title" className="task-title-input" placeholder="What needs to be done?" value={title} onChange={e => setTitle(e.target.value)} required maxLength={240} autoFocus />
      <label className="sr-only" htmlFor="task-description">Description</label>
      <textarea maxLength={30000} id="task-description" className="task-description-input" placeholder="Add context, requirements, and what success looks like…" value={description} onChange={e => setDescription(e.target.value)} rows={6} />
      <div className="form-grid">
        <label>Task type<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="coding">Coding task</option><option value="group">Task group</option></select></label>
        <label>Status<select value={status} onChange={e => setStatus(e.target.value as 'backlog' | 'todo')}><option value="todo">{kind === 'group' ? 'Todo — track subtasks' : 'Todo — ready to dispatch'}</option><option value="backlog">Backlog — save for later</option></select></label>
        {kind === 'coding' && <label>Agent<select value={provider} onChange={e => setProvider(e.target.value as Provider)}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>}
        <label>Priority<select value={priority} onChange={e => setPriority(Number(e.target.value) as Priority)}>{Object.entries(PRIORITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      <TaskRelations tasks={snapshot.tasks} parentId={parentId} onParentChange={parent ? undefined : setParentId} blockedByIds={blockedByIds} onDependenciesChange={setBlockedByIds} />
      {parentId && <p className="field-hint">{snapshot.tasks.find(task => task.id === parentId)?.kind === 'group' ? 'This task contributes to its parent group’s completion.' : 'The parent waits for its subtasks before starting its own plan. Use its description for remaining integration work.'}</p>}
      <label className="form-label">Labels<input placeholder="e.g. frontend, improvement" value={labels} onChange={e => setLabels(e.target.value)} /></label>
      {kind === 'coding' && !snapshot.runtime.providers[provider] && <p className="form-notice">{provider === 'claude' ? 'Claude Code' : 'Codex'} is not detected. Install it and sign in before dispatching this task.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-footer"><span><ArrowUpRight size={13} />{kind === 'group' ? 'Add subtasks after creating this group' : status === 'todo' ? 'Dispatches when an agent is available' : 'Kept in backlog until you move it to Todo'}</span><Button type="submit" disabled={!title.trim() || busy}><Plus size={15} />{busy ? 'Creating…' : 'Create task'}</Button></div>
    </form>
  </Dialog>;
}
