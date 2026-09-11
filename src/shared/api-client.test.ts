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
