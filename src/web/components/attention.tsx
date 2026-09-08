import { ArrowUpRight, Bell, CheckCheck, CheckCircle2, FileCheck2, ShieldAlert } from 'lucide-react';
import type { AppSnapshot, Task } from '../../shared/domain';
import { attentionNeedsAction, relativeTime, visibleAttention } from '../lib/utils';
import { EmptyState } from './common';
import { Button } from './ui/button';

export function AttentionView({ snapshot, onSelect, onRead }: { snapshot: AppSnapshot; onSelect: (task: Task) => void; onRead: (id: string) => Promise<void> }) {
  const items = visibleAttention(snapshot).sort((a, b) => {
    const actionOrder = Number(attentionNeedsAction(b, snapshot)) - Number(attentionNeedsAction(a, snapshot));
    if (actionOrder) return actionOrder;
    const priority = (id: string) => snapshot.tasks.find(task => task.id === id)?.priority || 5;
    return priority(a.taskId) - priority(b.taskId) || a.createdAt.localeCompare(b.createdAt);
  });
  return <div className="attention-view"><div className="view-intro"><span className="eyebrow">YOUR NEXT MOVE</span><h2>A little attention. A lot of progress.</h2><p>Review a plan, unblock an agent, or review completed work.</p></div>
    {items.length === 0 ? <EmptyState icon={<CheckCheck size={28} />} title="You’re all caught up" description="When an agent needs your approval or completes a task, it will appear here." /> : <div className="attention-list">{items.map(item => {
      const task = snapshot.tasks.find(t => t.id === item.taskId);
      const projectComplete = item.kind === 'project_completed';
      const completed = item.kind === 'completed' || projectComplete;
      const Icon = item.kind === 'plan_approval' ? FileCheck2 : completed ? CheckCircle2 : ShieldAlert;
      const label = item.kind === 'plan_approval' ? 'APPROVAL NEEDED' : projectComplete ? 'PROJECT COMPLETE' : completed ? 'READY FOR YOU' : 'NEEDS YOUR HELP';
      const actionLabel = item.kind === 'plan_approval' ? 'Review plan' : projectComplete ? 'See final task' : completed ? 'See results' : 'Open task';
      return <article key={item.id} className={`attention-card attention-${completed ? 'completed' : item.kind}`}>
        <div className="attention-kind-icon"><Icon size={20} /></div>
        <div className="attention-card-content">
          <div className="attention-item-meta"><span>{label}</span><span>{relativeTime(item.createdAt)}</span></div>
          <h3>{item.title}</h3><p>{item.description}</p>
          {task && <button className="attention-task-link" onClick={() => onSelect(task)}><span>{task.identifier}</span>{task.title}<ArrowUpRight size={13} /></button>}
        </div>
        <div className="attention-actions">
          {task && <Button variant={item.kind === 'plan_approval' ? 'default' : 'secondary'} size="sm" onClick={() => onSelect(task)}>{actionLabel}<ArrowUpRight size={13} /></Button>}
          {!attentionNeedsAction(item, snapshot) && <Button variant="ghost" size="sm" onClick={() => void onRead(item.id)}><Bell size={13} />Dismiss</Button>}
        </div>
      </article>;
    })}</div>}
  </div>;
}
