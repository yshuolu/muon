import { assetIdFromUrl, assetIdsInText, assetReference } from '../../shared/asset-references';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { Check, Copy, Download, File, FileText, Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Asset } from '../../shared/types';
import { api } from '../lib/api';
import { assetContentUrl, assetPreviewKind, formatAssetSize, isAssetImageUrl, rehypeAssetHeadings } from '../lib/asset-preview';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

export function assetMarkdownUrl(url: string): string {
  return assetIdFromUrl(url) ? url : defaultUrlTransform(url);
}

export function AssetReferenceLink({ assetId, children }: { assetId: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('Referenced file');
  const hasLabel = children !== undefined;
  useEffect(() => {
    if (hasLabel) return;
    let active = true;
    setName('Referenced file');
    void api<Asset>(`/assets/${encodeURIComponent(assetId)}`).then(asset => {
      if (active) setName(asset.name);
    }).catch(() => { if (active) setName('Unavailable file'); });
    return () => { active = false; };
  }, [assetId, hasLabel]);
  return <><button className="markdown-asset-link" onClick={() => setOpen(true)}><FileText size={13} aria-hidden="true" />{children ?? name}</button><Dialog open={open} onOpenChange={setOpen} title="Asset preview" description="Read or download the referenced file." className="asset-reader-dialog"><AssetPreview assetId={assetId} /></Dialog></>;
}

/** Exposes references in sandboxed HTML without giving the iframe app access. */
export function AssetReferenceList({ text }: { text: string }) {
  const ids = assetIdsInText(text);
  return ids.length ? <section className="asset-reference-list" aria-label="Referenced files"><h4>Referenced files</h4><div>{ids.map(id => <AssetReferenceLink key={id} assetId={id} />)}</div></section> : null;
}

export function AssetReferenceImage({ assetId, alt }: { assetId: string; alt?: string }) {
  const [asset, setAsset] = useState<Asset | null>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setAsset(null);
    setFailed(false);
    void api<Asset>(`/assets/${encodeURIComponent(assetId)}`).then(value => {
      if (active) setAsset(value);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [assetId]);
  if (!asset || failed || assetPreviewKind(asset) !== 'image') return <AssetReferenceLink assetId={assetId}>{alt || asset?.name || 'Referenced image'}</AssetReferenceLink>;
  return <><button className="markdown-asset-image" onClick={() => setOpen(true)} aria-label={`Expand ${alt || asset.name}`}><img src={assetContentUrl(asset.id)} alt={alt || asset.name} loading="lazy" onError={() => setFailed(true)} /><span><Maximize2 size={13} />Expand image</span></button><Dialog open={open} onOpenChange={setOpen} title={asset.name} description="Referenced image" className="asset-reader-dialog"><AssetPreview asset={asset} /></Dialog></>;
}

export function AssetPreview({ asset, assetId }: { asset?: Asset; assetId?: string }) {
  const [loaded, setLoaded] = useState<Asset | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (asset || !assetId) return;
    let active = true;
    setLoaded(null);
    setError(null);
    void api<Asset>(`/assets/${encodeURIComponent(assetId)}`).then(value => {
      if (active) setLoaded(value);
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : 'Could not load this asset.');
    });
    return () => { active = false; };
  }, [asset, assetId]);
  const current = asset ?? (loaded?.id === assetId ? loaded : null);
  if (error && !current) return <p className="form-error" role="alert">{error}</p>;
  if (!current) return <p className="asset-loading" role="status">Loading asset…</p>;
  return <AssetReader key={current.id} asset={current} />;
}

