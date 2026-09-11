import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ApiClient, ApiError } from '../shared/api-client';
import { runCli } from './cli';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean(); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'muon-cli-')); cleanup.push(() => rm(path, { recursive: true, force: true })); return path; }
function harness(fetcher: typeof fetch = async () => Response.json({ ok: true }), env: NodeJS.ProcessEnv = {}, cwd = tmpdir(), input = '') {
  const stdout: Array<string | Uint8Array> = []; const stderr: string[] = [];
  return { stdout, stderr, run: (args: string[]) => runCli(args, { stdout: value => stdout.push(value), stderr: value => stderr.push(value), env, cwd, stdin: async () => input, fetch: fetcher }) };
}
function child(args: string[], env: NodeJS.ProcessEnv, cwd: string, input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveChild, reject) => {
    const processChild = spawn(process.execPath, [resolve('bin/muon.mjs'), ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    processChild.stdout.on('data', data => { stdout += data; }); processChild.stderr.on('data', data => { stderr += data; });
    processChild.on('error', reject); processChild.on('close', code => resolveChild({ code, stdout, stderr }));
    processChild.stdin.end(input);
  });
}

describe('REST client boundary', () => {
  it('uses one API origin, env bearer capability, and disallows redirects', async () => {
    const calls: Array<{ url: unknown; options?: RequestInit }> = [];
    const client = new ApiClient({ baseUrl: 'https://muon.example/api/', token: 'capability', fetch: async (url, options) => { calls.push({ url, options }); return Response.json({ id: 'task-1' }); } });
    expect(await client.request('/api/tasks', 'POST', { title: 'Build' })).toEqual({ id: 'task-1' });
    expect(calls[0].url).toBe('https://muon.example/api/tasks');
    expect(calls[0].options?.redirect).toBe('error');
    expect(new Headers(calls[0].options?.headers).get('authorization')).toBe('Bearer capability');
    expect(calls[0].options?.body).toBe('{"title":"Build"}');
    await expect(client.request('//other.example/api/state')).rejects.toThrow('relative paths');
    await expect(client.request('/api/%2e%2e/settings')).rejects.toThrow('traverse');
    await expect(client.request('/api/..%2fsettings')).rejects.toThrow('traverse');
    expect(calls).toHaveLength(1);
    expect(() => new ApiClient({ baseUrl: 'https://secret:token@muon.example' })).toThrow('without credentials');
  });

  it('preserves structured HTTP error status and never invents success when disconnected', async () => {
    const rejected = new ApiClient({ fetch: async () => Response.json({ error: { code: 'owner_only', message: 'Only the owner can approve.' } }, { status: 403 }) });
    await expect(rejected.request('/tasks/a/approve', 'POST', { planId: 'p1' })).rejects.toMatchObject({ status: 403, code: 'owner_only', message: 'Only the owner can approve.' });
    const disconnected = new ApiClient({ fetch: async () => { throw new Error('secret details'); } });
    await expect(disconnected.request('/state')).rejects.toMatchObject({ status: 0, code: 'connection_failed' });
    await expect(disconnected.request('/state')).rejects.not.toThrow('secret details');
  });
});

