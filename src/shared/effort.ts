import type { Provider } from './types';

/** Thinking effort levels each agent accepts, lowest first. The configured default (`MUON_*_EFFORT`) is used when unset. */
export const EFFORT_LEVELS: Record<Provider, readonly string[]> = {
  claude: ['low', 'medium', 'high', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'ultra'],
};

export const ALL_EFFORT_LEVELS = [...new Set(Object.values(EFFORT_LEVELS).flat())] as [string, ...string[]];

/** An effort saved for one provider is meaningless for another: only a level the provider accepts is passed on. */
export function effortFor(provider: Provider, effort: string | null | undefined): string | undefined {
  return effort && EFFORT_LEVELS[provider].includes(effort) ? effort : undefined;
}
