import { assetIdFromUrl } from '../../shared/asset-references';
import { AlertCircle, ArrowDown, ArrowUp, Check, CheckCircle2, Circle, CircleDashed, CircleDot, CirclePause, Minus, SignalHigh, SignalLow, SignalMedium, Sparkles, XCircle } from 'lucide-react';
import type { Priority, Provider, TaskStatus } from '../../shared/types';
import { PRIORITY_LABELS, STATUS_LABELS } from '../../shared/types';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isAssetImageUrl } from '../lib/asset-preview';
import { assetMarkdownUrl, AssetReferenceImage, AssetReferenceLink } from './asset-preview';

// Stable renderer identities keep open asset dialogs mounted during workspace polling.
const MARKDOWN_COMPONENTS: Components = {
  img: ({ src, alt }) => {
    const assetId = assetIdFromUrl(src);
    return assetId ? <AssetReferenceImage assetId={assetId} alt={alt} /> : typeof src === 'string' && (isAssetImageUrl(src) || src.startsWith('/api/artifacts/') || /^data:image\/(png|jpeg|gif|webp);base64,/i.test(src))
      ? <img src={src} alt={alt || 'Attached image'} loading="lazy" />
      : <span className="markdown-image-placeholder">{alt || 'Image'} · external image</span>;
  },
  a: ({ href, children: label }) => {
    const assetId = assetIdFromUrl(href);
    return assetId ? <AssetReferenceLink assetId={assetId}>{label}</AssetReferenceLink> : <a href={href} target="_blank" rel="noreferrer">{label}</a>;
  },
};

export function MuonMark({ small = false }: { small?: boolean }) {
  return <span className={`muon-mark ${small ? 'small' : ''}`} aria-hidden="true"><i /><i /><i /></span>;
}
export function StatusIcon({ status, size = 15 }: { status: TaskStatus; size?: number }) {
  const icons = { backlog: CircleDashed, todo: Circle, in_progress: CircleDot, in_review: CirclePause, done: CheckCircle2, blocked: AlertCircle, canceled: XCircle };
  const Icon = icons[status];
  return <Icon size={size} className={`status-icon status-${status}`} aria-label={STATUS_LABELS[status]} />;
}
export function PriorityIcon({ priority }: { priority: Priority }) {
  const icons = { 0: Minus, 1: AlertCircle, 2: SignalHigh, 3: SignalMedium, 4: SignalLow };
  const Icon = icons[priority];
  return <span className={`priority-icon priority-${priority}`} title={PRIORITY_LABELS[priority]}><Icon size={15} aria-label={PRIORITY_LABELS[priority]} /></span>;
}
export function ProviderBadge({ provider }: { provider: Provider }) {
  return <span className={`provider-badge provider-${provider}`}><span aria-hidden="true">{provider === 'claude' ? '✳' : '⌘'}</span>{provider === 'claude' ? 'Claude' : 'Codex'}</span>;
}
export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon || <Sparkles size={24} />}</div><h3>{title}</h3><p>{description}</p>{action}</div>;
}
export function Markdown({ children }: { children: string }) {
  return <div className="markdown"><ReactMarkdown skipHtml urlTransform={assetMarkdownUrl} remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{children}</ReactMarkdown></div>;
}
export function ResultIcon({ result }: { result?: 'passed' | 'failed' | 'skipped' }) {
  return result === 'passed' ? <Check size={15} className="text-success" /> : result === 'failed' ? <XCircle size={15} className="text-danger" /> : <Minus size={15} />;
}
export function FileChanges({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="file-changes"><span><ArrowUp size={11} />{additions}</span><span><ArrowDown size={11} />{deletions}</span></span>;
}
