import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalChiefCommands } from './local-chief-commands';
import type { ChiefCommandSession } from './ports';

const scope = { accountId: 'local-workspace', workspaceId: 'local-project', userId: 'owner' };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function session(commands: LocalChiefCommands, signal = new AbortController().signal) {
  const result = await commands.open(scope, signal); cleanups.push(() => result.close()); return result;
}
function request(grant: ChiefCommandSession, path: string, method = 'GET') {
  return new Request(`http://127.0.0.1:4310/api/workspaces/${scope.workspaceId}/${path}`, { method, headers: { authorization: `Bearer ${grant.cli.token}` } });
}
const taskResponse = (id: string, overrides = {}) => Response.json({ id, accountId: scope.accountId, workspaceId: scope.workspaceId, ...overrides });

describe('Local chief CLI capabilities', () => {
  it('allows task operations while keeping owner review, settings and attention actions restricted', async () => {
    const commands = new LocalChiefCommands({ scope, apiUrl: 'http://127.0.0.1:4310' }); const grant = await session(commands);
    for (const [path, method] of [
      ['state', 'GET'], ['workspace', 'GET'], ['settings', 'GET'], ['runtime', 'GET'], ['tasks', 'GET'],
      ['tasks/MUO-1/evidence', 'GET'], ['attention', 'GET'], ['chief/messages', 'GET'], ['artifacts/file', 'GET'],
      ['tasks/MUO-1/plan-discussion', 'GET'], ['tasks/MUO-1/comments', 'GET'],
      ['tasks', 'POST'], ['tasks/MUO-1', 'PATCH'], ['tasks/MUO-1/cancel', 'POST'], ['tasks/MUO-1/retry', 'POST'],
    ]) expect(() => commands.authorize(request(grant, path, method))).not.toThrow();
    for (const [path, method] of [
      ['tasks/MUO-1/approve', 'POST'], ['tasks/MUO-1/request-changes', 'POST'], ['settings', 'PATCH'],
      ['tasks/MUO-1/plan-discussion', 'POST'], ['tasks/MUO-1/comments', 'POST'], ['tasks/MUO-1/comments/retry', 'POST'],
      ['attention/notice/read', 'POST'], ['chief/messages', 'POST'], ['tasks/MUO-1', 'DELETE'],
      ['unknown', 'GET'],
    ]) expect(() => commands.authorize(request(grant, path, method))).toThrow('workspace owner');
    for (const path of ['/api/tasks', '/api/state', '/api/workspaces/other-workspace/tasks', '/api/workspaces']) {
      expect(() => commands.authorize(new Request(`http://127.0.0.1:4310${path}`, { headers: { authorization: `Bearer ${grant.cli.token}` } }))).toThrow('own workspace');
    }
    const byIdentifier = new LocalChiefCommands({ scope, apiUrl: 'http://127.0.0.1:4310', resolveWorkspaceId: reference => reference.toLowerCase() === 'muo' ? scope.workspaceId : undefined });
    const identified = await session(byIdentifier);
    expect(() => byIdentifier.authorize(new Request('http://127.0.0.1:4310/api/workspaces/MUO/tasks', { headers: { authorization: `Bearer ${identified.cli.token}` } }))).not.toThrow();
    expect(() => byIdentifier.authorize(new Request('http://127.0.0.1:4310/api/workspaces/OTHER/tasks', { headers: { authorization: `Bearer ${identified.cli.token}` } }))).toThrow('own workspace');
    expect(() => commands.authorize(new Request('http://127.0.0.1:4310/api/settings', { method: 'PATCH' }))).not.toThrow();
    expect(() => commands.authorize(new Request('http://127.0.0.1:4310/api/state', { headers: { authorization: 'Bearer invalid' } }))).toThrow('invalid or expired');
  });

  it('rejects mismatched scope and revokes credentials on abort, expiration, and close', async () => {
    const commands = new LocalChiefCommands({ scope, apiUrl: 'http://127.0.0.1:4310', lifetimeMs: 1_000 });
    await expect(commands.open({ ...scope, accountId: 'other-workspace' }, new AbortController().signal)).rejects.toThrow('scope');
    await expect(commands.open({ ...scope, userId: 'someone-else' }, new AbortController().signal)).rejects.toThrow('scope');
    const sibling = await session(commands); await sibling.close();
    const other = await commands.open({ ...scope, workspaceId: 'other-workspace' }, new AbortController().signal); cleanups.push(() => other.close());
    expect(() => commands.authorize(new Request('http://127.0.0.1:4310/api/workspaces/other-workspace/tasks', { headers: { authorization: `Bearer ${other.cli.token}` } }))).not.toThrow();
    expect(() => commands.authorize(request(other, 'tasks'))).toThrow('own workspace');
    const aborted = new AbortController(); aborted.abort();
    await expect(commands.open(scope, aborted.signal)).rejects.toThrow('canceled');
    const abort = new AbortController(); const live = await session(commands, abort.signal);
    expect(() => commands.authorize(request(live, 'state'))).not.toThrow(); abort.abort();
    expect(() => commands.authorize(request(live, 'state'))).toThrow('invalid or expired');
    const closed = await session(commands); await closed.close(); await closed.close();
    expect(() => commands.authorize(request(closed, 'state'))).toThrow('invalid or expired');
    const expired = await session(commands); const originalNow = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(originalNow + 2_000);
    expect(() => commands.authorize(request(expired, 'state'))).toThrow('invalid or expired');
  });

  it('journals only successful task mutations from matching scoped responses and deduplicates IDs', async () => {
    const commands = new LocalChiefCommands({ scope, apiUrl: 'http://127.0.0.1:4310' }); const grant = await session(commands);
    const observed = async (path: string, method: string, response: Response) => {
      const admitted = request(grant, path, method); commands.authorize(admitted); await commands.observe(admitted, response);
    };
    await observed('tasks', 'POST', taskResponse('task-1'));
    await observed('tasks/task-1', 'PATCH', taskResponse('task-1'));
    await observed('tasks/task-2', 'PATCH', taskResponse('task-2'));
    await observed('tasks/task-3', 'GET', taskResponse('task-3'));
    await observed('tasks', 'POST', Response.json({ error: 'Rejected' }, { status: 400 }));
    await observed('tasks', 'POST', taskResponse('foreign', { workspaceId: 'other-workspace' }));
    await observed('tasks', 'POST', taskResponse('foreign-workspace', { accountId: 'other-workspace' }));
    await observed('tasks', 'POST', Response.json({ id: 'unscoped' }));
    await commands.observe(request(grant, 'tasks', 'POST'), taskResponse('not-admitted'));
    expect(grant.taskIds()).toEqual(['task-1', 'task-2']);
  });

  it('retains the result of a previously admitted write after revocation while refusing new work', async () => {
    const commands = new LocalChiefCommands({ scope, apiUrl: 'http://127.0.0.1:4310' }); const abort = new AbortController(); const grant = await session(commands, abort.signal);
    const admitted = request(grant, 'tasks', 'POST'); commands.authorize(admitted);
    abort.abort();
    await commands.observe(admitted, taskResponse('committed-before-cancel'));
    expect(grant.taskIds()).toEqual(['committed-before-cancel']);
    expect(() => commands.authorize(request(grant, 'tasks', 'POST'))).toThrow('invalid or expired');
  });

  it('executes the read-only wrapper from another cwd and pins credentials despite caller environment overrides', async () => {
    let observed: { path?: string; token?: string; body: string } | undefined;
    const server = createServer(async (incoming, outgoing) => {
      let body = ''; for await (const chunk of incoming) body += chunk;
      observed = { path: incoming.url, token: incoming.headers.authorization, body };
      outgoing.setHeader('Content-Type', 'application/json'); outgoing.end(JSON.stringify({ id: 'saved-task' }));
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address.');
    const commands = new LocalChiefCommands({ scope, apiUrl: `http://127.0.0.1:${address.port}` }); const grant = await session(commands);
    const launcher = grant.cli.command.slice(1, -1); expect((await stat(launcher)).mode & 0o777).toBe(0o500);
    const cwd = await mkdtemp(join(tmpdir(), 'muon-chief-cwd-')); cleanups.push(() => rm(cwd, { force: true, recursive: true }));
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(launcher, ['tasks', 'create', '--file', '-'], { cwd, env: { ...process.env, MUON_API_URL: 'http://127.0.0.1:1', MUON_API_TOKEN: 'owner-override-attempt', MUON_WORKSPACE: 'other-workspace' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); child.stdin.end('{"title":"Created through wrapper"}');
    });
    expect(result.code).toBe(0); expect(result.stderr).toBe(''); expect(JSON.parse(result.stdout)).toEqual({ id: 'saved-task' });
    expect(observed).toEqual({ path: `/api/workspaces/${scope.workspaceId}/tasks`, token: `Bearer ${grant.cli.token}`, body: '{"title":"Created through wrapper"}' });
    expect(result.stdout).not.toContain(grant.cli.token); expect(result.stderr).not.toContain(grant.cli.token);
    await grant.close(); await expect(stat(launcher)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);
});
