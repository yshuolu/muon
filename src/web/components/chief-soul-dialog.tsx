import { Bold, Check, Heading2, Italic, Link, List, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AppSnapshot } from '../../shared/types';
import { api } from '../lib/api';
import { Markdown } from './common';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

const DEFAULT_SOUL = '';

function insertMarkdown(textarea: HTMLTextAreaElement, before: string, after = before) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = textarea.value.slice(start, end) || 'your text';
  textarea.setRangeText(`${before}${selected}${after}`, start, end, 'select');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

export function ChiefSoulDialog({ snapshot, open, onOpenChange, onSaved }: { snapshot: AppSnapshot; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const [draft, setDraft] = useState(snapshot.settings.chiefSoul ?? DEFAULT_SOUL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (open) { setDraft(snapshot.settings.chiefSoul ?? DEFAULT_SOUL); setError(null); setDirty(false); setSavedAt(null); } }, [open]);
  async function persist(close: boolean) {
    setBusy(true); setError(null);
    try { await api('/settings', 'PATCH', { chiefSoul: draft.trim() || null }); setDirty(false); setSavedAt(Date.now()); onSaved(); if (close) onOpenChange(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save the Chief SOUL.'); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!open || !dirty) return;
    const timer = setTimeout(() => { void persist(false); }, 900);
    return () => clearTimeout(timer);
  }, [draft, dirty, open]);
  function reset() { setDraft(DEFAULT_SOUL); requestAnimationFrame(() => editor.current?.focus()); }
  return <Dialog open={open} onOpenChange={onOpenChange} title="Chief of Staff SOUL" description="Write the enduring voice, judgment, and working style you want your Chief of Staff to follow." className="chief-soul-dialog">
    <div className="chief-soul-editor-shell">
      <div className="chief-soul-toolbar" aria-label="Formatting tools">
        <button type="button" title="Bold" aria-label="Bold" onClick={() => editor.current && insertMarkdown(editor.current, '**')}><Bold size={15} /></button>
        <button type="button" title="Italic" aria-label="Italic" onClick={() => editor.current && insertMarkdown(editor.current, '*')}><Italic size={15} /></button>
        <button type="button" title="Heading" aria-label="Heading" onClick={() => editor.current && insertMarkdown(editor.current, '## ', '')}><Heading2 size={15} /></button>
        <button type="button" title="Bullet list" aria-label="Bullet list" onClick={() => editor.current && insertMarkdown(editor.current, '- ', '')}><List size={15} /></button>
        <button type="button" title="Link" aria-label="Link" onClick={() => editor.current && insertMarkdown(editor.current, '[', '](https://)')}><Link size={15} /></button>
        <span className="chief-soul-toolbar-spacer" />
        <button type="button" title="Reset SOUL" aria-label="Reset SOUL" onClick={reset}><RotateCcw size={14} /></button>
      </div>
      <textarea ref={editor} aria-label="Chief of Staff SOUL" value={draft} maxLength={20_000} onChange={event => { setDraft(event.target.value); setDirty(true); setSavedAt(null); }} placeholder={'## How I work\n\nBe direct, calm, and outcome focused. Keep task descriptions concise.\n\n## Preferences\n\nAsk before expanding scope.'} />
      <div className="chief-soul-editor-meta"><span>{draft.length.toLocaleString()} / 20,000 characters</span><span>Markdown supported</span></div>
    </div>
    <div className="chief-soul-preview"><div className="settings-section-label">Preview</div>{draft.trim() ? <Markdown>{draft}</Markdown> : <p className="chief-soul-empty">Your Chief will use its default behavior.</p>}</div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-footer"><span>{busy ? 'Saving…' : dirty ? 'Saving automatically…' : savedAt ? 'Saved just now' : 'Saved per project'}</span><Button type="button" onClick={() => void persist(true)} disabled={busy || !dirty}>{busy ? 'Saving…' : <><Check size={14} />Save and close</>}</Button></div>
  </Dialog>;
}
