import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { AppSnapshot, Attention } from '../../shared/types';

export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export function relativeTime(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export function attentionNeedsAction(item: Attention, snapshot: AppSnapshot) {
  const task = snapshot.tasks.find(task => task.id === item.taskId);
  return item.kind === 'plan_approval'
    ? task?.phase === 'plan_review' && task.plans.at(-1)?.status === 'pending'
    : item.kind === 'blocked' && task?.status === 'blocked';
}

export function visibleAttention(snapshot: AppSnapshot) {
  return snapshot.attention.filter(item => attentionNeedsAction(item, snapshot) || (['completed', 'project_completed'].includes(item.kind) && !item.readAt));
}
