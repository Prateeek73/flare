import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verifyDashboardForwarding } from '@flare/shared/dashboard-forwarding';
import { dashboardBackend, dashboardConfig } from './dashboard-backend';

const secret = `fdp_${Buffer.alloc(32, 7).toString('base64')}`;
const deployed = {
  VERCEL: '1',
  VERCEL_ENV: 'production',
  FLARE_API_URL: 'https://api.example.test',
  WEB_ORIGIN: 'https://dashboard.example.test',
  FLARE_DASHBOARD_PROXY_SECRET: secret,
};
const request = (headers: Record<string, string> = {}, origin = deployed.WEB_ORIGIN) => ({
  headers: new Headers({ 'x-vercel-forwarded-for': '203.0.113.9', ...headers }),
  nextUrl: { origin },
});
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => vi.unstubAllGlobals());

it.each(['FLARE_API_URL', 'WEB_ORIGIN', 'FLARE_DASHBOARD_PROXY_SECRET'])(
  'requires %s for deployment without making backend requests',
  (name) => {
    const env = { ...deployed, [name]: '' };
    expect(() => dashboardBackend(request(), env)).toThrow(/configuration required/i);
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it.each([
  'http://api.example.test',
  'https://api.example.test/',
  'https://api.example.test/v1',
  'https://user:pass@api.example.test',
  'https://api.example.test?x=1',
  'https://api.example.test#section',
])('rejects a non-exact HTTPS origin: %s', (value) => {
  for (const name of ['FLARE_API_URL', 'WEB_ORIGIN'])
    expect(() => dashboardConfig({ ...deployed, [name]: value })).toThrow(/exact HTTPS origin/);
  expect(fetcher).not.toHaveBeenCalled();
});
it('keeps previews disabled unless explicitly enabled with their own exact configuration', () => {
  expect(() => dashboardBackend(request(), { ...deployed, VERCEL_ENV: 'preview' })).toThrow(
    /preview backend access is disabled/,
  );
  expect(() =>
    dashboardBackend(request(), {
      ...deployed,
      VERCEL_ENV: 'preview',
      FLARE_VERCEL_PREVIEW_BACKEND: 'true',
      WEB_ORIGIN: '',
    }),
  ).toThrow(/WEB_ORIGIN/);
  expect(
    dashboardBackend(request(), {
      ...deployed,
      VERCEL_ENV: 'preview',
      FLARE_VERCEL_PREVIEW_BACKEND: 'true',
    }).mode,
  ).toBe('vercel');
  expect(fetcher).not.toHaveBeenCalled();
});
it('rejects an unexpected deployed host even for GET before using cookies or credentials', () => {
  expect(() =>
    dashboardBackend(request({}, 'https://other-preview.example.test'), deployed),
  ).toThrow(/origin does not match/);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(['', '203.0.113.9, 198.51.100.1', 'not-an-ip', '1.2.3.999', '::1%eth0', '[::1]'])(
  'rejects missing or invalid platform address %s instead of using spoofed alternatives',
  (address) => {
    expect(() =>
      dashboardBackend(
        request({
          'x-vercel-forwarded-for': address,
          'x-flare-client-ip': '198.51.100.2',
          'x-forwarded-for': '198.51.100.3',
        }),
        deployed,
      ),
    ).toThrow(/single Vercel client address/);
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it('binds the final UTF-8 body, headers, method and target while ignoring caller forwarding headers', async () => {
  const backend = dashboardBackend(
    request({ 'x-flare-client-ip': '198.51.100.2', 'x-forwarded-for': '198.51.100.3' }),
    deployed,
  );
  const body = JSON.stringify({ text: 'नमस्ते 世界 🙂' });
  const target = '/v1/emails?filter=a%2Fb&filter=c';
  const response = await backend.fetch(target, {
    method: 'POST',
    body,
    headers: {
      Authorization: 'Bearer final-session',
      'Content-Type': 'application/json',
      'x-org-id': 'final-org',
      'x-environment-id': 'final-env',
      'Idempotency-Key': 'final-key',
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
      'x-forwarded-for': '198.51.100.3',
      'X-Flare-Proxy-Client-IP': '198.51.100.4',
      'x-flare-client-ip': '198.51.100.5',
    },
  });
  expect(await response.json()).toEqual({ ok: true });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe(`${deployed.FLARE_API_URL}${target}`);
  expect(init).toMatchObject({ body, method: 'POST', cache: 'no-store', redirect: 'error' });
  const headers = init!.headers as Record<string, string>;
  expect(headers['x-forwarded-for']).toBeUndefined();
  expect(headers['x-flare-client-ip']).toBeUndefined();
  expect(
    verifyDashboardForwarding(secret, { method: 'POST', target, body, headers }).clientIp,
  ).toBe('203.0.113.9');
  expect(() =>
    verifyDashboardForwarding(secret, { method: 'POST', target, body: `${body} `, headers }),
  ).toThrow();
  expect(backend.secureCookies).toBe(true);
  expect(backend.maxRequestBytes).toBe(4 * 1024 * 1024);
});
it('preserves self-host defaults and the existing opt-in ingress address contract', async () => {
  const req = request(
    { 'x-flare-client-ip': '198.51.100.6', 'x-forwarded-for': '198.51.100.7' },
    'http://localhost:3000',
  );
  await dashboardBackend(req, {}).fetch('/v1/auth/config');
  expect(String(fetcher.mock.calls[0]![0])).toBe('http://localhost:4000/v1/auth/config');
  expect(fetcher.mock.calls[0]![1]!.headers).toEqual({});
  const enabled = dashboardBackend(req, { FLARE_FORWARD_CLIENT_IP: 'true' });
  await enabled.fetch('/v1/auth/config');
  expect(fetcher.mock.calls[1]![1]).toMatchObject({
    headers: { 'x-forwarded-for': '198.51.100.6' },
    redirect: 'error',
  });
  expect(enabled.maxRequestBytes).toBe(40 * 1024 * 1024);
  expect(enabled.secureCookies).toBe(false);
});
it('rejects declared oversized responses before reading their payload', async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ cancel });
  fetcher.mockResolvedValueOnce(
    new Response(stream, { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }),
  );
  await expect(
    dashboardBackend(request(), deployed).fetch('/v1/inbound/message/raw'),
  ).rejects.toMatchObject({ status: 413 });
  expect(cancel).toHaveBeenCalledOnce();
});
it('bounds responses without Content-Length and cancels oversized chunked bodies', async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4 * 1024 * 1024));
      controller.enqueue(new Uint8Array(1));
    },
    cancel,
  });
  fetcher.mockResolvedValueOnce(new Response(stream));
  await expect(
    dashboardBackend(request(), deployed).fetch('/v1/inbound/message/raw'),
  ).rejects.toMatchObject({ status: 413 });
  expect(cancel).toHaveBeenCalledOnce();
});

