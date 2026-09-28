import { useEffect, useMemo, useState, type RefObject } from 'react';
import { Check, FileCheck2, Loader2, MessageSquarePlus, MessageSquareText, RotateCw, Sparkles, X } from 'lucide-react';
import type { AssetCommentAnchor, Plan, PlanDiscussionMessage, Task } from '../../shared/types';
import { planReviewState } from '../lib/plan-review';
import { relativeTime } from '../lib/utils';
import { Markdown } from './common';
import { MentionTextarea } from './mention-textarea';
import { CommentCard, PROVIDER_LABELS, focusHighlight, orderComments, useDocumentSelection, useHighlightClicks, type ReviewComment } from './review-comments';
import { Button } from './ui/button';

interface PlanReviewComment extends ReviewComment { planId: string }

/** Owner comments as cards with the agent reply that answered each; agent notes without a target stay separate. */
export function planComments(task: Task): { comments: PlanReviewComment[]; notes: PlanDiscussionMessage[] } {
  const messages = task.planDiscussion ?? [];
  const replies = new Map<string, PlanDiscussionMessage>();
  const notes: PlanDiscussionMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    if (message.replyToIds?.length) for (const id of message.replyToIds) replies.set(id, message);
    else notes.push(message);
  }
  // A comment answered before per-comment replies existed is paired with the note that followed it.
  const legacy = [...messages];
  const comments = messages.filter(message => message.role === 'user').map(message => {
    let reply = replies.get(message.id);
    if (!reply) {
      const index = legacy.indexOf(message);
      const following = legacy.slice(index + 1).find(item => item.role === 'assistant' && !item.replyToIds?.length);
      if (following && task.plans.some(plan => plan.id === following.planId && plan.createdAt > message.createdAt)) reply = following;
    }
    const comment: PlanReviewComment = {
      id: message.id, content: message.content, anchor: message.anchor, createdAt: message.createdAt, planId: message.planId,
      status: reply ? 'resolved' : 'pending',
      ...(reply ? { reply: { kind: reply.kind ?? 'changed', content: reply.content, createdAt: reply.createdAt, provider: task.provider } } : {}),
    };
    return comment;
  });
  const paired = new Set(comments.map(comment => comment.reply && !replies.has(comment.id) ? comment.reply.content + comment.reply.createdAt : ''));
  return { comments, notes: notes.filter(note => !paired.has(note.content + note.createdAt)) };
}

/**
 * The RFC review sidebar: select a passage of the RFC (or comment on the whole RFC), collect comments, then send
 * them all in one revision request. Replies come back beside each comment with the next RFC version.
 */
