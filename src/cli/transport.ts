import { EnvHttpProxyAgent, ProxyAgent, type Dispatcher } from 'undici';
import { ApiError } from '../shared/api-client';

export interface CliTransport { fetch: typeof globalThis.fetch; close: () => Promise<void> }

/** Node's fetch does not automatically honor Claude's sandbox HTTP proxy. Keep
 * proxy selection confined to the CLI; browser requests remain same-origin. */
export function createCliTransport(env: NodeJS.ProcessEnv): CliTransport {
  const httpProxy = env.http_proxy ?? env.HTTP_PROXY ?? '';
  const httpsProxy = env.https_proxy ?? env.HTTPS_PROXY ?? '';
  const forced = env.MUON_CLI_SANDBOX_PROXY === '1';
  if (!httpProxy && !httpsProxy && !forced) return { fetch: globalThis.fetch, close: async () => {} };
  if (forced && !httpProxy && !httpsProxy) throw new ApiError('The chief CLI requires its sandbox HTTP proxy, but none was provided. Restart the chief session with sandbox networking enabled.', 0, 'sandbox_proxy_required');
  let dispatcher: Dispatcher;
  try {
    if (forced) {
      // The sandbox owns all network access, including loopback. Inherited
      // NO_PROXY must never select a direct connection for the chief.
      const secureApi = (env.MUON_API_URL ?? '').startsWith('https:');
      dispatcher = new ProxyAgent(secureApi ? httpsProxy || httpProxy : httpProxy || httpsProxy);
    } else dispatcher = new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy: env.no_proxy ?? env.NO_PROXY ?? '' });
  } catch { throw new ApiError('The HTTP proxy configuration is invalid. Check the proxy environment variables.', 0, 'invalid_proxy'); }
  return {
    fetch: (input, init) => globalThis.fetch(input, { ...init, dispatcher } as RequestInit),
    close: async () => { await dispatcher.close(); },
  };
}
