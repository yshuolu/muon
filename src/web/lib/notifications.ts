import type { AppSnapshot, Attention, Task } from '../../shared/types';

/** Browser-local notification preferences; the server has no notification state. */
export interface NotificationPreferences { sound: boolean; system: boolean }
const STORAGE_KEY = 'muon.notifications';
const DEFAULTS: NotificationPreferences = { sound: true, system: false };

export function notificationPreferences(): NotificationPreferences {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULTS;
    const parsed = JSON.parse(stored) as Partial<NotificationPreferences>;
    return { sound: parsed.sound ?? DEFAULTS.sound, system: parsed.system ?? DEFAULTS.system };
  } catch { return DEFAULTS; }
}

export function saveNotificationPreferences(preferences: NotificationPreferences) {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); }
  catch { /* Private browsing or blocked storage: the choice lasts for this page only. */ }
}

export function systemNotificationSupport(): 'unsupported' | 'default' | 'granted' | 'denied' {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function requestSystemNotifications(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try { return (await Notification.requestPermission()) === 'granted'; }
  catch { return false; }
}

export type NotificationKind = 'approval' | 'completed' | 'blocked' | 'project_completed' | 'chief' | 'comment' | 'discussion' | 'planning';
export interface WorkspaceNotification {
  kind: NotificationKind;
  title: string;
  body: string;
  /** Deduplicates notifications for the same record across polls and browser tabs. */
  tag: string;
  taskId?: string;
}

const ATTENTION_KINDS: Record<Attention['kind'], { kind: NotificationKind; title: string }> = {
  plan_approval: { kind: 'approval', title: 'RFC ready for your review' },
  completed: { kind: 'completed', title: 'Task done' },
  blocked: { kind: 'blocked', title: 'A task needs your help' },
  project_completed: { kind: 'project_completed', title: 'Project complete' },
};

function taskLabel(task: Task | undefined, fallback: string) {
  return task ? `${task.identifier} · ${task.title}` : fallback;
}

function excerpt(text: string, limit = 140) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * Notifications implied by the change from one snapshot to the next: new attention records and new agent replies.
 * The first snapshot after opening a project produces nothing, so existing state is never announced twice.
 */
export function snapshotNotifications(previous: AppSnapshot | null, next: AppSnapshot): WorkspaceNotification[] {
  if (!previous || previous.project.id !== next.project.id) return [];
  const notifications: WorkspaceNotification[] = [];
  const knownAttention = new Set(previous.attention.map(item => item.id));
  for (const item of next.attention) {
    if (knownAttention.has(item.id)) continue;
    const task = next.tasks.find(candidate => candidate.id === item.taskId);
    const label = ATTENTION_KINDS[item.kind];
    notifications.push({ kind: label.kind, title: label.title, body: item.kind === 'project_completed' ? item.title : taskLabel(task, item.title), tag: `attention:${item.id}`, taskId: item.taskId });
  }
  const knownMessages = new Set(previous.messages.map(message => message.id));
  for (const message of next.messages) {
    if (message.role !== 'assistant' || knownMessages.has(message.id)) continue;
    notifications.push({ kind: 'chief', title: 'Chief of staff replied', body: excerpt(message.content), tag: `chief:${message.id}` });
  }
  const previousTasks = new Map(previous.tasks.map(task => [task.id, task]));
  for (const task of next.tasks) {
    const before = previousTasks.get(task.id);
    if (!before) continue;
    const knownComments = new Set((before.comments ?? []).map(comment => comment.id));
    for (const comment of task.comments ?? []) {
      if (comment.role !== 'assistant' || knownComments.has(comment.id)) continue;
      notifications.push({ kind: 'comment', title: 'Agent replied to your comment', body: `${task.identifier} · ${excerpt(comment.content, 100)}`, tag: `comment:${comment.id}`, taskId: task.id });
    }
    const knownDiscussion = new Set((before.planDiscussion ?? []).map(message => message.id));
    for (const message of task.planDiscussion ?? []) {
      if (message.role !== 'assistant' || knownDiscussion.has(message.id)) continue;
      notifications.push({ kind: 'discussion', title: 'Revised RFC and reply', body: taskLabel(task, task.title), tag: `discussion:${message.id}`, taskId: task.id });
    }
  }
  return notifications;
}

let audio: AudioContext | null = null;
let unlocked = false;
function context(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  audio ??= new AudioContext();
  return audio;
}
/** Browsers only start audio after a user gesture; resume the context on the first interaction. */
export function unlockAudio() {
  if (unlocked) return;
  const resume = () => { unlocked = true; void context()?.resume(); };
  window.addEventListener('pointerdown', resume, { once: true });
  window.addEventListener('keydown', resume, { once: true });
}

/** A short two-note chime synthesized in place, so no audio asset ships with the app. */
export function playChime(kind: NotificationKind = 'completed') {
  const ctx = context();
  if (!ctx || ctx.state !== 'running') return;
  const notes = kind === 'blocked' ? [392, 311] : kind === 'approval' || kind === 'completed' || kind === 'project_completed' ? [659, 880] : [587, 740];
  const start = ctx.currentTime;
  notes.forEach((frequency, index) => {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    const at = start + index * 0.16;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.34);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.36);
  });
}

/** Delivers one notification according to the stored preferences. System notifications only fire while the page is not focused. */
export function deliverNotification(notification: WorkspaceNotification, onOpen?: () => void) {
  const preferences = notificationPreferences();
  if (preferences.sound) playChime(notification.kind);
  if (!preferences.system || systemNotificationSupport() !== 'granted') return;
  if (document.hasFocus() && !document.hidden) return;
  try {
    const shown = new Notification(notification.title, { body: notification.body, tag: notification.tag, silent: preferences.sound });
    shown.onclick = () => { window.focus(); onOpen?.(); shown.close(); };
  } catch { /* Some platforms refuse constructor notifications; the sound already played. */ }
}