export function PlanComments({ task, viewedPlan, userId, dispatcherEnabled, active, busy, error, containerRef, onComment, onRevise, onEditComment, onDeleteComment, onApprove, onViewLatest, onViewVersion }: {
  task: Task; viewedPlan: Plan; userId: string; dispatcherEnabled: boolean; active: boolean; busy: boolean; error: string | null;
  containerRef: RefObject<HTMLDivElement | null>;
  onComment: (planId: string, content: string, anchor?: AssetCommentAnchor) => Promise<boolean>;
  onRevise: (planId: string) => Promise<boolean>;
  onEditComment: (messageId: string, content: string) => Promise<boolean>;
  onDeleteComment: (messageId: string) => Promise<boolean>;
  onApprove: (planId: string) => Promise<boolean>;
  onViewLatest: () => void; onViewVersion: (planId: string) => void;
}) {
  const [draft, setDraft] = useState<{ anchor?: AssetCommentAnchor; content: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [approving, setApproving] = useState(false);
  const [submittedPlanId, setSubmittedPlanId] = useState<string | null>(null);
  const { comments, notes } = useMemo(() => planComments(task), [task]);
  const onViewed = useMemo(() => orderComments(comments.filter(comment => comment.planId === viewedPlan.id)), [comments, viewedPlan.id]);
  const pending = onViewed.filter(comment => comment.status === 'pending');
  const answered = onViewed.filter(comment => comment.status === 'resolved');
  const earlier = useMemo(() => comments.filter(comment => comment.planId !== viewedPlan.id), [comments, viewedPlan.id]);
  const state = planReviewState(task, viewedPlan.id, userId, { busy: busy || sending || approving, submittedPlanId, hasDraft: Boolean(draft?.content.trim()), hasPending: pending.length > 0 });
  useEffect(() => { if (submittedPlanId && state.latest?.id !== submittedPlanId) setSubmittedPlanId(null); }, [state.latest?.id, submittedPlanId]);
  const { selection, clearSelection } = useDocumentSelection(containerRef, active && state.canComment);
  useHighlightClicks(containerRef, setSelectedId);
  const locked = !state.canComment;
  const startDraft = (anchor?: AssetCommentAnchor) => { setDraft({ anchor, content: '' }); clearSelection(); };
  async function submitDraft() {
    if (!draft?.content.trim() || !state.latest) return;
    setSending(true);
    try { if (await onComment(state.latest.id, draft.content.trim(), draft.anchor)) setDraft(null); }
    finally { setSending(false); }
  }
  async function revise() {
    if (!state.latest || !pending.length) return;
    setSending(true);
    try { if (await onRevise(state.latest.id)) setSubmittedPlanId(state.latest.id); }
    finally { setSending(false); }
  }
  const revisionLabel = state.queued ? dispatcherEnabled ? 'Revision queued' : 'Revision queued · Dispatch paused' : 'Revising the RFC';
  const revisionBlocked = task.status === 'blocked' && task.phase === 'planning';
  const finished = task.status === 'done' || task.phase === 'building' || task.phase === 'verification' || state.latest?.status === 'approved';
  const provider = PROVIDER_LABELS[task.provider];
  const floating = selection && active ? <button type="button" className="doc-comment-float" style={{ left: selection.x, top: selection.y }} onMouseDown={event => event.preventDefault()} onClick={() => startDraft(selection.anchor)}><MessageSquarePlus size={14} />Comment</button> : null;
  return <aside className="plan-discussion-panel" aria-label="RFC review">
    {floating}
    <div className="plan-discussion-heading"><MessageSquareText size={17} /><div><h3>Review the RFC</h3><p>{provider} · {task.status === 'canceled' ? 'Review closed' : revisionBlocked ? 'Revision needs attention' : state.revising ? revisionLabel : finished ? 'Review complete' : pending.length ? `${pending.length} ${pending.length === 1 ? 'comment' : 'comments'} waiting to be sent` : 'Select a passage to comment on it'}</p></div>
      <Button size="sm" variant="ghost" disabled={locked} title="Comment on the whole RFC" onClick={() => startDraft()}><MessageSquarePlus size={14} />On RFC</Button></div>
    <div className="plan-comments-body">
      {!state.isLatest && <div className="plan-discussion-historical"><span>Viewing version {viewedPlan.version}. Comment on version {state.latest?.version}, the latest.</span><Button size="sm" variant="secondary" onClick={onViewLatest}>View latest</Button></div>}
      {state.revising && <div className="plan-revising-status" role="status">{state.queued ? <RotateCw size={14} /> : <Loader2 size={14} className="spin" />}<div><strong>{revisionLabel}</strong><span>{state.queued ? 'Your comments are saved. The next version will answer them.' : `${provider} is working through your comments and updating the RFC.`}</span></div></div>}
      {state.isLatest && !finished && !state.revising && <div className="doc-comments-resolve">
        <Button size="sm" disabled={locked || pending.length === 0} onClick={() => void revise()}>{sending ? <Loader2 size={14} className="spin" /> : <Check size={14} />}{`Revise RFC ${pending.length ? `· ${pending.length} ${pending.length === 1 ? 'comment' : 'comments'}` : ''}`.trim()}</Button>
        <small>{provider} answers every comment and returns RFC v{(state.latest?.version ?? viewedPlan.version) + 1} for your approval. Questions get answers; instructions change the plan.</small>
      </div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!state.isOwner && <p className="plan-discussion-hint">Only the task owner can comment or approve the plan.</p>}
      {revisionBlocked && <p className="plan-discussion-hint">This revision needs attention. Resolve the issue above to continue.</p>}
      {state.discussing && <p className="plan-discussion-hint">A task comment is awaiting a reply. Open Comments to follow its progress before reviewing this RFC.</p>}
      {draft && <form className="doc-comment-composer" onSubmit={event => { event.preventDefault(); void submitDraft(); }}>
        <div className="doc-comment-quote">{draft.anchor ? <q>{draft.anchor.quote.length > 120 ? `${draft.anchor.quote.slice(0, 119)}…` : draft.anchor.quote}</q> : <span>Whole RFC</span>}</div>
        <MentionTextarea value={draft.content} onChange={content => setDraft(current => current ? { ...current, content } : current)} maxLength={20000} rows={3} autoFocus placeholder="Ask a question, or say what should change… Enter to add, Shift+Enter for a new line, @ mentions a document" aria-label="New RFC comment" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (draft.content.trim()) void submitDraft(); } }} />
        <div><Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}><X size={13} />Cancel</Button><Button type="submit" size="sm" disabled={sending || !draft.content.trim()}>{sending ? 'Adding…' : 'Add comment'}</Button></div>
      </form>}
      {onViewed.length === 0 && notes.length === 0 && !draft && <div className="plan-discussion-empty"><FileCheck2 size={23} /><h4>Refine it together</h4><p>Select a passage of the RFC and comment on it, or comment on the whole RFC. Add as many as you like, then press Revise RFC once: the agent answers each comment and returns the next version for your approval.</p></div>}
      <div className="doc-comments-list">
        {pending.map(comment => <CommentCard key={comment.id} comment={comment} wholeLabel="Whole RFC" selected={selectedId === comment.id} editable={!locked} busy={locked || sending} onSelect={() => { setSelectedId(comment.id); focusHighlight(containerRef.current, comment.id); }} onEdit={async content => { await onEditComment(comment.id, content); }} onDelete={async () => { await onDeleteComment(comment.id); }} />)}
        {answered.length > 0 && <details className="doc-comments-group" open={pending.length === 0}><summary>Answered on this version · {answered.length}</summary>{answered.map(comment => <CommentCard key={comment.id} comment={comment} wholeLabel="Whole RFC" selected={selectedId === comment.id} editable={false} busy={true} onSelect={() => { setSelectedId(comment.id); focusHighlight(containerRef.current, comment.id); }} />)}</details>}
        {earlier.length > 0 && <details className="doc-comments-group"><summary>Earlier versions · {earlier.length}</summary>{orderComments(earlier).map(comment => { const version = task.plans.find(plan => plan.id === comment.planId)?.version; return <div key={comment.id} className="plan-comment-version"><button type="button" className="plan-version-link" onClick={() => onViewVersion(comment.planId)}>RFC v{version}</button><CommentCard comment={comment} wholeLabel="Whole RFC" selected={false} editable={false} busy={true} onSelect={() => onViewVersion(comment.planId)} /></div>; })}</details>}
        {notes.map(note => <article key={note.id} className="doc-comment-card resolved plan-agent-note"><div className="doc-comment-reply-meta"><Sparkles size={12} /><span>{provider}</span><span>RFC v{task.plans.find(plan => plan.id === note.planId)?.version}</span><span>{relativeTime(note.createdAt)}</span></div><Markdown>{note.content}</Markdown></article>)}
      </div>
    </div>
    <div className="plan-discussion-controls">
      <div className="plan-discussion-approval"><div><strong>{state.latest?.status === 'approved' ? `Version ${state.latest.version} approved` : state.revising ? 'Building waits for your approval' : `Ready to build version ${state.latest?.version ?? viewedPlan.version}?`}</strong><p>{pending.length ? 'Send or delete your pending comments before approving.' : draft?.content.trim() ? 'Add or discard your comment before approving.' : state.latest?.status === 'approved' ? 'Your decision is saved with this RFC.' : 'Approve the latest plan when your comments are answered.'}</p></div>
        <Button size="sm" disabled={!state.canApprove} onClick={async () => { if (!state.latest) return; setApproving(true); try { await onApprove(state.latest.id); } finally { setApproving(false); } }}>{approving ? <Loader2 size={14} className="spin" /> : <Check size={14} />}Approve</Button></div>
    </div>
  </aside>;
}
