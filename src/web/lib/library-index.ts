import type { Asset } from '../../shared/types';
import { api } from './api';
import { projectApiPrefix } from './project';

const TTL = 15_000;
let cache: { key: string; at: number; assets: Promise<Asset[]> } | null = null;

/** The active project's Library listing, shared by every composer's `@` menu and refreshed after a short interval. */
export function libraryDocuments(): Promise<Asset[]> {
  const key = projectApiPrefix();
  if (cache && cache.key === key && Date.now() - cache.at < TTL) return cache.assets;
  const assets = api<Asset[]>('/assets').catch(error => { if (cache?.assets === assets) cache = null; throw error; });
  cache = { key, at: Date.now(), assets };
  return assets;
}
