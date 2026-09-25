import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { AlertTriangle, ArrowUpRight, Check, Loader2, MessageSquarePlus, MessageSquareText, Pencil, RotateCcw, Sparkles, Trash2, X } from 'lucide-react';
import type { Asset, AssetComment, AssetCommentAnchor, AssetCommentThread, Provider } from '../../shared/types';
import { api } from '../lib/api';
import { anchorFromSelection } from '../lib/document-comments';
import { deliverNotification } from '../lib/notifications';
import { relativeTime } from '../lib/utils';
import { Markdown } from './common';
import { Button } from './ui/button';

const PROVIDER_LABELS: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' };
const REPLY_LABELS: Record<NonNullable<AssetComment['reply']>['kind'], string> = { answered: 'Answered', changed: 'Changed', declined: 'Declined' };

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
interface FloatingSelection { anchor: AssetCommentAnchor; x: number; y: number }

/** Comments in reading order using the remembered offsets; whole-document comments come last. */
function orderComments(comments: AssetComment[]): AssetComment[] {
  return [...comments].sort((a, b) => (a.anchor?.start ?? Number.MAX_SAFE_INTEGER) - (b.anchor?.start ?? Number.MAX_SAFE_INTEGER) || a.createdAt.localeCompare(b.createdAt));
}

function CommentCard({ comment, selected, editable, busy, onSelect, onEdit, onDelete }: { comment: AssetComment; selected: boolean; editable: boolean; busy: boolean; onSelect: () => void; onEdit?: (content: string) => Promise<void>; onDelete?: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.content);
  const [saving, setSaving] = useState(false);
  return <article className={`doc-comment-card ${comment.status} ${selected ? 'selected' : ''}`} data-comment-card={comment.id} onClick={onSelect}>
    <div className="doc-comment-quote">{comment.anchor ? <q>{comment.anchor.quote.length > 120 ? `${comment.anchor.quote.slice(0, 119)}…` : comment.anchor.quote}</q> : <span>Whole document</span>}</div>
    {editing ? <form className="doc-comment-edit" onSubmit={async event => { event.preventDefault(); if (!onEdit || !text.trim()) return; setSaving(true); try { await onEdit(text.trim()); setEditing(false); } finally { setSaving(false); } }}>
      <textarea value={text} onChange={event => setText(event.target.value)} maxLength={4000} rows={3} autoFocus aria-label="Edit comment" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } else if (event.key === 'Escape') { event.preventDefault(); setText(comment.content); setEditing(false); } }} />
      <div><Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => { setText(comment.content); setEditing(false); }}>Cancel</Button><Button type="submit" size="sm" disabled={saving || !text.trim()}>{saving ? 'Saving…' : 'Save'}</Button></div>
    </form> : <div className="doc-comment-body"><Markdown>{comment.content}</Markdown></div>}
    <div className="doc-comment-meta">
      <span>You · {relativeTime(comment.createdAt)}</span>
      {comment.status === 'pending' && <span className="doc-comment-status pending">{comment.lastError ? 'Not resolved' : 'Pending'}</span>}
      {editable && !editing && <span className="doc-comment-actions"><button type="button" aria-label="Edit comment" title="Edit" disabled={busy} onClick={event => { event.stopPropagation(); setEditing(true); }}><Pencil size={13} /></button><button type="button" aria-label="Delete comment" title="Delete" disabled={busy} onClick={event => { event.stopPropagation(); void onDelete?.(); }}><Trash2 size={13} /></button></span>}
    </div>
    {comment.lastError && comment.status === 'pending' && <p className="doc-comment-error"><AlertTriangle size={12} />{comment.lastError}</p>}
    {comment.reply && <div className={`doc-comment-reply ${comment.reply.kind}`}>
      <div className="doc-comment-reply-meta"><Sparkles size={12} /><span>{PROVIDER_LABELS[comment.reply.provider]}</span><span className={`doc-comment-status ${comment.reply.kind}`}>{REPLY_LABELS[comment.reply.kind]}</span><span>{relativeTime(comment.reply.createdAt)}</span></div>
      <Markdown>{comment.reply.content}</Markdown>
    </div>}
  </article>;
}

