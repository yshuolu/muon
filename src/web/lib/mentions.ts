import type { Asset } from '../../shared/types';
import { assetReference } from '../../shared/asset-references';

/** An `@` mention being typed: where it starts in the text and the query typed after it. */
export interface MentionQuery { start: number; query: string }

/** Finds an `@query` immediately before the caret. The `@` must start the text or follow whitespace or a bracket. */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const match = /(?:^|[\s([{])@([^\s@()[\]{}]{0,80})$/.exec(text.slice(0, caret));
  return match ? { start: caret - match[1].length - 1, query: match[1] } : null;
}

/** Library documents matching the query: current versions only, prefix matches first, then newest first. */
export function filterMentions(assets: Asset[], query: string, limit = 8): Asset[] {
  const needle = query.trim().toLowerCase();
  const rank = (asset: Asset) => {
    const name = asset.name.toLowerCase();
    return !needle ? 1 : name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : -1;
  };
  return assets
    .filter(asset => !asset.latestVersionId && rank(asset) >= 0)
    .sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

/** Replaces the typed `@query` with a Markdown asset reference and returns the caret position after it. */
export function insertMention(text: string, mention: MentionQuery, caret: number, asset: Pick<Asset, 'id' | 'name'>): { text: string; caret: number } {
  const reference = `${assetReference(asset)} `;
  const before = text.slice(0, mention.start);
  return { text: `${before}${reference}${text.slice(caret)}`, caret: before.length + reference.length };
}
