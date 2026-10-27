import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { dashboardBackend, DashboardProxyError } from '../../../lib/dashboard-backend';
export const runtime = 'nodejs';
// Only the public subscriber Inbox surface is proxied. Novu administration stays internal.
async function handler(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (
    path.length < 3 ||
    path[0] !== 'v1' ||
    path[1] !== 'inbox' ||
    path.some((part) => !part || /[\\/?.#]/.test(part))
  )
    return NextResponse.json({ message: 'Inbox route not found' }, { status: 404 });
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
  if (!['GET', 'HEAD'].includes(req.method) && !backend.acceptsOrigin(req.headers.get('origin')))
    return NextResponse.json({ message: 'Invalid origin' }, { status: 403 });
  const authorization = req.headers.get('authorization');
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await req.text();
  if (body && Buffer.byteLength(body) > 1024 * 1024)
    return NextResponse.json({ message: 'Request too large' }, { status: 413 });
  try {
    if (backend.mode === 'vercel') {
      const token = req.cookies.get('flare_session')?.value,
        org = req.cookies.get('flare_org')?.value,
        environment = req.cookies.get('flare_environment')?.value;
      if (!token || !org || !environment)
        return NextResponse.json({ message: 'Sign in to open this Inbox' }, { status: 401 });
      if (body && Buffer.byteLength(body) > 64 * 1024)
        return NextResponse.json({ message: 'Inbox request too large' }, { status: 413 });
      const response = await backend.fetch(
        `/v1/dashboard/inbox/${path.slice(2).map(encodeURIComponent).join('/')}${req.nextUrl.search}`,
        {
          method: req.method,
          body,
          headers: {
            Authorization: `Bearer ${token}`,
            'x-org-id': org,
            'x-environment-id': environment,
            'Content-Type': 'application/json',
            ...(authorization ? { 'x-flare-inbox-authorization': authorization } : {}),
          },
          signal: AbortSignal.timeout(20000),
        },
      );
      return new NextResponse((await response.text()) || null, {
        status: response.status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
    if (path.join('/') === 'v1/inbox/session') {
      const input = JSON.parse(body ?? '{}') as {
        applicationIdentifier?: string;
        subscriberHash?: string;
        subscriber?: { subscriberId?: string };
      };
      const token = req.cookies.get('flare_session')?.value,
        subscriberId = input.subscriber?.subscriberId;
      if (!token || !subscriberId || !input.subscriberHash)
        return NextResponse.json(
          { message: 'Authenticated subscriber hash required' },
          { status: 401 },
        );
      const access = await backend.fetch(
        `/v1/subscribers/${encodeURIComponent(subscriberId)}/inbox-token`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'x-org-id': req.cookies.get('flare_org')?.value ?? '',
            'x-environment-id': req.cookies.get('flare_environment')?.value ?? '',
          },
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!access.ok)
        return NextResponse.json({ message: 'No access to this subscriber' }, { status: 403 });
      const expected = (await access.json()) as {
        subscriberHash: string;
        applicationIdentifier: string;
      };
      if (
        input.applicationIdentifier !== expected.applicationIdentifier ||
        input.subscriberHash !== expected.subscriberHash
      )
        return NextResponse.json({ message: 'Invalid subscriber credentials' }, { status: 403 });
    }
    const response = await fetch(
      `${process.env.NOVU_API_URL ?? 'http://novu-api:3000'}/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`,
      {
        method: req.method,
        body,
        headers: {
          'Content-Type': 'application/json',
          ...(authorization ? { Authorization: authorization } : {}),
        },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      },
    );
    return new NextResponse((await response.text()) || null, {
      status: response.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof DashboardProxyError ? error.message : 'Inbox is unavailable' },
      { status: error instanceof DashboardProxyError ? error.status : 503 },
    );
  }
}
export { handler as GET, handler as POST, handler as PATCH, handler as PUT, handler as DELETE };
