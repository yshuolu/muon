import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Scope } from '../shared/types';
import { DomainError, type ChiefCommandGateway, type ChiefCommandSession, type CommandAccess } from './ports';

interface Grant { scope: Scope; access: CommandAccess; expiresAt: number; taskIds: Set<string> }
interface Workspace { accountId: string; userId: string }
const sameAccount = (a: Workspace, b: Workspace) => a.accountId === b.accountId && a.userId === b.userId;

/** Splits `/api/workspaces/<workspace>/<rest>` into its workspace segment and the workspace-relative API path. */
export function workspaceApiPath(pathname: string): { workspace: string; path: string } | undefined {
  const match = /^\/api\/workspaces\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!match) return undefined;
  try { return { workspace: decodeURIComponent(match[1]), path: `/api${match[2] ?? ''}` }; }
  catch { return undefined; }
}

/** Local-owner access stays on the trusted loopback interface. Agent credentials are
 * short lived, bound to one workspace, and carry narrower authority; they never become owner credentials. */
export class LocalChiefCommands implements ChiefCommandGateway {
  private grants = new Map<string, Grant>();
  private admitted = new WeakMap<Request, Grant>();
  private readonly cliPath: string;
  private readonly workspace: Workspace;
  constructor(private options: { apiUrl: string; scope: Workspace; cliPath?: string; lifetimeMs?: number; resolveWorkspaceId?: (reference: string) => string | undefined }) {
    const url = new URL(options.apiUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Local chief commands require a loopback API origin.');
    this.cliPath = options.cliPath ?? fileURLToPath(new URL('../../bin/muon.mjs', import.meta.url));
    this.workspace = { accountId: options.scope.accountId, userId: options.scope.userId };
  }

  /**
   * Issues a CLI session for one agent run. `chief` access covers task reads, creation, edits, cancellation, and
   * recovery; `owner` access, used by planning chats the owner drives directly, covers every workspace action the
   * owner has except managing planning chats and sending chief requests.
   */
  async open(scope: Scope, signal: AbortSignal, access: CommandAccess = 'chief'): Promise<ChiefCommandSession> {
    if (!sameAccount(scope, this.workspace)) throw new DomainError('Chief session scope does not match this workspace.', 403);
    if (signal.aborted) throw new Error('Chief request canceled.');
    const token = randomBytes(32).toString('hex');
    const grant: Grant = { scope: { ...scope }, access, expiresAt: Date.now() + (this.options.lifetimeMs ?? 30 * 60_000), taskIds: new Set() };
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'muon-chief-cli-')));
    const launcher = join(directory, 'muon');
    // Freeze the endpoint, credential, and workspace inside a read-only per-run launcher. Shell
    // environment overrides cannot turn this allowed command into an owner client or retarget it.
    const content = `#!${process.execPath}\nprocess.env.MUON_API_URL = ${JSON.stringify(this.options.apiUrl)};\nprocess.env.MUON_API_TOKEN = ${JSON.stringify(token)};\nprocess.env.MUON_WORKSPACE = ${JSON.stringify(scope.workspaceId)};\nawait import(${JSON.stringify(pathToFileURL(this.cliPath).href)});\n`;
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
    if (!grant || grant.expiresAt <= Date.now() || !sameAccount(grant.scope, this.workspace)) {
      if (token) this.grants.delete(token);
      throw new DomainError('The agent credential is invalid or expired.', 401);
    }
    return grant;
  }

  private grantedWorkspace(grant: Grant, pathname: string): string | undefined {
    const target = workspaceApiPath(pathname);
    if (!target) return undefined;
    const workspaceId = target.workspace === grant.scope.workspaceId ? target.workspace : this.options.resolveWorkspaceId?.(target.workspace);
    return workspaceId === grant.scope.workspaceId ? target.path : undefined;
  }

  authorize(request: Request) {
    const grant = this.grant(request);
    if (!grant) return; // The existing local UI/owner CLI trust boundary.
    const path = this.grantedWorkspace(grant, new URL(request.url).pathname);
    if (!path) throw new DomainError('The chief can only act on its own workspace through /api/workspaces/<workspace>/… routes.', 403);
    const method = request.method;
    const read = ['GET', 'HEAD'].includes(method) && /^\/api\/(health|state|workspace|settings|runtime|tasks|attention|chief\/messages|artifacts|assets)(\/|$)/.test(path);
    if (grant.access === 'owner') {
      // The owner's own chat acts with the owner's authority, but never on other chats or the chief.
      const ownerWrite = /^\/api\/(tasks|attention|settings|assets)(\/|$)/.test(path);
      if (!read && !ownerWrite) throw new DomainError('A planning chat cannot manage planning chats or send chief requests.', 403);
    } else {
      const taskWrite = method === 'POST' && path === '/api/tasks'
        || method === 'PATCH' && /^\/api\/tasks\/[^/]+$/.test(path)
        || method === 'POST' && /^\/api\/tasks\/[^/]+\/(cancel|retry)$/.test(path);
      if (!read && !taskWrite) throw new DomainError('This action requires the workspace owner. The chief cannot approve RFCs, submit owner reviews or task follow-ups, change settings, or clear attention.', 403);
    }
    this.admitted.set(request, grant);
  }

  async observe(request: Request, response: Response) {
    if (!response.ok || ['GET', 'HEAD'].includes(request.method)) return;
    // A write admitted before cancellation/expiry may already have committed.
    // Journal that result without re-authorizing a later request.
    const grant = this.admitted.get(request);
    if (!grant || !this.grantedWorkspace(grant, new URL(request.url).pathname)?.startsWith('/api/tasks')) return;
    const result = await response.clone().json() as { id?: unknown; accountId?: unknown; workspaceId?: unknown };
    if (typeof result.id === 'string' && result.accountId === grant.scope.accountId && result.workspaceId === grant.scope.workspaceId) grant.taskIds.add(result.id);
  }
}
