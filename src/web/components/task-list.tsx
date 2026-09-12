import { ChevronDown, ChevronRight, GitBranch, Layers3, Plus, Search, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import type { AppSnapshot, Task, TaskStatus } from '../../shared/types';
import { STATUS_LABELS, PHASE_LABELS } from '../../shared/types';
import { relativeTime } from '../lib/utils';
import { EmptyState, PriorityIcon, ProviderBadge, StatusIcon } from './common';
import { Button } from './ui/button';
import { queueReasons } from '../lib/task-state';

export const STATUS_ORDER: TaskStatus[] = ['in_review', 'in_progress', 'todo', 'backlog', 'blocked', 'done', 'canceled'];
export function TaskList({ snapshot, layout, onSelect, onCreate, selectedId }: { snapshot: AppSnapshot; layout: 'list' | 'board'; onSelect: (task: Task) => void; onCreate: () => void; selectedId?: string }) {
  const tasks = snapshot.tasks;
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const filtered = tasks.filter(task => (status === 'all' || task.status === status) && `${task.title} ${task.identifier} ${task.labels.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  const groups = STATUS_ORDER.map(value => ({ status: value, tasks: filtered.filter(t => t.status === value).sort((a, b) => (a.priority || 5) - (b.priority || 5)) })).filter(group => group.tasks.length);
  return <>
    <div className="list-toolbar"><div className="filter-control"><SlidersHorizontal size={14} /><select aria-label="Filter tasks by status" value={status} onChange={e => setStatus(e.target.value)}><option value="all">All statuses</option>{STATUS_ORDER.map(value => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}</select></div><span className="toolbar-divider" /><span className="task-total">{filtered.length} {filtered.length === 1 ? 'task' : 'tasks'}</span><label className="search-control"><Search size={14} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search tasks…" aria-label="Search tasks" /><kbd>/</kbd></label></div>
    {groups.length === 0 ? <EmptyState icon={query || status !== 'all' ? <Search size={25} /> : <Layers3 size={26} />} title={query || status !== 'all' ? 'No matching tasks' : 'Make room for your next idea'} description={query || status !== 'all' ? 'Try another search or choose a different status.' : 'Choose a workflow to brainstorm ideas, research a question, or develop a change.'} action={query || status !== 'all' ? <Button variant="secondary" onClick={() => { setQuery(''); setStatus('all'); }}>Clear filters</Button> : <Button onClick={onCreate}><Plus size={15} />Create your first task</Button>} /> : <div className={layout === 'board' ? 'task-board' : 'task-groups'}>
      {groups.map(group => <section key={group.status} className={`task-group ${layout === 'board' ? 'board-column' : ''}`}>
        <div className="group-heading"><button className="group-collapse" onClick={() => setCollapsed(values => values.includes(group.status) ? values.filter(v => v !== group.status) : [...values, group.status])} aria-expanded={!collapsed.includes(group.status)}>{collapsed.includes(group.status) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<StatusIcon status={group.status} /><span>{STATUS_LABELS[group.status]}</span><span className="group-count">{group.tasks.length}</span></button><Button variant="ghost" size="icon" onClick={onCreate} aria-label={`Create task`}><Plus size={14} /></Button></div>
        {!collapsed.includes(group.status) && <div className="group-body">{group.tasks.map(task => <button key={task.id} className={`task-row ${selectedId === task.id ? 'selected' : ''}`} onClick={() => onSelect(task)}>
          <div className="task-row-leading"><PriorityIcon priority={task.priority} /><span className="task-identifier">{task.identifier}</span><StatusIcon status={task.status} /></div>
          <div className="task-row-title"><span>{task.title}</span>{task.parentId && <span className="task-parent-label" title={tasks.find(item => item.id === task.parentId)?.title}><GitBranch size={12} />{tasks.find(item => item.id === task.parentId)?.identifier}</span>}</div>
          <div className="task-row-meta">{task.labels.slice(0, 1).map(label => <span className="label-badge" key={label}><i />{label}</span>)}{task.status === 'todo' && task.kind !== 'group' && <span className="queue-label" title={queueReasons(task, snapshot).join(' · ')}>{queueReasons(task, snapshot)[0]}</span>}{task.status === 'in_progress' && task.kind !== 'group' && <span className="phase-label">{PHASE_LABELS[task.phase]}</span>}{task.kind === 'group' ? <span className="group-kind-badge"><Layers3 size={12} />{tasks.filter(item => item.parentId === task.id && item.status === 'done').length}/{tasks.filter(item => item.parentId === task.id).length} done</span> : <ProviderBadge provider={task.provider} />}<span className="task-date">{relativeTime(task.updatedAt)}</span><span className="owner-avatar" title="Owned by you">Y</span></div>
        </button>)}</div>}
      </section>)}
    </div>}
    <div className="list-footer"><span><span className="tiny-dot" />Local workspace</span><span>Built for progress. Designed for focus.</span></div>
  </>;
}