it('signs the Content-Type that fetch would insert for a string body', async () => {
  await dashboardBackend(request(), deployed).fetch('/v1/test', {
    method: 'POST',
    body: 'Hello 世界',
  });
  const init = fetcher.mock.calls[0]![1]!;
  const headers = init.headers as Record<string, string>;
  expect(headers['Content-Type']).toBe('text/plain;charset=UTF-8');
  expect(
    verifyDashboardForwarding(secret, {
      method: 'POST',
      target: '/v1/test',
      body: 'Hello 世界',
      headers,
    }).clientIp,
  ).toBe('203.0.113.9');
});
it.each([
  { status: 204, method: 'POST' },
  { status: 200, method: 'HEAD' },
])('preserves a null response body for $method with status $status', async ({ status, method }) => {
  fetcher.mockResolvedValueOnce(new Response(null, { status }));
  const response = await dashboardBackend(request(), deployed).fetch('/v1/test', { method });
  expect(response.status).toBe(status);
  expect(response.body).toBeNull();
});
it('keeps the explicit size error if canceling an oversized response fails', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
    },
    cancel() {
      throw new Error('upstream cancellation failed');
    },
  });
  fetcher.mockResolvedValueOnce(new Response(stream));
  await expect(dashboardBackend(request(), deployed).fetch('/v1/test')).rejects.toMatchObject({
    status: 413,
  });
});
it('rejects response read failures instead of returning partial backend JSON', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"partial":'));
      controller.error(new Error('upstream read failed'));
    },
  });
  fetcher.mockResolvedValueOnce(new Response(stream));
  await expect(dashboardBackend(request(), deployed).fetch('/v1/test')).rejects.toThrow(
    'upstream read failed',
  );
});
it('self-hosted: accepts a write from the host it was reached on, and from no other site', () => {
  const req = {
    headers: new Headers({ 'x-forwarded-host': 'flare.example.org', 'x-forwarded-proto': 'http' }),
    nextUrl: { origin: 'http://10.0.0.5:3000' },
  };
  const backend = dashboardBackend(req, { WEB_ORIGIN: 'https://dashboard.example.test' });
  expect(backend.acceptsOrigin('http://flare.example.org')).toBe(true);
  expect(backend.acceptsOrigin('https://dashboard.example.test')).toBe(true);
  for (const origin of [
    'https://evil.example.test',
    'null',
    '',
    'http://flare.example.org/x',
    'ftp://flare.example.org',
  ])
    expect(backend.acceptsOrigin(origin)).toBe(false);
  expect(backend.acceptsOrigin(null)).toBe(false);
  expect(backend.secureCookies).toBe(false);
});
it('self-hosted: secure cookies on its https origin and behind an https proxy', () => {
  const at = (headers: Record<string, string>, origin: string) => ({
    headers: new Headers(headers),
    nextUrl: { origin },
  });
  const env = { WEB_ORIGIN: 'https://dashboard.example.test' };
  expect(
    dashboardBackend(at({ host: 'dashboard.example.test' }, 'http://dashboard.example.test'), env)
      .secureCookies,
  ).toBe(true);
  expect(
    dashboardBackend(
      at({ host: 'other.example.org', 'x-forwarded-proto': 'https' }, 'http://other.example.org'),
      env,
    ).secureCookies,
  ).toBe(true);
  expect(
    dashboardBackend(at({ host: 'other.example.org' }, 'http://other.example.org'), env)
      .secureCookies,
  ).toBe(false);
});
it('deployed: a write is accepted from the exact web origin only', () => {
  const backend = dashboardBackend(request(), deployed);
  expect(backend.acceptsOrigin(deployed.WEB_ORIGIN)).toBe(true);
  expect(backend.acceptsOrigin('https://other.example.test')).toBe(false);
});
