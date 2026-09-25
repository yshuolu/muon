import type { Asset } from './types';

export type AssetPreviewKind = 'markdown' | 'image' | 'video' | 'audio' | 'text' | 'download';

/** Active document formats are shown as source, never embedded or executed. Shared so the server applies the same rule. */
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
