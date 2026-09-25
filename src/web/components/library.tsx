import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, ChevronRight, Eye, File, FileImage, FileText, Film, NotebookPen, PenLine, RefreshCw, Search, SlidersHorizontal, Upload, X } from 'lucide-react';
import type { AppSnapshot, Asset, Task } from '../../shared/types';
import { taskAssetIds } from '../../shared/asset-references';
import { api } from '../lib/api';
import { assetContentUrl, assetPreviewKind, formatAssetSize } from '../lib/asset-preview';
import { LIBRARY_KIND_FILTERS, LIBRARY_KIND_LABELS, LIBRARY_KINDS, ORIGIN_LABELS, assetReferrers, filterLibrary, libraryKind, type LibraryFilter, type LibraryKind } from '../lib/library';
import { relativeTime } from '../lib/utils';
import { AssetPreview } from './asset-preview';
import { EmptyState, Markdown, StatusIcon } from './common';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

const MAX_NOTE_CHARACTERS = 200_000;
const MAX_REVISABLE_BYTES = 2 * 1024 * 1024;

interface NoteDraft {
  name: string;
  content: string;
  revisionOf?: Asset;
}

function LibraryIcon({ kind, size = 16 }: { kind: LibraryKind; size?: number }) {
  const Icon = kind === 'image' ? FileImage : kind === 'media' ? Film : kind === 'document' ? NotebookPen : kind === 'data' ? FileText : File;
  return <Icon size={size} aria-hidden="true" />;
}

/** Loads a Markdown asset's text so a new note can start from it; large documents stay download-only. */
async function revisionDraft(asset: Asset): Promise<NoteDraft> {
  const response = await fetch(assetContentUrl(asset.id), { redirect: 'error' });
  if (!response.ok) throw new Error('The note could not be loaded for revision.');
  return { name: asset.name, content: await response.text(), revisionOf: asset };
}

