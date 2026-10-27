import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { dashboardBackend, DashboardProxyError } from '../../../lib/dashboard-backend';
import { isPrivateDashboardPath } from '../../../lib/private-paths';
export const runtime = 'nodejs';
const names = { token: 'flare_session', org: 'flare_org', env: 'flare_environment' };
type SessionResponse = {
  token: string;
  organizations: { id: string; environments: { id: string }[] }[];
};
const options = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 43200,
};
async function handler(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (isPrivateDashboardPath(['api', ...path]))
    return NextResponse.json({ message: 'Not found' }, { status: 404 });
  if (path.some((p) => !p || p === '.' || p === '..' || p.includes('/') || p.includes('\\')))
    return NextResponse.json({ message: 'Invalid API path' }, { status: 400 });
  let backend: ReturnType<typeof dashboardBackend>;
  try {
    backend = dashboardBackend(req);
  } catch (error) {
    return NextResponse.json(
      {
        message:
          error instanceof DashboardProxyError
            ? error.message
            : 'Dashboard configuration required.',
      },
      { status: error instanceof DashboardProxyError ? error.status : 503 },
    );
  }
  const cookieOptions = { ...options, secure: backend.secureCookies };
  if (!['GET', 'HEAD'].includes(req.method)) {
    if (!backend.acceptsOrigin(req.headers.get('origin')))
      return NextResponse.json(
        { message: 'Request origin does not match this dashboard' },
        { status: 403 },
      );
  }
  const jar = await cookies();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const token = jar.get(names.token)?.value;
  if (token) headers.Authorization = `Bearer ${token}`;
  const org = jar.get(names.org)?.value,
    env = jar.get(names.env)?.value;
  if (org) headers['x-org-id'] = org;
  if (env) headers['x-environment-id'] = env;
  const joined = path.join('/');
  const publicRoute =
    ['auth/config', 'auth/login', 'auth/exchange', 'auth/accept-invite'].includes(joined) ||
    (path.length === 2 && path[0] === 'preferences' && ['GET', 'PATCH'].includes(req.method));
  if (!publicRoute && !token)
    return NextResponse.json({ message: 'Sign in to continue' }, { status: 401 });
  let body: string | undefined;
  if (!['GET', 'HEAD'].includes(req.method)) {
    body = await req.text();
    if (Buffer.byteLength(body) > backend.maxRequestBytes)
      return NextResponse.json(
        { message: 'This request exceeds the dashboard transfer limit.' },
        { status: 413 },
      );
  }
  try {
    if (joined === 'browser-transfer-config') {
      if (req.method !== 'GET')
        return NextResponse.json({ message: 'Method not allowed' }, { status: 405 });
      if (!org || !env)
        return NextResponse.json(
          { message: 'Select an organization and environment.' },
          { status: 403 },
        );
      const response = await backend.fetch('/v1/auth/me', {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        if ([401, 403].includes(response.status))
          for (const name of Object.values(names)) jar.delete(name);
        return new NextResponse(await response.text(), {
          status: response.status === 403 ? 401 : response.status,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            ...(response.headers.has('retry-after')
              ? { 'Retry-After': response.headers.get('retry-after')! }
              : {}),
          },
        });
      }
      return NextResponse.json(
        { enabled: backend.mode === 'vercel' || process.env.FLARE_BROWSER_TRANSFERS === 'true' },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (joined === 'session/switch') {
      const selection = JSON.parse(body ?? '{}') as { orgId?: string; environmentId?: string };
      if (
        !/^[0-9a-f-]{36}$/i.test(selection.orgId ?? '') ||
        !/^[0-9a-f-]{36}$/i.test(selection.environmentId ?? '')
      )
        return NextResponse.json(
          { message: 'Select an organization and environment' },
          { status: 400 },
        );
      const response = await backend.fetch('/v1/auth/me', {
        headers: {
          ...headers,
          'x-org-id': selection.orgId!,
          'x-environment-id': selection.environmentId!,
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        return new NextResponse(await response.text(), {
          status: response.status,
          headers: {
            'Content-Type': 'application/json',
            ...(response.headers.has('retry-after')
              ? { 'Retry-After': response.headers.get('retry-after')! }
              : {}),
          },
        });
      jar.set(names.org, selection.orgId!, cookieOptions);
      jar.set(names.env, selection.environmentId!, cookieOptions);
      return NextResponse.json(await response.json());
    }
    const endpoint = joined === 'session' ? 'auth/me' : path.map(encodeURIComponent).join('/');
    if (joined === 'browser-transfers' && req.method === 'POST')
      headers.Origin = req.headers.get('origin')!;
    if (req.headers.get('idempotency-key'))
      headers['Idempotency-Key'] = req.headers.get('idempotency-key')!;
    if (req.headers.get('traceparent')) headers.traceparent = req.headers.get('traceparent')!;
    const response = await backend.fetch(`/v1/${endpoint}${req.nextUrl.search}`, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(120000),
    });
    const text = await response.text();
    if (response.ok && ['auth/login', 'auth/exchange', 'auth/accept-invite'].includes(joined)) {
      const data = JSON.parse(text) as SessionResponse;
      const organization = data.organizations[0];
      const environment = organization?.environments[0];
      if (!organization || !environment) {
        const operator = await backend.fetch('/v1/operator/session', {
          headers: { Authorization: `Bearer ${data.token}` },
          signal: AbortSignal.timeout(15000),
        });
        if (operator.status === 503 && operator.headers.has('x-flare-proxy-error'))
          return new NextResponse(await operator.text(), {
            status: 503,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': operator.headers.get('retry-after') ?? '1',
            },
          });
        if (!operator.ok)
          return NextResponse.json(
            { message: 'This account has no organization access' },
            { status: 403 },
          );
        jar.set(names.token, data.token, cookieOptions);
        jar.delete(names.org);
        jar.delete(names.env);
        return NextResponse.json({ organizations: [], operator_only: true });
      }
      jar.set(names.token, data.token, cookieOptions);
      jar.set(names.org, organization.id, cookieOptions);
      jar.set(names.env, environment.id, cookieOptions);
      const { token: _token, ...safe } = data;
      return NextResponse.json(safe);
    }
    // Only a session check can establish that the dashboard session is invalid.
    // Resource-level 401s may come from providers; keep cookies until the active
    // session is revalidated. Operator 403 means missing authority, not expiry.
    const sessionRejected =
      (joined === 'session' && [401, 403].includes(response.status)) ||
      (joined === 'operator/session' && response.status === 401);
    if (['auth/logout', 'operator/logout'].includes(joined) || sessionRejected)
      for (const name of Object.values(names)) jar.delete(name);
    return new NextResponse(text || null, {
      status: sessionRejected ? 401 : response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') ?? 'application/json',
        'Cache-Control': 'no-store',
        ...Object.fromEntries(
          [
            'ratelimit-limit',
            'ratelimit-remaining',
            'ratelimit-reset',
            'retry-after',
            'traceparent',
          ].flatMap((key) =>
            response.headers.has(key) ? [[key, response.headers.get(key)!]] : [],
          ),
        ),
        ...(response.headers.get('x-request-id')
          ? { 'x-request-id': response.headers.get('x-request-id')! }
          : {}),
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        message:
          error instanceof DashboardProxyError
            ? error.message
            : 'Flare API is unavailable. Check the API service and retry.',
      },
      { status: error instanceof DashboardProxyError ? error.status : 503 },
    );
  }
}
export { handler as GET, handler as POST, handler as PATCH, handler as PUT, handler as DELETE };

export async function OPTIONS(_req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (isPrivateDashboardPath(['api', ...path]))
    return NextResponse.json({ message: 'Not found' }, { status: 404 });
  // Preserve Next's automatic OPTIONS contract for all other existing API routes.
  return new NextResponse(null, {
    status: 204,
    headers: { Allow: 'DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT' },
  });
}
