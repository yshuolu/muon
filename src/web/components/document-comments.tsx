import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { AlertTriangle, Check, Loader2, MessageSquarePlus, MessageSquareText, RotateCcw, X } from 'lucide-react';
import type { Asset, AssetCommentAnchor, AssetCommentThread } from '../../shared/types';
import { api } from '../lib/api';
import { deliverNotification } from '../lib/notifications';
import { Button } from './ui/button';
import { MentionTextarea } from './mention-textarea';
import { CommentCard, PROVIDER_LABELS, focusHighlight, orderComments, useDocumentSelection, useHighlightClicks } from './review-comments';

/** Loads a document's comment thread and follows a running review until it settles. */
export function useAssetComments(assetId: string, enabled: boolean) {
  const [thread, setThread] = useState<AssetCommentThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!enabled) return;
    try { setThread(await api<AssetCommentThread>(`/assets/${encodeURIComponent(assetId)}/comments`)); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load comments.'); }
  }, [assetId, enabled]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!thread?.review.busy) return;
    const timer = setInterval(() => { void load(); }, 1500);
    return () => clearInterval(timer);
  }, [thread?.review.busy, load]);
  return { thread, error, reload: load };
}

interface Draft { anchor?: AssetCommentAnchor; content: string; requestId: string }

/**
 * The review sidebar for one document: selection-anchored and whole-document comments, one-click resolution by
 * the quick chat's agent, and replies beside each comment. Highlights live in the rendered document; this
 * component links cards and highlights both ways.
 */
