import type { Task } from '../../shared/types';
import { relationCandidates } from '../lib/task-state';
import { StatusIcon } from './common';

export function TaskRelations({ tasks, currentId, parentId, onParentChange, blockedByIds, onDependenciesChange, dependenciesDisabled = false }: {
  tasks: Task[]; currentId?: string; parentId: string | null; onParentChange?: (id: string | null) => void;
  blockedByIds: string[]; onDependenciesChange: (ids: string[]) => void; dependenciesDisabled?: boolean;
}) {
  const candidates = relationCandidates(tasks, currentId, parentId);
  const descendants = new Set<string>(currentId ? [currentId] : []);
  let previousSize = -1;
  while (descendants.size !== previousSize) {
    previousSize = descendants.size;
    tasks.forEach(task => { if (task.parentId && descendants.has(task.parentId)) descendants.add(task.id); });
  }
  return <details className="task-relations-disclosure"><summary>Parent and dependencies<span>{parentId ? tasks.find(task => task.id === parentId)?.identifier : ''}{parentId && blockedByIds.length ? ' · ' : ''}{blockedByIds.length ? `${blockedByIds.length} dependencies` : ''}</span></summary><div className="task-relations-editor">
    {onParentChange && <label className="form-label">Parent task<select value={parentId ?? ''} onChange={event => { const next = event.target.value || null; onParentChange(next); const allowed = relationCandidates(tasks, currentId, next).map(task => task.id); onDependenciesChange(blockedByIds.filter(id => allowed.includes(id))); }}><option value="">No parent</option>{tasks.filter(task => !descendants.has(task.id) && ((task.kind === 'group' && task.status !== 'canceled') || (task.phase === 'idle' && ['backlog', 'todo'].includes(task.status)) || task.id === parentId)).map(task => <option key={task.id} value={task.id}>{task.identifier} · {task.title}</option>)}</select></label>}
    <fieldset className="dependency-picker" disabled={dependenciesDisabled}><legend>Blocked by</legend><p className="field-hint">These tasks must finish successfully before this task starts.</p>{candidates.length ? <div className="dependency-options">{candidates.map(task => <label key={task.id}><input type="checkbox" checked={blockedByIds.includes(task.id)} onChange={event => onDependenciesChange(event.target.checked ? [...blockedByIds, task.id] : blockedByIds.filter(id => id !== task.id))} /><StatusIcon status={task.status} /><span><strong>{task.identifier}</strong>{' '}{task.title}</span></label>)}</div> : <p className="field-hint">No other tasks to depend on.</p>}</fieldset>
  </div></details>;
}
