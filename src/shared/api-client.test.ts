import { afterEach, expect, it, vi } from 'vitest';
import { ApiClient } from './api-client';

afterEach(() => vi.unstubAllGlobals());

it('preserves the browser fetch receiver for the shared HTTP client', async () => {
  vi.stubGlobal('fetch', function (this: unknown, input: string) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    expect(input).toBe('/api/health');
    return Promise.resolve(Response.json({ ok: true }));
  });
  await expect(new ApiClient().request('/health')).resolves.toEqual({ ok: true });
});

it('lets the platform set the multipart boundary and retains original upload bytes', async () => {
  const form = new FormData();
  form.append('file', new File(['# Report'], 'report.md', { type: 'text/markdown' }));
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).has('content-type')).toBe(false);
    expect(init?.body).toBe(form);
    expect(await (form.get('file') as File).text()).toBe('# Report');
    return Response.json({ id: 'asset' });
  });
  expect(await new ApiClient({ fetch: fetcher }).request('/assets', 'POST', form)).toEqual({ id: 'asset' });
});

it('addresses workspace-scoped resources under the selected workspace and leaves workspace paths alone', async () => {
  const urls: string[] = [];
  const client = new ApiClient({ workspace: 'local-project', fetch: async url => { urls.push(String(url)); return Response.json({}); } });
  for (const path of ['/state', '/api/tasks?status=todo', '/workspace', '/workspaces', '/workspaces/other/archive', '/health', '/api', '/assets/a/content']) await client.request(path);
  expect(urls).toEqual([
    '/api/workspaces/local-project/state', '/api/workspaces/local-project/tasks?status=todo', '/api/workspaces/local-project/workspace',
    '/api/workspaces', '/api/workspaces/other/archive', '/api/health', '/api', '/api/workspaces/local-project/assets/a/content',
  ]);
  client.workspace = undefined;
  await client.request('/state');
  expect(urls.at(-1)).toBe('/api/state');
});
