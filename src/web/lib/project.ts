/** The project that project-scoped API calls and asset URLs address. The app sets it from the URL. */
const STORAGE_KEY = 'muon.activeProject';
let active: string | null = null;

export function activeProjectId(): string | null {
  return active;
}

export function setActiveProject(id: string | null) {
  active = id;
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch { /* Private browsing or blocked storage: the URL still carries the project. */ }
}

/** The last project this browser worked in, if storage allows remembering it. */
export function rememberedProjectId(): string | null {
  try { return window.localStorage.getItem(STORAGE_KEY); }
  catch { return null; }
}

export function projectApiPrefix(): string {
  return active ? `/api/projects/${encodeURIComponent(active)}` : '/api';
}
