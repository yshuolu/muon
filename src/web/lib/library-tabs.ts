/** Open document tabs per project, remembered in this browser so a reload restores the reader. */
const MAX_TABS = 12;
const key = (projectId: string) => `muon.libraryTabs.${projectId}`;

export function loadTabs(projectId: string): string[] {
  try {
    const stored = window.localStorage.getItem(key(projectId));
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(-MAX_TABS) : [];
  } catch { return []; }
}

export function saveTabs(projectId: string, tabs: string[]) {
  try { window.localStorage.setItem(key(projectId), JSON.stringify(tabs)); }
  catch { /* Private browsing or blocked storage: tabs last for this page only. */ }
}

/** Adds a document as the newest tab, dropping the oldest when the strip is full. */
export function openTab(tabs: string[], id: string): string[] {
  if (tabs.includes(id)) return tabs;
  return [...tabs, id].slice(-MAX_TABS);
}

/** Swaps a superseded document for its newest version in place; if that version is already open, its tab wins. */
export function replaceTab(tabs: string[], id: string, next: string): string[] {
  if (id === next || !tabs.includes(id)) return tabs;
  return tabs.includes(next) ? tabs.filter(tab => tab !== id) : tabs.map(tab => tab === id ? next : tab);
}

/** Removes a tab and names the tab to show next: the neighbor to the right, else the left, else none. */
export function closeTab(tabs: string[], id: string, active: string | null): { tabs: string[]; active: string | null } {
  const index = tabs.indexOf(id);
  if (index < 0) return { tabs, active };
  const remaining = tabs.filter(tab => tab !== id);
  if (active !== id) return { tabs: remaining, active };
  return { tabs: remaining, active: remaining[index] ?? remaining[index - 1] ?? null };
}
