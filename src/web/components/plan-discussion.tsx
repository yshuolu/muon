import { useEffect, useState } from 'react';
import { ArrowUp, Check, FileCheck2, Loader2, MessageSquare, RotateCw } from 'lucide-react';
import type { Plan, Task } from '../../shared/types';
import { relativeTime } from '../lib/utils';
import { planReviewState } from '../lib/plan-review';
import { useConversationScroll } from '../lib/conversation-scroll';
import { Markdown } from './common';
import { ConversationUnreadBoundary, ConversationViewport } from './conversation-viewport';
import { Button } from './ui/button';
import { MentionTextarea } from './mention-textarea';

export function PlanDiscussion({ task, viewedPlan, userId, dispatcherEnabled, active, busy, error, onComment, onApprove, onViewLatest, onViewVersion }: {
  task: Task; viewedPlan: Plan; userId: string; dispatcherEnabled: boolean; active: boolean; busy: boolean; error: string | null;
  onComment: (planId: string, content: string) => Promise<string | false>; onApprove: (planId: string) => Promise<boolean>;
  onViewLatest: () => void; onViewVersion: (planId: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [approving, setApproving] = useState(false);
  const [submittedPlanId, setSubmittedPlanId] = useState<string | null>(null);
  const messages = task.planDiscussion ?? [];
  const scroll = useConversationScroll({ conversationKey: JSON.stringify([task.workspaceId, task.projectId, 'plan', task.id]), messages, active });
  const state = planReviewState(task, viewedPlan.id, userId, { busy: busy || sending || approving, submittedPlanId, hasDraft: Boolean(draft.trim()) });
  useEffect(() => { if (submittedPlanId && state.latest?.id !== submittedPlanId) setSubmittedPlanId(null); }, [state.latest?.id, submittedPlanId]);
  async function send(event: React.FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !state.canComment || !state.latest) return;
    const intent = scroll.beginSend();
    setSending(true);
    try {
      const messageId = await onComment(state.latest.id, content);
      if (messageId) {
        setDraft(''); setSubmittedPlanId(state.latest.id); scroll.acceptSend(intent, messageId);
      }
    } finally { setSending(false); }
  }
  const revisionLabel = state.queued ? dispatcherEnabled ? 'Revision queued' : 'Revision queued · Dispatch paused' : 'Revising the plan';
  const revisionBlocked = task.status === 'blocked' && task.phase === 'planning';
  const finished = task.status === 'done' || task.phase === 'building' || task.phase === 'verification' || state.latest?.status === 'approved';
  const placeholder = task.status === 'canceled' ? 'This task is canceled.' : revisionBlocked ? 'Resolve the revision issue to continue…' : !state.isLatest ? 'View the latest version to continue…' : state.discussing ? 'Wait for the reply in Comments before reviewing…' : state.revising ? 'You can reply when the revised plan is ready…' : finished ? 'This plan has been approved.' : 'Ask a question or describe what should change…';
  return <aside className="plan-discussion-panel" aria-label="Plan discussion">
    <div className="plan-discussion-heading"><MessageSquare size={17} /><div><h3>Discuss the plan</h3><p>{task.provider === 'claude' ? 'Claude Code' : 'Codex'} · {task.status === 'canceled' ? 'Discussion closed' : revisionBlocked ? 'Revision needs attention' : state.revising ? revisionLabel : finished ? 'Review complete' : 'Your comments shape the next version'}</p></div></div>
    <ConversationViewport scroll={scroll} className="plan-discussion-messages" label="Plan conversation">
      {messages.length === 0 ? <div className="plan-discussion-empty"><FileCheck2 size={23} /><h4>Refine it together</h4><p>Ask about the approach or leave a comment. The agent will reply and revise the RFC. You can keep discussing it before approving.</p></div> : messages.map(message => {
        const version = task.plans.find(plan => plan.id === message.planId)?.version;
        const content = <Markdown>{message.content}</Markdown>;
        return <article key={message.id} data-message-id={message.id} className={`plan-discussion-message ${message.role}`}><ConversationUnreadBoundary scroll={scroll} messageId={message.id} /><div className="plan-message-meta"><span className="plan-message-avatar" aria-hidden="true">{message.role === 'user' ? 'Y' : task.provider === 'claude' ? '✳' : '⌘'}</span><strong>{message.role === 'user' ? 'You' : task.provider === 'claude' ? 'Claude Code' : 'Codex'}</strong>{version && <button onClick={() => onViewVersion(message.planId)} aria-label={`View plan version ${version}`}>v{version}</button>}<time title={new Date(message.createdAt).toLocaleString()}>{relativeTime(message.createdAt)}</time></div>{message.role === 'assistant' && message.content.length > 1600 ? <details className="plan-long-reply"><summary>Read agent’s reply</summary>{content}</details> : content}</article>;
      })}
      {state.revising && <div className="plan-revising-status" role="status">{state.queued ? <RotateCw size={14} /> : <Loader2 size={14} className="spin" />}<div><strong>{revisionLabel}</strong><span>{state.queued ? 'Your comment is saved. The next version will appear here.' : 'The agent is considering your comment and updating the RFC.'}</span></div></div>}
    </ConversationViewport>
    {!state.isLatest && <div className="plan-discussion-historical"><span>Viewing version {viewedPlan.version}. Continue the discussion on version {state.latest?.version}.</span><Button size="sm" variant="secondary" onClick={onViewLatest}>View latest</Button></div>}
    <div className="plan-discussion-controls">
      {error && <p className="form-error" role="alert">{error}</p>}
      {!state.isOwner && <p className="plan-discussion-hint">Only the task owner can comment or approve the plan.</p>}
      {revisionBlocked && <p className="plan-discussion-hint">This revision needs attention. Resolve the issue above to continue.</p>}
      {state.discussing && <p className="plan-discussion-hint">A task comment is awaiting a reply. Open Comments to follow its progress before reviewing this RFC.</p>}
      <form className="plan-comment-form" onSubmit={send}>
        <label htmlFor={`plan-comment-${task.id}`}>Comment on the plan</label>
        <MentionTextarea id={`plan-comment-${task.id}`} placeholder={placeholder} rows={3} maxLength={20000} value={draft} disabled={!state.canComment} onChange={setDraft} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(event); } }} />
        <div className="plan-composer-bottom"><span>{state.revising ? 'Waiting for the next version' : 'A comment requests a revised RFC'}</span><Button type="submit" size="icon" aria-label="Send comment" disabled={!state.canComment || !draft.trim()}>{sending ? <Loader2 size={16} className="spin" /> : <ArrowUp size={16} />}</Button></div>
      </form>
      <div className="plan-discussion-approval"><div><strong>{state.latest?.status === 'approved' ? `Version ${state.latest.version} approved` : state.revising ? 'Building waits for your approval' : `Ready to build version ${state.latest?.version ?? viewedPlan.version}?`}</strong><p>{draft.trim() ? 'Send your comment before approving a revision.' : state.latest?.status === 'approved' ? 'Your decision is saved with this RFC.' : 'Approve the latest plan when the discussion is resolved.'}</p></div><Button disabled={!state.canApprove} onClick={async () => { if (!state.latest || !state.canApprove) return; setApproving(true); try { await onApprove(state.latest.id); } finally { setApproving(false); } }}><Check size={14} />{approving ? 'Approving…' : 'Approve plan'}</Button></div>
    </div>
  </aside>;
}