export function DocumentComments({ asset, thread, error, reload, containerRef, active, open, onOpen, onRevised }: {
  asset: Asset; thread: AssetCommentThread | null; error: string | null; reload: () => Promise<void>;
  containerRef: RefObject<HTMLDivElement | null>; active: boolean;
  /** Whether the sidebar panel is shown; the floating selection control works either way and opens it. */
  open: boolean; onOpen: () => void;
  /** A finished review produced a new version: the reader replaces this document with it. */
  onRevised: (revisionAssetId: string) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const announcedRevision = useRef<string | null>(null);
  const review = thread?.review;
  const pending = useMemo(() => orderComments((thread?.comments ?? []).filter(comment => comment.status === 'pending')), [thread]);
  const resolved = useMemo(() => orderComments((thread?.comments ?? []).filter(comment => comment.status === 'resolved')), [thread]);
  const locked = Boolean(review?.busy) || busy;

  // Selection inside this pane's rendered document offers a floating Comment control; clicking a highlight selects its card.
  const { selection, clearSelection } = useDocumentSelection(containerRef, active);
  useHighlightClicks(containerRef, setSelectedId);

  // A finished review that produced a revision replaces this document with it once and announces it.
  useEffect(() => {
    if (!review || review.busy || !review.revisionAssetId || announcedRevision.current === review.revisionAssetId) return;
    announcedRevision.current = review.revisionAssetId;
    const revisionAssetId = review.revisionAssetId;
    deliverNotification({ kind: 'planning', title: 'Comments resolved', body: `${asset.name} has been revised.`, tag: `review:${revisionAssetId}` }, () => onRevised(revisionAssetId));
    onRevised(revisionAssetId);
  }, [review, asset.name, onRevised]);

  function selectComment(id: string) {
    setSelectedId(id);
    focusHighlight(containerRef.current, id);
  }
  async function run(work: () => Promise<void>, failure: string) {
    setBusy(true); setActionError(null);
    try { await work(); await reload(); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : failure); }
    finally { setBusy(false); }
  }
  const startDraft = (anchor?: AssetCommentAnchor) => { onOpen(); setDraft({ anchor, content: '', requestId: crypto.randomUUID() }); clearSelection(); };
  const submitDraft = () => draft && run(async () => { await api(`/assets/${encodeURIComponent(asset.id)}/comments`, 'POST', { content: draft.content.trim(), requestId: draft.requestId, ...(draft.anchor ? { anchor: draft.anchor } : {}) }); setDraft(null); }, 'Could not add the comment.');
  const resolve = () => run(async () => { await api(`/assets/${encodeURIComponent(asset.id)}/comments/resolve`, 'POST', {}); }, 'Could not start the review.');
  const reviewerLabel = review ? `${PROVIDER_LABELS[review.provider]}${review.model ? ` · ${review.model}` : ''}` : '';
  const floating = selection && active ? <button type="button" className="doc-comment-float" style={{ left: selection.x, top: selection.y }} onMouseDown={event => event.preventDefault()} onClick={() => startDraft(selection.anchor)}><MessageSquarePlus size={14} />Comment</button> : null;
  if (!open) return floating;
  return <aside className="doc-comments" aria-label="Document comments">
    {floating}
    <div className="doc-comments-heading">
      <div><MessageSquareText size={15} /><strong>Comments</strong>{pending.length > 0 && <span className="doc-comments-count">{pending.length}</span>}</div>
      <Button size="sm" variant="ghost" disabled={locked} onClick={() => startDraft()}><MessageSquarePlus size={14} />On document</Button>
    </div>
    <div className="doc-comments-resolve">
      <Button size="sm" disabled={locked || pending.length === 0} onClick={() => void resolve()}>{review?.busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}{review?.busy ? 'Resolving…' : `Resolve ${pending.length || ''} ${pending.length === 1 ? 'comment' : 'comments'}`.replace(/\s+/g, ' ')}</Button>
      <small>{review?.busy ? review.activity ?? 'The agent is working through your comments…' : `with ${reviewerLabel}, your latest planning chat's agent. Questions get answers; instructions change the document as a new version.`}</small>
      {review?.error && !review.busy && <p className="doc-comment-error" role="alert"><AlertTriangle size={12} />{review.error}<button type="button" onClick={() => void resolve()} disabled={locked || pending.length === 0}><RotateCcw size={12} />Retry</button></p>}
    </div>
    {(error || actionError) && <p className="form-error" role="alert">{actionError ?? error}</p>}
    {draft && <form className="doc-comment-composer" onSubmit={event => { event.preventDefault(); void submitDraft(); }}>
      <div className="doc-comment-quote">{draft.anchor ? <q>{draft.anchor.quote.length > 120 ? `${draft.anchor.quote.slice(0, 119)}…` : draft.anchor.quote}</q> : <span>Whole document</span>}</div>
      <MentionTextarea value={draft.content} onChange={content => setDraft(current => current ? { ...current, content } : current)} maxLength={4000} rows={3} autoFocus placeholder="Ask a question, or tell the agent what to change or remove… Enter to add, Shift+Enter for a new line, @ mentions a document" aria-label="New comment" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (draft.content.trim()) void submitDraft(); } }} />
      <div><Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}><X size={13} />Cancel</Button><Button type="submit" size="sm" disabled={busy || !draft.content.trim()}>{busy ? 'Adding…' : 'Add comment'}</Button></div>
    </form>}
    {!thread && !error && <p className="asset-loading" role="status">Loading comments…</p>}
    {thread && pending.length === 0 && resolved.length === 0 && !draft && <p className="doc-comments-empty">Select a passage to comment on it, or comment on the whole document. Then resolve everything in one go.</p>}
    <div className="doc-comments-list">
      {pending.map(comment => <CommentCard key={comment.id} comment={comment} selected={selectedId === comment.id} editable={!locked} busy={locked} onSelect={() => selectComment(comment.id)} onEdit={content => run(async () => { await api(`/assets/${encodeURIComponent(asset.id)}/comments/${comment.id}`, 'PATCH', { content }); }, 'Could not save the comment.')} onDelete={() => run(async () => { await api(`/assets/${encodeURIComponent(asset.id)}/comments/${comment.id}`, 'DELETE', {}); }, 'Could not delete the comment.')} />)}
      {resolved.length > 0 && <details className="doc-comments-group" open={pending.length === 0}><summary>Resolved · {resolved.length}</summary>{resolved.map(comment => <CommentCard key={comment.id} comment={comment} selected={selectedId === comment.id} editable={false} busy={locked} onSelect={() => selectComment(comment.id)} />)}</details>}
      {thread && thread.inherited.length > 0 && <details className="doc-comments-group" open><summary>Resolved into this version · {thread.inherited.length}</summary>{orderComments(thread.inherited).map(comment => <CommentCard key={comment.id} comment={comment} selected={false} editable={false} busy={true} onSelect={() => undefined} />)}</details>}
    </div>
  </aside>;
}
