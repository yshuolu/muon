import type { Asset } from '../../shared/types';
import { projectApiPrefix } from './project';

export type AssetPreviewKind = 'markdown' | 'image' | 'video' | 'audio' | 'text' | 'download';

/** Active document formats are shown as source, never embedded or executed. */
export function assetPreviewKind(asset: Pick<Asset, 'name' | 'mediaType'>): AssetPreviewKind {
  const mediaType = asset.mediaType.split(';')[0].toLowerCase();
  if (['text/markdown', 'text/x-markdown'].includes(mediaType) || /\.(md|markdown)$/i.test(asset.name)) return 'markdown';
  if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(mediaType)) return 'image';
  if (/^video\/(mp4|webm|ogg|quicktime)$/.test(mediaType)) return 'video';
  if (/^audio\/(mpeg|mp4|ogg|wav|webm|flac|x-wav)$/.test(mediaType)) return 'audio';
  if (mediaType.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript', 'image/svg+xml'].includes(mediaType)
    || /\.(txt|log|json|jsonl|csv|tsv|ya?ml|toml|xml|html?|css|[cm]?[jt]sx?|py|sh|sql|rs|go|java|rb|svg)$/i.test(asset.name)) return 'text';
  return 'download';
}

export function assetContentUrl(id: string, download = false): string {
  return `${projectApiPrefix()}/assets/${encodeURIComponent(id)}/content${download ? '?download=1' : ''}`;
}

export function formatAssetSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isAssetImageUrl(src: string | undefined): boolean {
  return typeof src === 'string' && /^\/api\/(projects\/[A-Za-z0-9_.%~-]+\/)?assets\/[A-Za-z0-9_-]+\/content$/.test(src);
}

interface MarkdownTree {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownTree[];
}

function headingText(node: MarkdownTree): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? '';
  if (node.tagName === 'img') return typeof node.properties?.alt === 'string' ? node.properties.alt : '';
  return (node.children ?? []).map(headingText).join('');
}

/** Stable, duplicate-safe heading anchors also keep separate readers isolated. */
export function rehypeAssetHeadings({ prefix }: { prefix: string }) {
  return (tree: MarkdownTree) => {
    const used = new Set<string>();
    function visit(node: MarkdownTree) {
      if (node.tagName && /^h[1-6]$/.test(node.tagName)) {
        const base = headingText(node).toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-') || 'section';
        let slug = base;
        let duplicate = 0;
        while (used.has(slug)) slug = `${base}-${++duplicate}`;
        used.add(slug);
        node.properties = { ...node.properties, id: `${prefix}${slug}`, tabIndex: -1 };
      }
      for (const child of node.children ?? []) visit(child);
    }
    visit(tree);
  };
}