function AssetReader({ asset }: { asset: Asset }) {
  const kind = assetPreviewKind(asset);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [source, setSource] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const referenceInput = useRef<HTMLInputElement>(null);
  const reference = assetReference(asset, kind === 'image');
  const url = assetContentUrl(asset.id);
  const tooLarge = asset.sizeBytes > MAX_TEXT_PREVIEW_BYTES;
  useEffect(() => {
    if (!['markdown', 'text'].includes(kind) || tooLarge) return;
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal, redirect: 'error' }).then(async response => {
      if (!response.ok) throw new Error('The file could not be loaded. You can try downloading the original.');
      const content = await response.text();
      if (!controller.signal.aborted) setText(content);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load the preview.');
    });
    return () => controller.abort();
  }, [kind, tooLarge, url]);
  useEffect(() => {
    if (copyState === 'failed') referenceInput.current?.focus();
  }, [copyState]);
  async function copyReference() {
    setCopyState('copying');
    try {
      await navigator.clipboard.writeText(reference);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }
  return <article className="asset-reader" aria-label={`Preview of ${asset.name}`}>
    <header className="asset-reader-heading">
      <div><h3>{asset.name}</h3><p>{asset.mediaType} · {formatAssetSize(asset.sizeBytes)}</p></div>
      <div className="asset-reader-actions">{kind === 'markdown' && text !== null && <Button size="sm" variant="ghost" aria-pressed={source} onClick={() => setSource(!source)}>{source ? 'Read document' : 'View source'}</Button>}
        <Button size="sm" variant="ghost" disabled={copyState === 'copying'} onClick={() => void copyReference()}>{copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}<span aria-live="polite">{copyState === 'copied' ? 'Copied' : 'Copy reference'}</span></Button>
        <a className="button button-secondary button-sm" href={assetContentUrl(asset.id, true)} download={asset.name}><Download size={13} />Download</a>
      </div>
    </header>
    {copyState === 'failed' && <div className="asset-reference-copy"><p role="alert">Couldn’t copy automatically. Select and copy this reference.</p><input ref={referenceInput} aria-label="Asset reference" readOnly value={reference} onFocus={event => event.currentTarget.select()} /></div>}
    {error ? <p className="form-error asset-preview-notice" role="alert">{error}</p>
      : kind === 'image' ? <button className="asset-image-preview" onClick={() => setExpanded(true)} aria-label={`Expand ${asset.name}`}><img src={url} alt={asset.name} onError={() => setError('This image could not be previewed. Download the original to open it.')} /><span><Maximize2 size={14} />Expand image</span></button>
      : kind === 'video' ? <video className="asset-media" controls playsInline preload="metadata" src={url} aria-label={asset.name} onError={() => setError('This video format could not be played. Download the original to open it.')} />
      : kind === 'audio' ? <audio className="asset-media" controls preload="metadata" src={url} aria-label={asset.name} onError={() => setError('This audio format could not be played. Download the original to open it.')} />
      : kind === 'download' || tooLarge ? <div className="asset-unavailable"><File size={28} /><strong>{tooLarge && kind !== 'download' ? 'This file is too large to preview' : 'Download to open this file'}</strong><p>{tooLarge && kind !== 'download' ? 'Text previews support files up to 2 MB. The complete original is available above.' : 'A preview is not available for this format. Your original file is retained.'}</p></div>
      : text === null ? <p className="asset-loading" role="status">Loading preview…</p>
      : kind === 'markdown' && !source ? <AssetMarkdown>{text}</AssetMarkdown>
      : <pre className="asset-text" tabIndex={0} aria-label={`${asset.name} source`}><code>{text}</code></pre>}
    <Dialog open={expanded} onOpenChange={value => { setExpanded(value); setZoomed(false); }} title={asset.name} description="Image preview" className="asset-image-dialog">
      <div className="asset-image-toolbar"><Button size="sm" variant="secondary" onClick={() => setZoomed(!zoomed)}>{zoomed ? <ZoomOut size={14} /> : <ZoomIn size={14} />}{zoomed ? 'Fit to window' : 'Actual size'}</Button><a className="button button-ghost button-sm" href={assetContentUrl(asset.id, true)} download={asset.name}><Download size={14} />Download</a></div>
      <div className={`asset-image-canvas ${zoomed ? 'zoomed' : ''}`} tabIndex={0}><img src={url} alt={asset.name} /></div>
    </Dialog>
  </article>;
}

interface Heading {
  id: string;
  label: string;
  level: number;
}

export function AssetMarkdown({ children }: { children: string }) {
  const instance = useId();
  const prefix = `asset-${instance.replace(/[^a-zA-Z0-9_-]/g, '')}-`;
  const document = useRef<HTMLDivElement>(null);
  const [headings, setHeadings] = useState<Heading[]>([]);
  useEffect(() => {
    setHeadings(Array.from(document.current?.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6') ?? []).map(heading => ({
      id: heading.id, label: heading.textContent ?? '', level: Number(heading.tagName.slice(1)),
    })));
  }, [children, prefix]);
  const jump = useCallback((event: MouseEvent<HTMLAnchorElement>, id: string) => {
    const heading = Array.from(document.current?.querySelectorAll<HTMLElement>('[id]') ?? []).find(element => element.id === id);
    if (!heading) return;
    event.preventDefault();
    heading.scrollIntoView({ block: 'start' });
    heading.focus({ preventScroll: true });
  }, []);
  // Replacing these component types would close nested previews on a reader update.
  const components = useMemo<Components>(() => ({
      img: ({ src, alt }) => {
        const assetId = assetIdFromUrl(src);
        return assetId ? <AssetReferenceImage assetId={assetId} alt={alt} /> : isAssetImageUrl(src) ? <img src={src} alt={alt || 'Attached image'} loading="lazy" /> : <span className="markdown-image-placeholder">{alt || 'Image'} · preview unavailable</span>;
      },
      a: ({ href, children: label }) => {
        const assetId = assetIdFromUrl(href);
        if (assetId) return <AssetReferenceLink assetId={assetId}>{label}</AssetReferenceLink>;
        if (href?.startsWith('#')) {
          let anchor = href.slice(1);
          try { anchor = decodeURIComponent(anchor); } catch { /* Keep a malformed anchor inert. */ }
          const id = `${prefix}${anchor}`;
          return <a href={`#${id}`} onClick={event => jump(event, id)}>{label}</a>;
        }
        return href && /^(https?:|mailto:)/i.test(href) ? <a href={href} target="_blank" rel="noreferrer">{label}</a> : <span>{label}</span>;
      },
      table: ({ children: cells }) => <div className="asset-table-scroll" tabIndex={0} role="region" aria-label="Document table"><table>{cells}</table></div>,
  }), [prefix, jump]);
  return <div className="asset-document-layout">
    {headings.length > 2 && <nav className="asset-outline" aria-label="Document contents"><details open><summary>On this page</summary><ol>{headings.map(heading => <li key={heading.id} className={`asset-outline-level-${heading.level}`}><a href={`#${heading.id}`} onClick={event => jump(event, heading.id)}>{heading.label}</a></li>)}</ol></details></nav>}
    <div className="markdown asset-markdown" ref={document}><ReactMarkdown skipHtml urlTransform={assetMarkdownUrl} remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeAssetHeadings, { prefix }]]} components={components}>{children}</ReactMarkdown></div>
  </div>;
}