describe('Muon CLI', () => {
  it('routes commands and task filters to the public REST resources', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const io = harness(async (url, options) => { calls.push({ url: String(url), method: options?.method ?? 'GET', body: options?.body ? JSON.parse(String(options.body)) : undefined }); return Response.json({ ok: true }); });
    expect(await io.run(['tasks', 'list', '--status', 'todo', '--parent', 'MUO-2', '--blocked-by', 'MUO-1', '--search', 'hello world'])).toBe(0);
    expect(calls[0].url).toBe('http://127.0.0.1:4310/api/tasks?status=todo&parentId=MUO-2&blockedById=MUO-1&search=hello+world');
    expect(await io.run(['tasks', 'create', '--json', '{"title":"Build","kind":"group"}'])).toBe(0);
    expect(calls[1]).toMatchObject({ method: 'POST', body: { title: 'Build', kind: 'group' } });
    expect(await io.run(['tasks', 'update', 'MUO-1', '--json', '{"priority":1}'])).toBe(0);
    expect(calls[2]).toMatchObject({ method: 'PATCH', body: { priority: 1 } });
    expect(await io.run(['tasks', 'MUO-1', 'files'])).toBe(0);
    expect(calls[3].url).toMatch(/\/tasks\/MUO-1\/files$/);
    expect(await io.run(['tasks', 'runs', 'MUO-1'])).toBe(0);
    expect(await io.run(['attention', 'list', '--unread'])).toBe(0);
    expect(calls[5].url).toMatch(/\/attention\?unread=true$/);
    expect(await io.run(['chief', 'send', '--json', '{"content":"Organize this project"}'])).toBe(0);
    expect(calls[6]).toMatchObject({ method: 'POST', body: { content: 'Organize this project' } });
    expect(io.stderr).toEqual([]);
  });

  it('requires exact review identity and prevents ignored flags or malformed request bodies', async () => {
    let calls = 0; const io = harness(async () => { calls++; return Response.json({ ok: true }); });
    for (const args of [
      ['tasks', 'approve', 'MUO-1'], ['tasks', 'approve', 'MUO-1', '--plan-id', ''],
      ['tasks', 'request-changes', 'MUO-1', '--plan-id', 'p1'],
      ['tasks', 'create', '--json', '[]'], ['tasks', 'create', '--json', '{}', '--unknown', 'yes'],
      ['tasks', 'retry', 'MUO-1', '--json', '{"mode":"retry"}', '--mode', 'fix'],
      ['api', 'GET', 'https://other.example/api/state'],
    ]) expect(await io.run(args)).toBe(1);
    expect(calls).toBe(0);
    expect(await io.run(['tasks', 'approve', 'MUO-1', '--plan-id', 'exact-v2'])).toBe(0);
    expect(calls).toBe(1);
  });

  it('reads plan conversations and posts exact-plan comments from options, JSON, or stdin', async () => {
    const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
    const io = harness(async (url, options) => {
      calls.push({ path: new URL(String(url)).pathname, method: options?.method, body: options?.body ? JSON.parse(String(options.body)) : undefined });
      return Response.json({ ok: true });
    }, {}, tmpdir(), '{"planId":"v3","content":"Keep this constraint too."}');
    expect(await io.run(['tasks', 'discussion', 'MUO-8'])).toBe(0);
    expect(await io.run(['tasks', 'MUO-8', 'discussion'])).toBe(0);
    expect(await io.run(['tasks', 'comment', 'MUO-8', '--plan-id', 'v1', '--content', 'Add keyboard tests.'])).toBe(0);
    expect(await io.run(['tasks', 'comment', 'MUO-8', '--json', '{"planId":"v2","content":"Also test focus restoration."}'])).toBe(0);
    expect(await io.run(['tasks', 'comment', 'MUO-8', '--file', '-'])).toBe(0);
    expect(calls.map(call => call.path)).toEqual(Array(5).fill('/api/tasks/MUO-8/plan-discussion'));
    expect(calls.slice(0, 2).map(call => call.method)).toEqual(['GET', 'GET']);
    expect(calls.slice(2)).toEqual([
      { path: '/api/tasks/MUO-8/plan-discussion', method: 'POST', body: { planId: 'v1', content: 'Add keyboard tests.' } },
      { path: '/api/tasks/MUO-8/plan-discussion', method: 'POST', body: { planId: 'v2', content: 'Also test focus restoration.' } },
      { path: '/api/tasks/MUO-8/plan-discussion', method: 'POST', body: { planId: 'v3', content: 'Keep this constraint too.' } },
    ]);
    for (const args of [
      ['tasks', 'comment', 'MUO-8', '--content', 'Missing plan.'],
      ['tasks', 'comment', 'MUO-8', '--plan-id', 'v3'],
      ['tasks', 'comment', 'MUO-8', '--plan-id', 'v3', '--content', '   '],
      ['tasks', 'comment', 'MUO-8', '--json', '{"planId":"v3","content":"Duplicate"}', '--content', 'Duplicate'],
    ]) expect(await io.run(args)).toBe(1);
    expect(calls).toHaveLength(5);
    const conflict = harness(async () => Response.json({ error: 'The RFC has changed. Refresh before commenting.' }, { status: 409 }));
    expect(await conflict.run(['tasks', 'comment', 'MUO-8', '--plan-id', 'old', '--content', 'Stale feedback'])).toBe(1);
    expect(JSON.parse(conflict.stderr[0]).error.status).toBe(409);
  });

  it('supports relative JSON input files and stdin without a database fallback', async () => {
    const cwd = await directory(); await writeFile(join(cwd, 'task.json'), '{"title":"From file"}');
    const bodies: unknown[] = [];
    const io = harness(async (_url, options) => { bodies.push(JSON.parse(String(options?.body))); return Response.json({ ok: true }); }, {}, cwd, '{"title":"From stdin"}');
    expect(await io.run(['tasks', 'create', '--file', 'task.json'])).toBe(0);
    expect(await io.run(['tasks', 'create', '--file', '-'])).toBe(0);
    expect(bodies).toEqual([{ title: 'From file' }, { title: 'From stdin' }]);
    expect(await io.run(['tasks', 'create', '--file', '-', '--json', '{}'])).toBe(1);
  });

  it('exports exact artifact and RFC bytes and refuses to overwrite existing files', async () => {
    const cwd = await directory(); const bytes = new Uint8Array([0, 255, 128, 65]);
    const io = harness(async url => String(url).includes('/plans/') ? Response.json({ content: '# RFC\nExact Unicode: ✓\n', format: 'markdown' }) : new Response(bytes, { headers: { 'content-type': 'video/webm' } }), {}, cwd);
    expect(await io.run(['artifacts', 'download', 'recording-1', '--output', 'video.webm'])).toBe(0);
    expect(new Uint8Array(await readFile(join(cwd, 'video.webm')))).toEqual(bytes);
    expect(await io.run(['artifacts', 'download', 'recording-1', '--output', 'video.webm'])).toBe(1);
    expect(await io.run(['tasks', 'plan', 'MUO-1', 'plan-v1', '--output', 'rfc.md'])).toBe(0);
    expect(await readFile(join(cwd, 'rfc.md'), 'utf8')).toBe('# RFC\nExact Unicode: ✓\n');
  });

  it('returns JSON errors and redacts capability values even from a server error', async () => {
    const io = harness(async () => Response.json({ error: { code: 'forbidden', message: 'Denied token-private' } }, { status: 403 }), { MUON_API_TOKEN: 'token-private' });
    expect(await io.run(['tasks', 'approve', 'MUO-1', '--plan-id', 'p1'])).toBe(1);
    expect(io.stdout).toEqual([]);
    expect(JSON.parse(io.stderr[0])).toEqual({ error: { code: 'forbidden', message: 'Denied [redacted]', status: 403 } });
  });

  it('runs the actual launcher from an unrelated cwd against HTTP, with stdin and auth', async () => {
    const seen: Array<{ method?: string; path?: string; token?: string; body: string }> = [];
    const server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk;
      seen.push({ method: request.method, path: request.url, token: request.headers.authorization, body });
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/tasks/MUO-7/approve') { response.writeHead(403); response.end(JSON.stringify({ error: { code: 'owner_only', message: 'Chief cannot approve.' } })); }
      else { response.writeHead(201); response.end(JSON.stringify({ id: 'record-7', title: JSON.parse(body || '{}').title })); }
    });
    await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolveListen()); });
    cleanup.push(() => new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test server address.');
    const cwd = await directory(); const env = { ...process.env, MUON_API_URL: `http://127.0.0.1:${address.port}`, MUON_API_TOKEN: 'chief-scoped-token' };
    const created = await child(['tasks', 'create', '--file', '-'], env, cwd, '{"title":"Real process"}');
    expect(created.code).toBe(0); expect(created.stderr).toBe(''); expect(JSON.parse(created.stdout)).toEqual({ id: 'record-7', title: 'Real process' });
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/api/tasks', token: 'Bearer chief-scoped-token', body: '{"title":"Real process"}' });
    const denied = await child(['tasks', 'approve', 'MUO-7', '--plan-id', 'p1'], env, cwd);
    expect(denied.code).toBe(1); expect(denied.stdout).toBe(''); expect(JSON.parse(denied.stderr).error.code).toBe('owner_only');
    expect(denied.stderr).not.toContain('chief-scoped-token');
    const help = await child(['--help'], env, cwd); expect(help.code).toBe(0); expect(help.stdout).toContain('Muon — task system REST client');
  }, 15_000);
});
