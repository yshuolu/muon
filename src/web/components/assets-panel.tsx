import { useEffect, useRef, useState } from 'react';
import { BookOpen, File, FileImage, FileText, Film, Upload } from 'lucide-react';
import type { Asset, Task } from '../../shared/types';
import { api } from '../lib/api';
import { taskAssetIds } from '../../shared/asset-references';
import { assetPreviewKind, formatAssetSize } from '../lib/asset-preview';
import { AssetPreview } from './asset-preview';
import { Button } from './ui/button';

export function AssetsPanel({ task, userId, selectedId, onSelect, onRefresh, onOpenLibrary }: {
  task: Task;
  userId: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onOpenLibrary?: (assetId: string | null) => void;
}) {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const assetIds = JSON.stringify(taskAssetIds(task));
  const canUpload = task.ownerUserId === userId && task.phase === 'idle' && ['backlog', 'todo'].includes(task.status) && !task.runs?.length && !task.plans.length;
  useEffect(() => {
    let active = true;
    setError(null);
    void api<Asset[]>(`/tasks/${encodeURIComponent(task.id)}/assets`).then(value => {
      if (active) setAssets(value);
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : 'Could not load task assets.');
    });
    return () => { active = false; };
  }, [task.id, assetIds]);
  const selected = assets?.find(asset => asset.id === selectedId) ?? assets?.[0];
  async function upload(file: globalThis.File) {
    setUploading(true);
    setError(null);
    const form = new FormData();
    form.append('file', file);
    try {
      const asset = await api<Asset>(`/tasks/${encodeURIComponent(task.id)}/assets`, 'POST', form);
      setAssets(current => [...(current ?? []).filter(item => item.id !== asset.id), asset]);
      onSelect(asset.id);
      onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not upload this file.');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  return <div className="assets-panel">
    <div className="assets-intro"><div><h3>Assets</h3><p>Files referenced in this task’s description, plans, and results.</p></div>{onOpenLibrary && <Button size="sm" variant="ghost" onClick={() => onOpenLibrary(selected?.id ?? null)} title={selected ? `Open ${selected.name} in the Library` : 'Browse every retained file'}><BookOpen size={14} />{selected ? 'Open in Library' : 'Browse Library'}</Button>}{canUpload && <><input ref={fileInput} type="file" className="sr-only" tabIndex={-1} aria-label="Choose a file" disabled={uploading} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); }} /><Button size="sm" variant="secondary" disabled={uploading} onClick={() => fileInput.current?.click()}><Upload size={14} />{uploading ? 'Uploading…' : 'Add file'}</Button></>}</div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!assets ? !error && <p className="asset-loading" role="status">Loading assets…</p> : <>
      <section className="asset-group asset-catalog" aria-label="Referenced files"><h4>Referenced files<span>{assets.length}</span></h4>{assets.length ? <ul>{assets.map(asset => {
        const kind = assetPreviewKind(asset);
        const Icon = kind === 'image' ? FileImage : kind === 'video' ? Film : kind === 'text' || kind === 'markdown' ? FileText : File;
        return <li key={asset.id}><button className={`asset-list-item ${selected?.id === asset.id ? 'selected' : ''}`} aria-pressed={selected?.id === asset.id} onClick={() => onSelect(asset.id)}><Icon size={16} /><span><strong>{asset.name}</strong><small>{formatAssetSize(asset.sizeBytes)} · {asset.origin === 'upload' ? 'Uploaded' : asset.origin === 'generated' ? 'Generated' : 'Imported'}</small></span></button></li>;
      })}</ul> : <p className="asset-group-empty">{canUpload ? 'Add a document, image, or other file. A reference is added to your task description for the agent to use.' : 'No files are referenced yet. Open a file from Changes to retain it as an asset and add a reference to the task’s result.'}</p>}</section>
      {selected && <AssetPreview asset={selected} />}
    </>}
  </div>;
}
