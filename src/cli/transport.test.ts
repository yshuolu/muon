import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiClient } from '../shared/api-client';
import { createCliTransport } from './transport';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function listen(server: Server) {
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  cleanups.push(() => new Promise<void>((resolveClose, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolveClose()); }));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture listener.');
  return `http://127.0.0.1:${address.port}`;
}
async function proxyFixture() {
  const tunnels: string[] = []; const connections = new Set<Socket>();
  const proxy = createServer((_request, response) => { response.writeHead(501); response.end(); });
  proxy.on('connect', (request, client, head) => {
    tunnels.push(request.url ?? '');
    const target = new URL(`http://${request.url}`);
    const upstream = connect(Number(target.port), target.hostname);
    connections.add(upstream); connections.add(client as Socket);
    client.on('close', () => { connections.delete(client as Socket); upstream.destroy(); });
    upstream.on('close', () => { connections.delete(upstream); client.destroy(); });
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    upstream.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
  });
  const url = await listen(proxy);
  cleanups.push(async () => { for (const connection of connections) connection.destroy(); });
  return { url, tunnels };
}
const withoutProxy = () => {
  const env = { ...process.env };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy', 'MUON_CLI_SANDBOX_PROXY']) delete env[key];
  return env;
};

describe('CLI sandbox proxy transport', () => {
  it('requires the sandbox proxy without any direct-network fallback', () => {
    expect(() => createCliTransport({ MUON_CLI_SANDBOX_PROXY: '1' })).toThrow('requires its sandbox HTTP proxy');
    expect(createCliTransport({}).fetch).toBe(globalThis.fetch);
  });

  it('sends loopback API requests and bearer tokens through the proxy despite NO_PROXY and refuses redirects', async () => {
    const received: Array<{ method?: string; path?: string; auth?: string; body: string }> = [];
    let redirected = 0;
    const destination = await listen(createServer((_request, response) => { redirected++; response.end('{}'); }));
    const apiUrl = await listen(createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk;
      received.push({ method: request.method, path: request.url, auth: request.headers.authorization, body });
      if (request.url === '/api/redirect') { response.writeHead(302, { Location: `${destination}/api/secret` }); response.end(); }
      else { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ id: 'proxy-task' })); }
    }));
    const proxy = await proxyFixture();
    const transport = createCliTransport({ HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: '*', no_proxy: '127.0.0.1,localhost', MUON_CLI_SANDBOX_PROXY: '1', MUON_API_URL: apiUrl });
    cleanups.push(() => transport.close());
    const client = new ApiClient({ baseUrl: apiUrl, token: 'scoped-bearer', fetch: transport.fetch });
    expect(await client.request('/tasks', 'POST', { title: 'Through sandbox' })).toEqual({ id: 'proxy-task' });
    expect(proxy.tunnels.length).toBeGreaterThan(0); expect(proxy.tunnels.every(host => host === new URL(apiUrl).host)).toBe(true);
    expect(received[0]).toEqual({ method: 'POST', path: '/api/tasks', auth: 'Bearer scoped-bearer', body: '{"title":"Through sandbox"}' });
    await expect(client.request('/redirect')).rejects.toMatchObject({ code: 'connection_failed' });
    expect(redirected).toBe(0);
  });

  it('honors ordinary owner NO_PROXY and lowercase proxy environment precedence', async () => {
    let requests = 0;
    const apiUrl = await listen(createServer((_request, response) => { requests++; response.setHeader('Content-Type', 'application/json'); response.end('{"ok":true}'); }));
    const proxy = await proxyFixture();
    const bypass = createCliTransport({ http_proxy: proxy.url, HTTP_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1' }); cleanups.push(() => bypass.close());
    expect(await new ApiClient({ baseUrl: apiUrl, fetch: bypass.fetch }).request('/health')).toEqual({ ok: true });
    expect(proxy.tunnels).toEqual([]);
    const proxied = createCliTransport({ http_proxy: proxy.url, HTTP_PROXY: 'http://127.0.0.1:1', no_proxy: '' }); cleanups.push(() => proxied.close());
    expect(await new ApiClient({ baseUrl: apiUrl, fetch: proxied.fetch }).request('/health')).toEqual({ ok: true });
    expect(proxy.tunnels).toHaveLength(1); expect(requests).toBe(2);
  });

  it('uses the proxy in the actual launcher from another cwd', async () => {
    let authorization: string | undefined;
    const apiUrl = await listen(createServer((request, response) => { authorization = request.headers.authorization; response.setHeader('Content-Type', 'application/json'); response.end('{"ok":true}'); }));
    const proxy = await proxyFixture();
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveChild, reject) => {
      const child = spawn(process.execPath, [resolve('bin/muon.mjs'), 'health'], { cwd: tmpdir(), env: { ...withoutProxy(), HTTP_PROXY: proxy.url, NO_PROXY: '*', MUON_API_URL: apiUrl, MUON_API_TOKEN: 'actual-cli-token', MUON_CLI_SANDBOX_PROXY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject); child.once('close', code => resolveChild({ code, stdout, stderr }));
    });
    expect(result).toEqual({ code: 0, stdout: '{"ok":true}\n', stderr: '' });
    expect(proxy.tunnels).toEqual([new URL(apiUrl).host]); expect(authorization).toBe('Bearer actual-cli-token');
  }, 15_000);
});
