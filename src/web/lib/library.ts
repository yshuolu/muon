import type { Asset, Task } from '../../shared/types';
import { taskAssetIds } from '../../shared/asset-references';
import { assetPreviewKind } from './asset-preview';

export type LibraryKind = 'document' | 'image' | 'media' | 'data' | 'other';
export const LIBRARY_KIND_LABELS: Record<LibraryKind, string> = { document: 'Document', image: 'Image', media: 'Media', data: 'Text & data', other: 'File' };
export const LIBRARY_KIND_FILTERS: Record<LibraryKind, string> = { document: 'Documents & notes', image: 'Images', media: 'Video & audio', data: 'Text & data', other: 'Other files' };
export const ORIGIN_LABELS: Record<Asset['origin'], string> = { upload: 'Uploaded', generated: 'Generated', imported: 'Imported' };
export const LIBRARY_KINDS = Object.keys(LIBRARY_KIND_LABELS) as LibraryKind[];

export interface LibraryFilter {
  query: string;
  kind: LibraryKind | 'all';
  origin: Asset['origin'] | 'all';
}

/** Library groups follow what the reader can show, so a filter never hides a previewable file. */
export function libraryKind(asset: Pick<Asset, 'name' | 'mediaType'>): LibraryKind {
  const preview = assetPreviewKind(asset);
  if (preview === 'markdown') return 'document';
  if (preview === 'image') return 'image';
  if (preview === 'video' || preview === 'audio') return 'media';
  if (preview === 'text') return 'data';
  return 'other';
}

/** Tasks whose text references each asset. Tasks persist references only in text. */
export function assetReferrers(tasks: Task[]): Map<string, Task[]> {
  const referrers = new Map<string, Task[]>();
  for (const task of tasks) {
    for (const id of taskAssetIds(task)) referrers.set(id, [...(referrers.get(id) ?? []), task]);
  }
  return referrers;
}

/** Newest first; the search also matches the tasks that reference a file. */
export function filterLibrary(assets: Asset[], filter: LibraryFilter, referrers: Map<string, Task[]> = new Map()): Asset[] {
  const query = filter.query.trim().toLowerCase();
  return assets.filter(asset => {
    if (filter.kind !== 'all' && libraryKind(asset) !== filter.kind) return false;
    if (filter.origin !== 'all' && asset.origin !== filter.origin) return false;
    if (!query) return true;
    const tasks = referrers.get(asset.id) ?? [];
    const text = [asset.name, asset.mediaType, asset.sourcePath ?? '', ...tasks.flatMap(task => [task.identifier, task.title])].join('\n').toLowerCase();
    return text.includes(query);
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}
