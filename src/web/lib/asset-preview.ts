import { projectApiPrefix } from './project';

export { assetPreviewKind, type AssetPreviewKind } from '../../shared/asset-kinds';

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
