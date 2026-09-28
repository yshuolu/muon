import { useEffect, useState, type RefObject } from 'react';
import { AlertTriangle, Pencil, Sparkles, Trash2 } from 'lucide-react';
import type { AssetCommentAnchor, Provider } from '../../shared/types';
import { anchorFromSelection } from '../lib/document-comments';
import { relativeTime } from '../lib/utils';
import { Markdown } from './common';
import { Button } from './ui/button';

export const PROVIDER_LABELS: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' };
export const REPLY_LABELS: Record<ReviewReplyKind, string> = { answered: 'Answered', changed: 'Changed', declined: 'Declined' };

export type ReviewReplyKind = 'answered' | 'changed' | 'declined';

/** What a comment card needs, whether the comment lives on a Library document or on a task's RFC. */
export interface ReviewComment {
  id: string; content: string; anchor?: AssetCommentAnchor; createdAt: string; status: 'pending' | 'resolved';
  lastError?: string;
  reply?: { kind: ReviewReplyKind; content: string; createdAt: string; provider: Provider };
}

export interface FloatingSelection { anchor: AssetCommentAnchor; x: number; y: number }

/** Comments in reading order using the remembered offsets; whole-document comments come last. */
export function orderComments<T extends ReviewComment>(comments: T[]): T[] {
  return [...comments].sort((a, b) => (a.anchor?.start ?? Number.MAX_SAFE_INTEGER) - (b.anchor?.start ?? Number.MAX_SAFE_INTEGER) || a.createdAt.localeCompare(b.createdAt));
}

/**
 * Watches text selection inside the rendered document under `containerRef` and reports an anchor plus where to
 * show the floating Comment control. The document is the `.asset-markdown` element the reader renders.
 */
export function useDocumentSelection(containerRef: RefObject<HTMLElement | null>, active: boolean) {
  const [selection, setSelection] = useState<FloatingSelection | null>(null);
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
      // Selection.toString() keeps rendered whitespace between table cells and blocks; Range.toString() does not.
      const anchor = anchorFromSelection(before.toString(), current.toString(), after.toString());
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
  return { selection, clearSelection: () => { setSelection(null); window.getSelection()?.removeAllRanges(); } };
}

/** Clicking a highlight in the document selects its card and scrolls the card into view. */
export function useHighlightClicks(containerRef: RefObject<HTMLElement | null>, onSelect: (id: string) => void) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handle = (event: Event) => {
      const mark = (event.target as HTMLElement | null)?.closest<HTMLElement>('mark.doc-comment');
      if (!mark?.dataset.commentId) return;
      onSelect(mark.dataset.commentId);
      document.querySelector(`[data-comment-card="${CSS.escape(mark.dataset.commentId)}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    container.addEventListener('click', handle);
    return () => container.removeEventListener('click', handle);
  }, [containerRef, onSelect]);
}

/** Scrolls to a comment's highlight and pulses it. */
export function focusHighlight(container: HTMLElement | null, id: string) {
  const marks = container?.querySelectorAll<HTMLElement>(`mark.doc-comment[data-comment-ids~="${CSS.escape(id)}"]`);
  if (!marks?.length) return;
  marks[0].scrollIntoView({ block: 'center' });
  marks.forEach(mark => { mark.classList.add('pulse'); setTimeout(() => mark.classList.remove('pulse'), 1200); });
}

export function CommentCard({ comment, selected, editable, busy, wholeLabel = 'Whole document', onSelect, onEdit, onDelete }: {
  comment: ReviewComment; selected: boolean; editable: boolean; busy: boolean; wholeLabel?: string;
  onSelect: () => void; onEdit?: (content: string) => Promise<void>; onDelete?: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.content);
  const [saving, setSaving] = useState(false);
  return <article className={`doc-comment-card ${comment.status} ${selected ? 'selected' : ''}`} data-comment-card={comment.id} onClick={onSelect}>
    <div className="doc-comment-quote">{comment.anchor ? <q>{comment.anchor.quote.length > 120 ? `${comment.anchor.quote.slice(0, 119)}…` : comment.anchor.quote}</q> : <span>{wholeLabel}</span>}</div>
    {editing ? <form className="doc-comment-edit" onSubmit={async event => { event.preventDefault(); if (!onEdit || !text.trim()) return; setSaving(true); try { await onEdit(text.trim()); setEditing(false); } finally { setSaving(false); } }}>
      <textarea value={text} onChange={event => setText(event.target.value)} maxLength={20000} rows={3} autoFocus aria-label="Edit comment" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } else if (event.key === 'Escape') { event.preventDefault(); setText(comment.content); setEditing(false); } }} />
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
