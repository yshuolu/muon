import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSnapshot, Workspace } from '../../shared/types';
import { ApiClient, ApiError } from '../../shared/api-client';
import { activeWorkspaceId, setActiveWorkspace } from './workspace';

const client = new ApiClient();
/** Workspace-scoped paths are sent under the active workspace; workspace paths (workspaces, health) are not. */
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  client.workspace = activeWorkspaceId() ?? undefined;
  return client.request<T>(path, method, body);
}

interface WorkspaceList { list: Workspace[]; forWorkspace: string | null }

/**
 * Polls the active workspace's state, or only the workspace list while no workspace is active.
 * Results from a previous workspace are dropped so a switch never shows stale records, and the
 * workspace list records which workspace it was fetched under so the app can tell a fresh list from a stale one.
 */
export function useAppState(workspaceId: string | null) {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(workspaceId);
  const refresh = useCallback(async () => {
    const target = current.current;
    try {
      if (target) {
        const next = await api<AppSnapshot>('/state');
        if (current.current !== target) return;
        setSnapshot(next); setWorkspaces({ list: next.workspaces ?? [], forWorkspace: target }); setError(null);
      } else {
        const list = await api<Workspace[]>('/workspaces');
        if (current.current !== target) return;
        setWorkspaces({ list, forWorkspace: null }); setError(null);
      }
    } catch (cause) {
      if (current.current !== target) return;
      if (target && cause instanceof ApiError && cause.status === 404) {
        // The workspace was archived or never existed; let the app choose another one from the list.
        try {
          const list = await api<Workspace[]>('/workspaces');
          if (current.current === target) { setWorkspaces({ list, forWorkspace: target }); setError(null); }
          return;
        } catch { /* Fall through to the connection error below. */ }
      }
      setError(cause instanceof Error ? cause.message : 'Unable to connect to Muon.');
    }
  }, []);
  useEffect(() => {
    current.current = workspaceId;
    setActiveWorkspace(workspaceId);
    setSnapshot(null);
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (active) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [workspaceId, refresh]);
  return { snapshot, workspaces: workspaces?.list ?? null, workspacesResolvedFor: workspaces ? workspaces.forWorkspace : undefined, error, refresh };
}
