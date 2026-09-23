import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSnapshot, Project } from '../../shared/types';
import { ApiClient, ApiError } from '../../shared/api-client';
import { activeProjectId, setActiveProject } from './project';

const client = new ApiClient();
/** Project-scoped paths are sent under the active project; workspace paths (projects, health) are not. */
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  client.project = activeProjectId() ?? undefined;
  return client.request<T>(path, method, body);
}

interface ProjectList { list: Project[]; forProject: string | null }

/**
 * Polls the active project's state, or only the project list while no project is active.
 * Results from a previous project are dropped so a switch never shows stale records, and the
 * project list records which project it was fetched under so the app can tell a fresh list from a stale one.
 */
export function useWorkspace(projectId: string | null) {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [projects, setProjects] = useState<ProjectList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(projectId);
  const refresh = useCallback(async () => {
    const target = current.current;
    try {
      if (target) {
        const next = await api<AppSnapshot>('/state');
        if (current.current !== target) return;
        setSnapshot(next); setProjects({ list: next.projects ?? [], forProject: target }); setError(null);
      } else {
        const list = await api<Project[]>('/projects');
        if (current.current !== target) return;
        setProjects({ list, forProject: null }); setError(null);
      }
    } catch (cause) {
      if (current.current !== target) return;
      if (target && cause instanceof ApiError && cause.status === 404) {
        // The project was archived or never existed; let the app choose another one from the list.
        try {
          const list = await api<Project[]>('/projects');
          if (current.current === target) { setProjects({ list, forProject: target }); setError(null); }
          return;
        } catch { /* Fall through to the connection error below. */ }
      }
      setError(cause instanceof Error ? cause.message : 'Unable to connect to Muon.');
    }
  }, []);
  useEffect(() => {
    current.current = projectId;
    setActiveProject(projectId);
    setSnapshot(null);
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (active) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [projectId, refresh]);
  return { snapshot, projects: projects?.list ?? null, projectsResolvedFor: projects ? projects.forProject : undefined, error, refresh };
}