/**
 * The review sidebar for one document: selection-anchored and whole-document comments, one-click resolution by
 * the quick chat's agent, and replies beside each comment. Highlights live in the rendered document; this
 * component links cards and highlights both ways.
 */
export function DocumentComments({ asset, thread, error, reload, containerRef, active, open, onOpen, onOpenAsset }: {
  asset: Asset; thread: AssetCommentThread | null; error: string | null; reload: () => Promise<void>;
  containerRef: RefObject<HTMLDivElement | null>; active: boolean;
  /** Whether the sidebar panel is shown; the floating selection control works either way and opens it. */
  open: boolean; onOpen: () => void; onOpenAsset: (assetId: string) => void;
}) {
  const [selection, setSelection] = useState<FloatingSelection | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revisionBanner, setRevisionBanner] = useState<string | null>(null);
  const announcedRevision = useRef<string | null>(null);
  const review = thread?.review;
  const pending = useMemo(() => orderComments((thread?.comments ?? []).filter(comment => comment.status === 'pending')), [thread]);
  const resolved = useMemo(() => orderComments((thread?.comments ?? []).filter(comment => comment.status === 'resolved')), [thread]);
  const locked = Boolean(review?.busy) || busy;

  // Selection inside this pane's rendered document offers a floating Comment control.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !active) return;
    const inspect = () => {
      const current = window.getSelection();
      const markdown = container.querySelector('.asset-markdown');
      if (!current || current.isCollapsed || current.rangeCount === 0 || !markdown) { setSelection(null); return; }
      const range = current.getRangeAt(0);
      if (!markdown.contains(range.commonAncestorContainer)) { setSelection(null); return; }
      const before = document.createRange(); before.selectNodeContents(markdown); before.setEnd(range.startContainer, range.startOffset);
      const after = document.createRange(); after.selectNodeContents(markdown); after.setStart(range.endContainer, range.endOffset);
      const anchor = anchorFromSelection(before.toString(), range.toString(), after.toString());
      if (!anchor) { setSelection(null); return; }
      const rect = range.getBoundingClientRect();
      setSelection({ anchor, x: rect.left + rect.width / 2, y: rect.top });
    };
    const clear = () => setSelection(current => current && window.getSelection()?.isCollapsed !== false ? null : current);
    container.addEventListener('mouseup', inspect);
    container.addEventListener('keyup', inspect);
    document.addEventListener('selectionchange', clear);
    return () => { container.removeEventListener('mouseup', inspect); container.removeEventListener('keyup', inspect); document.removeEventListener('selectionchange', clear); };
  }, [containerRef, active]);

  // Clicking a highlight selects its card.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handle = (event: Event) => {
      const mark = (event.target as HTMLElement | null)?.closest<HTMLElement>('mark.doc-comment');
      if (!mark?.dataset.commentId) return;
      setSelectedId(mark.dataset.commentId);
      container.querySelector(`[data-comment-card="${CSS.escape(mark.dataset.commentId)}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    container.addEventListener('click', handle);
    return () => container.removeEventListener('click', handle);
  }, [containerRef]);

  // A finished review that produced a revision opens it once and announces it.
  useEffect(() => {
    if (!review || review.busy || !review.revisionAssetId || announcedRevision.current === review.revisionAssetId) return;
    announcedRevision.current = review.revisionAssetId;
    setRevisionBanner(review.revisionAssetId);
    deliverNotification({ kind: 'planning', title: 'Comments resolved', body: `${asset.name} has a revised version.`, tag: `review:${review.revisionAssetId}` }, () => onOpenAsset(review.revisionAssetId!));
  }, [review, asset.name, onOpenAsset]);

  function focusHighlight(id: string) {
    setSelectedId(id);
    const marks = containerRef.current?.querySelectorAll<HTMLElement>(`mark.doc-comment[data-comment-ids~="${CSS.escape(id)}"]`);
    if (!marks?.length) return;
    marks[0].scrollIntoView({ block: 'center' });
    marks.forEach(mark => { mark.classList.add('pulse'); setTimeout(() => mark.classList.remove('pulse'), 1200); });
  }
  async function run(work: () => Promise<void>, failure: string) {
    setBusy(true); setActionError(null);
    try { await work(); await reload(); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : failure); }
    finally { setBusy(false); }
  }
  const startDraft = (anchor?: AssetCommentAnchor) => { onOpen(); setDraft({ anchor, content: '', requestId: crypto.randomUUID() }); setSelection(null); window.getSelection()?.removeAllRanges(); };
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
    {asset.previousVersionId && <div className="doc-comments-banner"><span>Revised from an earlier version{thread?.inherited.length ? ` · ${thread.inherited.length} ${thread.inherited.length === 1 ? 'comment' : 'comments'} resolved` : ''}.</span><button type="button" onClick={() => onOpenAsset(asset.previousVersionId!)}>Open previous version<ArrowUpRight size={12} /></button></div>}
    {revisionBanner && <div className="doc-comments-banner revision"><span>A revised version was created from these comments.</span><button type="button" onClick={() => onOpenAsset(revisionBanner)}>Open revised version<ArrowUpRight size={12} /></button></div>}
    <div className="doc-comments-resolve">
      <Button size="sm" disabled={locked || pending.length === 0} onClick={() => void resolve()}>{review?.busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}{review?.busy ? 'Resolving…' : `Resolve ${pending.length || ''} ${pending.length === 1 ? 'comment' : 'comments'}`.replace(/\s+/g, ' ')}</Button>
      <small>{review?.busy ? review.activity ?? 'The agent is working through your comments…' : `with ${reviewerLabel}, your latest planning chat's agent. Questions get answers; instructions change the document as a new version.`}</small>
      {review?.error && !review.busy && <p className="doc-comment-error" role="alert"><AlertTriangle size={12} />{review.error}<button type="button" onClick={() => void resolve()} disabled={locked || pending.length === 0}><RotateCcw size={12} />Retry</button></p>}
    </div>
    {(error || actionError) && <p className="form-error" role="alert">{actionError ?? error}</p>}
    {draft && <form className="doc-comment-composer" onSubmit={event => { event.preventDefault(); void submitDraft(); }}>
      <div className="doc-comment-quote">{draft.anchor ? <q>{draft.anchor.quote.length > 120 ? `${draft.anchor.quote.slice(0, 119)}…` : draft.anchor.quote}</q> : <span>Whole document</span>}</div>
      <textarea value={draft.content} onChange={event => setDraft({ ...draft, content: event.target.value })} maxLength={4000} rows={3} autoFocus placeholder="Ask a question, or tell the agent what to change or remove… Enter to add, Shift+Enter for a new line" aria-label="New comment" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (draft.content.trim()) void submitDraft(); } }} />
      <div><Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}><X size={13} />Cancel</Button><Button type="submit" size="sm" disabled={busy || !draft.content.trim()}>{busy ? 'Adding…' : 'Add comment'}</Button></div>
    </form>}
    {!thread && !error && <p className="asset-loading" role="status">Loading comments…</p>}
    {thread && pending.length === 0 && resolved.length === 0 && !draft && <p className="doc-comments-empty">Select a passage to comment on it, or comment on the whole document. Then resolve everything in one go.</p>}
    <div className="doc-comments-list">
      {pending.map(comment => <CommentCard key={comment.id} comment={comment} selected={selectedId === comment.id} editable={!locked} busy={locked} onSelect={() => focusHighlight(comment.id)} onEdit={content => run(async () => { await api(`/assets/${encodeURIComponent(asset.id)}/comments/${comment.id}`, 'PATCH', { content }); }, 'Could not save the comment.')} onDelete={() => run(async () => { await api(`/assets/${encodeURIComponent(asset.id)}/comments/${comment.id}`, 'DELETE', {}); }, 'Could not delete the comment.')} />)}
      {resolved.length > 0 && <details className="doc-comments-group" open={pending.length === 0}><summary>Resolved · {resolved.length}</summary>{resolved.map(comment => <CommentCard key={comment.id} comment={comment} selected={selectedId === comment.id} editable={false} busy={locked} onSelect={() => focusHighlight(comment.id)} />)}</details>}
      {thread && thread.inherited.length > 0 && <details className="doc-comments-group"><summary>Resolved into this version · {thread.inherited.length}</summary>{orderComments(thread.inherited).map(comment => <CommentCard key={comment.id} comment={comment} selected={false} editable={false} busy={true} onSelect={() => undefined} />)}</details>}
    </div>
  </aside>;
}
