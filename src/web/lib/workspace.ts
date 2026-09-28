/** The workspace that workspace-scoped API calls and asset URLs address. The app sets it from the URL. */
const STORAGE_KEY = 'muon.activeWorkspace';
let active: string | null = null;

export function activeWorkspaceId(): string | null {
  return active;
}

export function setActiveWorkspace(id: string | null) {
  active = id;
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch { /* Private browsing or blocked storage: the URL still carries the workspace. */ }
}

/** The last workspace this browser worked in, if storage allows remembering it. */
export function rememberedWorkspaceId(): string | null {
  try { return window.localStorage.getItem(STORAGE_KEY); }
  catch { return null; }
}

export function workspaceApiPrefix(): string {
  return active ? `/api/workspaces/${encodeURIComponent(active)}` : '/api';
}
