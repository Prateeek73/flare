import { isIP } from 'node:net';
import {
  signDashboardForwarding,
  validateDashboardProxySecret,
} from '@flare/shared/dashboard-forwarding';
import { clientAddressHeaders } from './client-address';

export class DashboardProxyError extends Error {
  constructor(
    message: string,
    readonly status = 503,
  ) {
    super(message);
  }
}

type DashboardConfig =
  | { mode: 'self-hosted'; apiOrigin: string; webOrigin?: string }
  | { mode: 'vercel'; apiOrigin: string; webOrigin: string; proxySecret: string };
type DashboardEnvironment = Readonly<Record<string, string | undefined>>;

function exactHttpsOrigin(value: string | undefined, name: string) {
  try {
    const url = new URL(value ?? '');
    if (url.protocol === 'https:' && url.origin === value && !url.username && !url.password)
      return value!;
  } catch {
    /* Invalid deployment configuration is reported without its value. */
  }
  throw new DashboardProxyError(
    `Dashboard configuration required: ${name} must be an exact HTTPS origin.`,
  );
}

export function dashboardConfig(env: DashboardEnvironment = process.env): DashboardConfig {
  if (env.VERCEL !== '1')
    return {
      mode: 'self-hosted',
      apiOrigin: env.FLARE_API_URL ?? 'http://localhost:4000',
      webOrigin: env.WEB_ORIGIN,
    };
  if (env.VERCEL_ENV === 'preview' && env.FLARE_VERCEL_PREVIEW_BACKEND !== 'true')
    throw new DashboardProxyError(
      'Dashboard configuration required: preview backend access is disabled.',
    );
  const apiOrigin = exactHttpsOrigin(env.FLARE_API_URL, 'FLARE_API_URL');
  const webOrigin = exactHttpsOrigin(env.WEB_ORIGIN, 'WEB_ORIGIN');
  try {
    validateDashboardProxySecret(env.FLARE_DASHBOARD_PROXY_SECRET ?? '');
  } catch {
    throw new DashboardProxyError(
      'Dashboard configuration required: a valid FLARE_DASHBOARD_PROXY_SECRET is required.',
    );
  }
  return { mode: 'vercel', apiOrigin, webOrigin, proxySecret: env.FLARE_DASHBOARD_PROXY_SECRET! };
}

type DashboardRequest = {
  headers: { get(name: string): string | null };
  nextUrl: { origin: string };
};
type BackendRequest = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

async function boundedResponse(response: Response, limit: number) {
  const tooLarge = () =>
    new DashboardProxyError('This response exceeds the dashboard transfer limit.', 413);
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function dashboardBackend(req: DashboardRequest, env: DashboardEnvironment = process.env) {
  const config = dashboardConfig(env);
  let clientIp: string | undefined;
  if (config.mode === 'vercel') {
    if (req.nextUrl.origin !== config.webOrigin)
      throw new DashboardProxyError('Request origin does not match this dashboard', 403);
    // Vercel overwrites this header. Never trust caller XFF or self-host ingress headers here.
    const address = req.headers.get('x-vercel-forwarded-for');
    if (!address || address.length > 45 || address.includes('%') || !isIP(address))
      throw new DashboardProxyError(
        'Dashboard configuration required: a single Vercel client address is required.',
      );
    clientIp = address;
  }
  // Self-hosted, the dashboard answers on whatever address reached it (its configured
  // origin, a platform URL, a port forward). A write is accepted from a page of that same
  // host: a cross-site page cannot make the browser send another site's Host.
  const first = (name: string) => req.headers.get(name)?.split(',')[0]?.trim().toLowerCase() ?? '';
  const reached = new URL(req.nextUrl.origin);
  const host = first('x-forwarded-host') || first('host') || reached.host;
  const scheme = first('x-forwarded-proto') || reached.protocol.slice(0, -1);
  const atWebOrigin = !!config.webOrigin && new URL(config.webOrigin).host === host;
  return {
    mode: config.mode,
    expectedOrigin: config.webOrigin ?? req.nextUrl.origin,
    acceptsOrigin(origin: string | null) {
      if (!origin) return false;
      if (origin === (config.webOrigin ?? req.nextUrl.origin)) return true;
      if (config.mode === 'vercel') return false;
      try {
        const url = new URL(origin);
        return url.origin === origin && /^https?:$/.test(url.protocol) && url.host === host;
      } catch {
        return false;
      }
    },
    secureCookies:
      config.mode === 'vercel' ||
      (atWebOrigin ? config.webOrigin!.startsWith('https:') : scheme === 'https'),
    maxRequestBytes: (config.mode === 'vercel' ? 4 : 40) * 1024 * 1024,
    async fetch(target: string, init: BackendRequest = {}) {
      if (!target.startsWith('/v1/') || target.includes('#') || /[\r\n]/.test(target))
        throw new DashboardProxyError('Invalid backend request path', 400);
      const url = new URL(`${config.apiOrigin}${target}`);
      const method = init.method ?? 'GET';
      const headers: Record<string, string> = { ...init.headers };
      // Fetch supplies this for string bodies; make it explicit before signing.
      if (
        init.body !== undefined &&
        !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')
      )
        headers['Content-Type'] = 'text/plain;charset=UTF-8';
      if (config.mode === 'vercel') {
        for (const name of Object.keys(headers))
          if (/^(?:x-flare-proxy-|x-flare-client-ip$|x-forwarded-for$|forwarded$)/i.test(name))
            delete headers[name];
        Object.assign(
          headers,
          signDashboardForwarding(
            config.proxySecret,
            {
              method,
              target: `${url.pathname}${url.search}`,
              body: init.body,
              headers,
            },
            clientIp!,
          ),
        );
      } else
        Object.assign(
          headers,
          clientAddressHeaders(req.headers, env.FLARE_FORWARD_CLIENT_IP === 'true'),
        );
      const response = await fetch(url, {
        method,
        headers,
        body: init.body,
        signal: init.signal,
        cache: 'no-store',
        redirect: 'error',
      });
      // A proof failure authenticates the proxy, not the user's session. Keep it
      // retryable at the dashboard boundary instead of turning it into logout.
      if (
        response.status === 401 &&
        response.headers.get('x-flare-proxy-error') === 'invalid-proof'
      ) {
        await response.body?.cancel().catch(() => undefined);
        return Response.json(
          { message: 'Flare API is unavailable. Please retry.' },
          {
            status: 503,
            headers: {
              'Retry-After': '1',
              'Cache-Control': 'no-store',
              'x-flare-proxy-error': 'invalid-proof',
            },
          },
        );
      }
      return config.mode === 'vercel' ? boundedResponse(response, 4 * 1024 * 1024) : response;
    },
  };
}
