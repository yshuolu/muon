import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Scope } from '../shared/types';
import { DomainError, type ChiefCommandGateway, type ChiefCommandSession } from './ports';

interface Grant { scope: Scope; expiresAt: number; taskIds: Set<string> }
const sameScope = (a: Scope, b: Scope) => a.workspaceId === b.workspaceId && a.projectId === b.projectId && a.userId === b.userId;

/** Local-owner access stays on the trusted loopback interface. Agent credentials are
 * short lived and carry narrower authority; they never become owner credentials. */
export class LocalChiefCommands implements ChiefCommandGateway {
  private grants = new Map<string, Grant>();
  private admitted = new WeakMap<Request, Grant>();
  private readonly cliPath: string;
  constructor(private options: { apiUrl: string; scope: Scope; cliPath?: string; lifetimeMs?: number }) {
    const url = new URL(options.apiUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Local chief commands require a loopback API origin.');
    this.cliPath = options.cliPath ?? fileURLToPath(new URL('../../bin/muon.mjs', import.meta.url));
  }

  async open(scope: Scope, signal: AbortSignal): Promise<ChiefCommandSession> {
    if (!sameScope(scope, this.options.scope)) throw new DomainError('Chief session scope does not match this workspace.', 403);
    if (signal.aborted) throw new Error('Chief request canceled.');
    const token = randomBytes(32).toString('hex');
    const grant: Grant = { scope: { ...scope }, expiresAt: Date.now() + (this.options.lifetimeMs ?? 30 * 60_000), taskIds: new Set() };
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'muon-chief-cli-')));
    const launcher = join(directory, 'muon');
    // Freeze the endpoint and credential inside a read-only per-run launcher. Shell
    // environment overrides cannot turn this allowed command into an owner client.
    const content = `#!${process.execPath}\nprocess.env.MUON_API_URL = ${JSON.stringify(this.options.apiUrl)};\nprocess.env.MUON_API_TOKEN = ${JSON.stringify(token)};\nawait import(${JSON.stringify(pathToFileURL(this.cliPath).href)});\n`;
    await writeFile(launcher, content, { mode: 0o500 });
    await chmod(directory, 0o500);
    const revoke = () => this.grants.delete(token);
    signal.addEventListener('abort', revoke, { once: true });
    this.grants.set(token, grant);
    if (signal.aborted) revoke();
    let closed = false;
    return {
      cli: { command: `'${launcher.replaceAll("'", "'\\''")}'`, apiUrl: this.options.apiUrl, token },
      taskIds: () => [...grant.taskIds],
      close: async () => {
        if (closed) return; closed = true;
        revoke(); signal.removeEventListener('abort', revoke);
        await chmod(directory, 0o700);
        await rm(directory, { recursive: true, force: true });
      },
    };
  }

  private grant(request: Request): Grant | undefined {
    const authorization = request.headers.get('authorization');
    if (!authorization) return undefined;
    const token = /^Bearer ([a-f0-9]{64})$/.exec(authorization)?.[1];
    const grant = token ? this.grants.get(token) : undefined;
    if (!grant || grant.expiresAt <= Date.now() || !sameScope(grant.scope, this.options.scope)) {
      if (token) this.grants.delete(token);
      throw new DomainError('The agent credential is invalid or expired.', 401);
    }
    return grant;
  }

  authorize(request: Request) {
    const grant = this.grant(request);
    if (!grant) return; // The existing local UI/owner CLI trust boundary.
    const path = new URL(request.url).pathname;
    const method = request.method;
    const read = ['GET', 'HEAD'].includes(method) && /^\/api\/(health|state|project|settings|runtime|tasks|attention|chief\/messages|artifacts)(\/|$)/.test(path);
    const taskWrite = method === 'POST' && path === '/api/tasks'
      || method === 'PATCH' && /^\/api\/tasks\/[^/]+$/.test(path)
      || method === 'POST' && /^\/api\/tasks\/[^/]+\/(cancel|retry)$/.test(path);
    if (!read && !taskWrite) throw new DomainError('This action requires the workspace owner. The chief cannot approve RFCs, submit owner reviews, change settings, or clear attention.', 403);
    this.admitted.set(request, grant);
  }

  async observe(request: Request, response: Response) {
    if (!response.ok || ['GET', 'HEAD'].includes(request.method)) return;
    // A write admitted before cancellation/expiry may already have committed.
    // Journal that result without re-authorizing a later request.
    const grant = this.admitted.get(request);
    if (!grant || !new URL(request.url).pathname.startsWith('/api/tasks')) return;
    const result = await response.clone().json() as { id?: unknown; workspaceId?: unknown; projectId?: unknown };
    if (typeof result.id === 'string' && result.workspaceId === grant.scope.workspaceId && result.projectId === grant.scope.projectId) grant.taskIds.add(result.id);
  }
}
