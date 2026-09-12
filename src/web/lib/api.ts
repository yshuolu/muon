import { useCallback, useEffect, useState } from 'react';
import type { AppSnapshot } from '../../shared/types';
import { ApiClient } from '../../shared/api-client';

const client = new ApiClient();
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  return client.request<T>(path, method, body);
}

export function useWorkspace() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setSnapshot(await api<AppSnapshot>('/state')); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to connect to Muon.'); }
  }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const next = await api<AppSnapshot>('/state'); if (active) { setSnapshot(next); setError(null); } }
      catch (cause) { if (active) setError(cause instanceof Error ? cause.message : 'Unable to connect to Muon.'); }
      if (active) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, []);
  return { snapshot, error, refresh };
}
