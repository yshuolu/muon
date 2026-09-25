import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronRight, Eye, File, FileImage, FileText, Film, NotebookPen, PenLine, RefreshCw, Search, SlidersHorizontal, Upload, X } from 'lucide-react';
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

export function LibraryView({ snapshot, selectedId, onSelect, onOpenTask }: {
  snapshot: AppSnapshot;
  selectedId: string | null;
  onSelect: (assetId: string | null) => void;
  onOpenTask: (task: Task) => void;
}) {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<LibraryFilter>({ query: '', kind: 'all', origin: 'all' });
  const [uploading, setUploading] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [preparingRevision, setPreparingRevision] = useState(false);
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
  const selected = assets?.find(asset => asset.id === selectedId);
  const filtering = filter.query.trim() !== '' || filter.kind !== 'all' || filter.origin !== 'all';
  const counts = useMemo(() => {
    const totals = { document: 0, image: 0, media: 0, data: 0, other: 0 } satisfies Record<LibraryKind, number>;
    for (const asset of assets ?? []) totals[libraryKind(asset)] += 1;
    return totals;
  }, [assets]);
  function added(asset: Asset) {
    setAssets(current => [...(current ?? []).filter(item => item.id !== asset.id), asset]);
    setFilter({ query: '', kind: 'all', origin: 'all' });
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
  async function revise(asset: Asset) {
    setPreparingRevision(true);
    setError(null);
    try {
      const response = await fetch(assetContentUrl(asset.id), { redirect: 'error' });
      if (!response.ok) throw new Error('The note could not be loaded for revision.');
      setDraft({ name: asset.name, content: await response.text(), revisionOf: asset });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open this note for revision.'); }
    finally { setPreparingRevision(false); }
  }
  return <div className="library-view">
    <div className="list-toolbar library-toolbar">
      <div className="filter-control"><SlidersHorizontal size={14} /><select aria-label="Filter library by type" value={filter.kind} onChange={event => setFilter({ ...filter, kind: event.target.value as LibraryFilter['kind'] })}><option value="all">All types</option>{LIBRARY_KINDS.map(kind => <option key={kind} value={kind}>{LIBRARY_KIND_FILTERS[kind]}</option>)}</select></div>
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
    <div className="library-layout">
      <nav className="library-catalog" aria-label="Library files">
        {!assets ? !error && <p className="asset-loading" role="status">Loading library…</p>
          : visible.length === 0 ? <EmptyState icon={filtering ? <Search size={25} /> : <BookOpen size={26} />} title={filtering ? 'No matching files' : 'Start your library'} description={filtering ? 'Try another search, type, or source.' : 'Keep documentation, reference notes, and every file your agents produce in one place.'} action={filtering ? <Button variant="secondary" onClick={() => setFilter({ query: '', kind: 'all', origin: 'all' })}>Clear filters</Button> : <Button onClick={() => setDraft({ name: '', content: '' })}><PenLine size={15} />Write your first note</Button>} />
          : <ul className="library-list">{visible.map(asset => {
            const kind = libraryKind(asset);
            const tasks = referrers.get(asset.id) ?? [];
            return <li key={asset.id}><button className={`library-item ${selected?.id === asset.id ? 'selected' : ''}`} aria-pressed={selected?.id === asset.id} onClick={() => onSelect(asset.id)}>
              <LibraryIcon kind={kind} />
              <span><strong>{asset.name}</strong><small><span>{LIBRARY_KIND_LABELS[kind]}</span><span>{formatAssetSize(asset.sizeBytes)}</span><span>{ORIGIN_LABELS[asset.origin]}</span><span>{relativeTime(asset.createdAt)}</span>{tasks.length > 0 && <span className="library-refs">{tasks.length === 1 ? tasks[0].identifier : `${tasks.length} tasks`}</span>}</small></span>
              <ChevronRight size={14} aria-hidden="true" />
            </button></li>;
          })}</ul>}
      </nav>
      <div className="library-reader">
        {selectedId && assets && !selected ? <div className="library-placeholder"><File size={26} /><strong>This file is not in your library</strong><p>It may be private to another owner, or it may have been created in a different project.</p><Button variant="secondary" size="sm" onClick={() => onSelect(null)}>Back to library</Button></div>
          : selected ? <>
            <section className="library-details" aria-label={`Details for ${selected.name}`}>
              <div className="library-details-heading"><div><LibraryIcon kind={libraryKind(selected)} size={18} /><h3>{selected.name}</h3></div><div className="library-details-actions">{assetPreviewKind(selected) === 'markdown' && <Button size="sm" variant="secondary" disabled={preparingRevision || selected.sizeBytes > MAX_REVISABLE_BYTES} title={selected.sizeBytes > MAX_REVISABLE_BYTES ? 'Notes larger than 2 MB cannot be revised in the browser' : 'Start a new note from this document'} onClick={() => void revise(selected)}><PenLine size={13} />{preparingRevision ? 'Opening…' : 'Revise as new note'}</Button>}<Button size="sm" variant="ghost" aria-label="Close reader" onClick={() => onSelect(null)}><X size={15} /></Button></div></div>
              <dl>
                <div><dt>Type</dt><dd>{LIBRARY_KIND_LABELS[libraryKind(selected)]} · {selected.mediaType}</dd></div>
                <div><dt>Source</dt><dd>{ORIGIN_LABELS[selected.origin]}{selected.sourcePath && <> from <code>{selected.sourcePath}</code></>}</dd></div>
                <div><dt>Added</dt><dd><time dateTime={selected.createdAt} title={new Date(selected.createdAt).toLocaleString()}>{relativeTime(selected.createdAt)}</time></dd></div>
                <div><dt>Size</dt><dd>{formatAssetSize(selected.sizeBytes)}</dd></div>
                <div><dt>Visibility</dt><dd>{selected.visibility === 'project' ? 'Project' : selected.ownerUserId === snapshot.scope.userId ? 'Private to you' : 'Private'}</dd></div>
              </dl>
              <div className="library-referrers"><h4>Referenced by</h4>{(referrers.get(selected.id) ?? []).length ? <div className="subtask-list">{(referrers.get(selected.id) ?? []).map(task => <button key={task.id} onClick={() => onOpenTask(task)}><StatusIcon status={task.status} /><span className="task-identifier">{task.identifier}</span><span>{task.title}</span><ChevronRight size={13} /></button>)}</div> : <p>No task references this file yet. Copy its reference below to use it in a task description, comment, or note.</p>}</div>
            </section>
            <AssetPreview key={selected.id} asset={selected} />
          </>
          : <div className="library-placeholder"><BookOpen size={28} /><strong>{assets?.length ? 'Choose a file to read it here' : 'Nothing in the library yet'}</strong><p>{assets?.length ? 'Documents render with an outline, images and recordings play inline, and every file keeps its original download.' : 'Notes you write, files you add, and reports your agents generate all appear here.'}</p>{assets && assets.length > 0 && <div className="library-summary">{LIBRARY_KINDS.filter(kind => counts[kind] > 0).map(kind => <button key={kind} onClick={() => setFilter({ ...filter, kind })} aria-pressed={filter.kind === kind}><LibraryIcon kind={kind} size={13} />{counts[kind]} {counts[kind] === 1 ? LIBRARY_KIND_LABELS[kind].toLowerCase() : LIBRARY_KIND_FILTERS[kind].toLowerCase()}</button>)}</div>}</div>}
      </div>
    </div>
    {draft && <NoteDialog key={draft.revisionOf?.id ?? 'new'} draft={draft} onOpenChange={open => { if (!open) setDraft(null); }} onCreated={asset => { setDraft(null); added(asset); }} />}
  </div>;
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