/** The full-width catalog: filters, search, and one row per file. Opening a file shows the document reader. */
export function LibraryView({ snapshot, onSelect }: { snapshot: AppSnapshot; onSelect: (assetId: string) => void }) {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<LibraryFilter>({ query: '', kind: 'all', origin: 'all' });
  const [uploading, setUploading] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const referrers = useMemo(() => assetReferrers(snapshot.tasks), [snapshot.tasks]);
  // Agents publish generated files through task references; reload when that set changes.
  const referencedKey = JSON.stringify([...new Set(snapshot.tasks.flatMap(taskAssetIds))].sort());
  useEffect(() => {
    let active = true;
    void api<Asset[]>('/assets').then(value => {
      if (active) { setAssets(value); setError(null); }
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : 'Could not load the library.');
    });
    return () => { active = false; };
  }, [referencedKey, reloads]);
  // Agents publish documents from chats that no task references yet; a slow poll picks those up.
  useEffect(() => {
    const timer = setInterval(() => setReloads(value => value + 1), 6000);
    return () => clearInterval(timer);
  }, []);
  const visible = useMemo(() => assets ? filterLibrary(assets, filter, referrers) : [], [assets, filter, referrers]);
  const filtering = filter.query.trim() !== '' || filter.kind !== 'all' || filter.origin !== 'all';
  const counts = useMemo(() => {
    const totals = { document: 0, image: 0, media: 0, data: 0, other: 0 } satisfies Record<LibraryKind, number>;
    for (const asset of assets ?? []) totals[libraryKind(asset)] += 1;
    return totals;
  }, [assets]);
  function added(asset: Asset) {
    setAssets(current => [...(current ?? []).filter(item => item.id !== asset.id), asset]);
    onSelect(asset.id);
  }
  async function upload(file: globalThis.File) {
    setUploading(true);
    setError(null);
    const form = new FormData();
    form.append('file', file);
    try { added(await api<Asset>('/assets', 'POST', form)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add this file.'); }
    finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  return <div className="library-view">
    <div className="list-toolbar library-toolbar">
      <div className="filter-control"><SlidersHorizontal size={14} /><select aria-label="Filter library by type" value={filter.kind} onChange={event => setFilter({ ...filter, kind: event.target.value as LibraryFilter['kind'] })}><option value="all">All types</option>{LIBRARY_KINDS.map(kind => <option key={kind} value={kind}>{LIBRARY_KIND_FILTERS[kind]}{counts[kind] ? ` (${counts[kind]})` : ''}</option>)}</select></div>
      <div className="filter-control"><select aria-label="Filter library by source" value={filter.origin} onChange={event => setFilter({ ...filter, origin: event.target.value as LibraryFilter['origin'] })}><option value="all">All sources</option>{(Object.keys(ORIGIN_LABELS) as Asset['origin'][]).map(origin => <option key={origin} value={origin}>{ORIGIN_LABELS[origin]}</option>)}</select></div>
      <span className="toolbar-divider" />
      <span className="task-total">{assets ? `${visible.length} ${visible.length === 1 ? 'file' : 'files'}` : 'Loading…'}</span>
      <label className="search-control"><Search size={14} /><input value={filter.query} onChange={event => setFilter({ ...filter, query: event.target.value })} placeholder="Search library…" aria-label="Search library" /><kbd>/</kbd></label>
      <div className="library-actions">
        <Button variant="ghost" size="icon" aria-label="Refresh library" title="Refresh library" onClick={() => setReloads(value => value + 1)}><RefreshCw size={14} /></Button>
        <input ref={fileInput} type="file" className="sr-only" tabIndex={-1} aria-label="Choose a file" disabled={uploading} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
        <Button size="sm" variant="secondary" disabled={uploading} onClick={() => fileInput.current?.click()}><Upload size={14} />{uploading ? 'Adding…' : 'Add file'}</Button>
        <Button size="sm" onClick={() => setDraft({ name: '', content: '' })}><PenLine size={14} />New note</Button>
      </div>
    </div>
    {error && <p className="form-error library-error" role="alert">{error}</p>}
    {!assets ? !error && <p className="asset-loading" role="status">Loading library…</p>
      : visible.length === 0 ? <EmptyState icon={filtering ? <Search size={25} /> : <BookOpen size={26} />} title={filtering ? 'No matching files' : 'Start your library'} description={filtering ? 'Try another search, type, or source.' : 'Keep documentation, reference notes, and every file your agents produce in one place. Ask the planning partner or the chief for a document and it lands here.'} action={filtering ? <Button variant="secondary" onClick={() => setFilter({ query: '', kind: 'all', origin: 'all' })}>Clear filters</Button> : <Button onClick={() => setDraft({ name: '', content: '' })}><PenLine size={15} />Write your first note</Button>} />
      : <div className="library-list" role="list" aria-label="Library files">{visible.map(asset => {
        const kind = libraryKind(asset);
        const tasks = referrers.get(asset.id) ?? [];
        return <button key={asset.id} role="listitem" className="library-row" onClick={() => onSelect(asset.id)}>
          <span className="library-row-icon"><LibraryIcon kind={kind} size={17} /></span>
          <span className="library-row-name"><strong>{asset.name}</strong><small>{LIBRARY_KIND_LABELS[kind]} · {asset.mediaType}</small></span>
          <span className="library-row-refs">{tasks.slice(0, 3).map(task => <span key={task.id} className="label-badge"><StatusIcon status={task.status} size={11} />{task.identifier}</span>)}{tasks.length > 3 && <span className="label-badge">+{tasks.length - 3}</span>}</span>
          <span className="library-row-meta"><span>{ORIGIN_LABELS[asset.origin]}</span><span>{formatAssetSize(asset.sizeBytes)}</span><span className="task-date">{relativeTime(asset.createdAt)}</span></span>
          <ChevronRight size={15} aria-hidden="true" />
        </button>;
      })}</div>}
    {draft && <NoteDialog key={draft.revisionOf?.id ?? 'new'} draft={draft} onOpenChange={open => { if (!open) setDraft(null); }} onCreated={asset => { setDraft(null); added(asset); }} />}
  </div>;
}

/** A full-screen reader for one file, layered over the workspace the way a task opens. */
export function LibraryDocument({ assetId, snapshot, onClose, onSelect, onOpenTask }: { assetId: string; snapshot: AppSnapshot; onClose: () => void; onSelect: (assetId: string) => void; onOpenTask: (task: Task) => void }) {
  const [asset, setAsset] = useState<Asset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [preparingRevision, setPreparingRevision] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const referrers = useMemo(() => assetReferrers(snapshot.tasks), [snapshot.tasks]);
  useEffect(() => {
    let active = true;
    setAsset(null); setError(null);
    void api<Asset>(`/assets/${encodeURIComponent(assetId)}`).then(value => {
      if (active) { setAsset(value); requestAnimationFrame(() => heading.current?.focus()); }
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : 'This file is not in your library.');
    });
    return () => { active = false; };
  }, [assetId]);
  async function revise(current: Asset) {
    setPreparingRevision(true); setError(null);
    try { setDraft(await revisionDraft(current)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open this note for revision.'); }
    finally { setPreparingRevision(false); }
  }
  const tasks = referrers.get(assetId) ?? [];
  const kind = asset ? libraryKind(asset) : null;
  const revisable = asset && assetPreviewKind(asset) === 'markdown';
  return <section className="task-detail library-document" aria-label={asset ? `Document ${asset.name}` : 'Library document'}>
    <div className="detail-breadcrumb"><button onClick={onClose}><ArrowLeft size={15} />Library</button><ChevronRight size={13} /><span className="library-document-crumb">{asset?.name ?? 'Document'}</span><span className="detail-breadcrumb-spacer" />{revisable && <Button size="sm" variant="secondary" disabled={preparingRevision || asset.sizeBytes > MAX_REVISABLE_BYTES} title={asset.sizeBytes > MAX_REVISABLE_BYTES ? 'Notes larger than 2 MB cannot be revised in the browser' : 'Start a new note from this document'} onClick={() => void revise(asset)}><PenLine size={13} />{preparingRevision ? 'Opening…' : 'Revise as new note'}</Button>}<Button variant="ghost" size="icon" aria-label="Close document" onClick={onClose}><X size={17} /></Button></div>
    <div className="detail-scroll library-document-scroll">
      {error && !asset && <div className="library-placeholder"><File size={26} /><strong>This file is not in your library</strong><p>{error}</p><Button variant="secondary" size="sm" onClick={onClose}>Back to library</Button></div>}
      {!asset && !error && <p className="asset-loading" role="status">Loading document…</p>}
      {asset && kind && <>
        <header className="library-document-heading">
          <div className="library-document-title"><span className="library-document-icon"><LibraryIcon kind={kind} size={20} /></span><h1 ref={heading} tabIndex={-1}>{asset.name}</h1></div>
          <div className="library-document-meta">
            <span className="status-pill">{LIBRARY_KIND_LABELS[kind]} · {asset.mediaType}</span>
            <span className="status-pill">{ORIGIN_LABELS[asset.origin]}{asset.sourcePath && <> from <code>{asset.sourcePath}</code></>}</span>
            <span className="status-pill">{formatAssetSize(asset.sizeBytes)}</span>
            <span className="status-pill">{asset.visibility === 'project' ? 'Project' : asset.ownerUserId === snapshot.scope.userId ? 'Private to you' : 'Private'}</span>
            <span className="detail-updated" title={new Date(asset.createdAt).toLocaleString()}>Added {relativeTime(asset.createdAt).toLowerCase()}</span>
          </div>
          {tasks.length > 0 && <div className="library-document-refs"><span>Referenced by</span>{tasks.map(task => <button key={task.id} onClick={() => onOpenTask(task)}><StatusIcon status={task.status} size={13} /><span className="task-identifier">{task.identifier}</span>{task.title}<ChevronRight size={12} /></button>)}</div>}
          {error && <p className="form-error" role="alert">{error}</p>}
        </header>
        <div className="library-document-body"><AssetPreview key={asset.id} asset={asset} /></div>
      </>}
    </div>
    {draft && <NoteDialog key={draft.revisionOf?.id ?? 'new'} draft={draft} onOpenChange={open => { if (!open) setDraft(null); }} onCreated={created => { setDraft(null); onSelect(created.id); }} />}
  </section>;
}

function NoteDialog({ draft, onOpenChange, onCreated }: { draft: NoteDraft; onOpenChange: (open: boolean) => void; onCreated: (asset: Asset) => void }) {
  const [name, setName] = useState(draft.name);
  const [content, setContent] = useState(draft.content);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!preview) editor.current?.focus(); }, [preview]);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    try { onCreated(await api<Asset>('/assets/notes', 'POST', { name: name.trim(), content })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this note.'); setBusy(false); }
  }
  return <Dialog open onOpenChange={onOpenChange} title={draft.revisionOf ? 'Revise note' : 'New reference note'} description={draft.revisionOf ? `Saving creates a new note in the library. ${draft.revisionOf.name} stays available unchanged.` : 'Notes are saved to the library as Markdown files that tasks and agents can reference.'} className="note-dialog">
    <form className="note-form" onSubmit={save}>
      <label>Name<input value={name} onChange={event => setName(event.target.value)} placeholder="Decision log" required maxLength={255} autoFocus={!draft.revisionOf} /><span className="field-hint">Saved as a Markdown file; .md is added automatically.</span></label>
      <div className="note-editor">
        <div className="note-editor-toolbar" role="group" aria-label="Note view"><button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}><PenLine size={13} />Write</button><button type="button" aria-pressed={preview} onClick={() => setPreview(true)}><Eye size={13} />Preview</button><span>{content.length.toLocaleString()} / {MAX_NOTE_CHARACTERS.toLocaleString()} characters</span></div>
        {preview ? <div className="note-preview">{content.trim() ? <Markdown>{content}</Markdown> : <p className="muted">Nothing to preview yet.</p>}</div>
          : <textarea ref={editor} aria-label="Note content" value={content} maxLength={MAX_NOTE_CHARACTERS} onChange={event => setContent(event.target.value)} placeholder={'# Decision log\n\n## 2026-09-22\n\nWe chose SQLite for local persistence because…'} />}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-footer"><span>Markdown supported · Notes are immutable once saved</span><span className="note-form-buttons"><Button variant="ghost" type="button" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={busy || !name.trim() || !content.trim()}>{busy ? 'Saving…' : draft.revisionOf ? 'Save new version' : 'Save note'}</Button></span></div>
    </form>
  </Dialog>;
}
