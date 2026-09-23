/** The common HTTP boundary for browser, command-line, and future remote clients. */
export class ApiError extends Error {
  constructor(message: string, public readonly status = 0, public readonly code = 'request_failed', public readonly details?: unknown) {
    super(message); this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  /** Server origin, optionally ending in /api. /api uses the browser's current origin. */
  baseUrl?: string;
  token?: string;
  /** Project ID or identifier; project-scoped paths are sent under /api/projects/<project>. */
  project?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** Paths that address the workspace rather than one project. */
export function isWorkspaceApiPath(suffix: string): boolean {
  return suffix === '' || /^\/health(\?|$)/.test(suffix) || /^\/projects(\/|\?|$)/.test(suffix);
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly token?: string;
  private readonly timeoutMs: number;
  /** The project addressed by project-scoped paths; the server's default project when unset. */
  project?: string;

  constructor(options: ApiClientOptions = {}) {
    this.project = options.project || undefined;
    const base = options.baseUrl ?? '/api';
    if (base === '/api' || base === '') this.baseUrl = '/api';
    else {
      let parsed: URL;
      try { parsed = new URL(base); } catch { throw new ApiError('MUON_API_URL must be an HTTP(S) server origin.', 0, 'invalid_api_url'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/', '/api', '/api/'].includes(parsed.pathname)) {
        throw new ApiError('MUON_API_URL must be an HTTP(S) server origin without credentials, query, or fragment.', 0, 'invalid_api_url');
      }
      this.baseUrl = `${parsed.origin}/api`;
    }
    // Browser fetch is a Web API method: invoking it with ApiClient as `this`
    // throws an illegal-invocation error. Preserve the platform receiver.
    this.fetcher = (options.fetch ?? globalThis.fetch).bind(globalThis);
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private url(path: string): string {
    if (!path.startsWith('/') || path.startsWith('//') || /[\\#\r\n]/.test(path)) throw new ApiError('API paths must be relative paths within /api.', 0, 'invalid_api_path');
    let decoded: string;
    try { decoded = decodeURIComponent(path.split('?')[0]); } catch { throw new ApiError('Invalid API path encoding.', 0, 'invalid_api_path'); }
    if (decoded.split('/').some(segment => segment === '..' || segment === '.') || decoded.includes('\\')) throw new ApiError('API paths cannot traverse directories.', 0, 'invalid_api_path');
    const suffix = path === '/api' ? '' : path.startsWith('/api/') ? path.slice(4) : path;
    if (this.project && !isWorkspaceApiPath(suffix)) return `${this.baseUrl}/projects/${encodeURIComponent(this.project)}${suffix}`;
    return this.baseUrl + suffix;
  }

  private async response(path: string, method: string, body?: unknown): Promise<Response> {
    const url = this.url(path);
    const headers = new Headers({ Accept: 'application/json' });
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    const multipart = body instanceof FormData;
    if (!multipart && (body !== undefined || !['GET', 'HEAD'].includes(method.toUpperCase()))) headers.set('Content-Type', 'application/json');
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method, headers, body: multipart ? body : body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
      throw new ApiError(timedOut ? 'Muon API request timed out.' : 'Unable to reach the Muon API. Start the server and check MUON_API_URL.', 0, timedOut ? 'request_timeout' : 'connection_failed');
    }
    if (!response.ok) {
      const data = await response.json().catch(() => null) as { error?: string | { message?: string; code?: string; details?: unknown }; message?: string } | null;
      const error = data?.error;
      throw new ApiError(typeof error === 'string' ? error : error?.message ?? data?.message ?? `Request failed (${response.status}).`, response.status,
        typeof error === 'object' ? error?.code ?? 'request_failed' : 'request_failed', typeof error === 'object' ? error?.details : undefined);
    }
    return response;
  }

  async request<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await this.response(path, method, body);
    if (response.status === 204 || method.toUpperCase() === 'HEAD') return null as T;
    try { return await response.json() as T; }
    catch { throw new ApiError('Muon API returned an invalid JSON response.', response.status, 'invalid_response'); }
  }

  async download(path: string): Promise<{ data: Uint8Array; contentType: string }> {
    const response = await this.response(path, 'GET');
    return { data: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
  }
}
