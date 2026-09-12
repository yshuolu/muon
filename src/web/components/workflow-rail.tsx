import { Check, Code2, FileText, Lightbulb, Search, ShieldCheck } from 'lucide-react';
import type { Task } from '../../shared/types';
import { workflowProgress } from '../lib/task-workflow';

const SESSION_ICONS = { brainstorm: Lightbulb, research: Search, plan: FileText, build: Code2, verify: ShieldCheck };

export function WorkflowRail({ task }: { task: Task }) {
  const sessions = workflowProgress(task);
  return <div className="workflow-rail" aria-label="Task sessions">{sessions.map((session, index) => {
    const Icon = SESSION_ICONS[session.name];
    return <div key={session.id} aria-current={session.active ? 'step' : undefined} className={`workflow-step ${session.active ? 'active' : ''} ${session.complete ? 'complete' : ''}`}>
      <span>{session.complete ? <Check size={12} /> : <Icon size={13} />}</span>
      <b>{session.label}{session.waiting && <small>Awaiting your approval</small>}</b>
      {index < sessions.length - 1 && <i />}
    </div>;
  })}</div>;
}
