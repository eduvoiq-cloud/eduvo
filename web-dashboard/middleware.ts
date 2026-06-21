import { NextRequest, NextResponse } from 'next/server';

/**
 * Next.js Edge Middleware — runs before every request.
 *
 * Enforces:
 *   - Unauthenticated users      → /login
 *   - Authenticated users on /login → their dashboard
 *   - Wrong-role users            → their correct dashboard
 *
 * Token is read from the HttpOnly `eduvo_token` cookie (set server-side by
 * /api/session/set). Role is read from the non-HttpOnly `eduvo_role` cookie.
 *
 * NOTE: This file MUST be named middleware.ts at the project root for Next.js
 * to pick it up. The legacy proxy.ts was never loaded by Next.js — this file
 * replaces it and makes route protection actually work.
 */

const PUBLIC_PATHS = [
  '/login',
  '/gate',
  '/forgot-password',
  '/reset-password',
  '/delete-account',
  '/terms-of-service',
  '/privacy-policy',
];

// Always accessible regardless of auth state — never redirect away from these
const ALWAYS_ALLOW_PATHS = ['/force-reset-password'];

// Which path prefix each role is allowed on
const ROLE_PREFIXES: Record<string, string> = {
  superadmin: '/superadmin',
  schooladmin: '/admin',
  teacher: '/teacher',
};

const ROLE_DASHBOARDS: Record<string, string> = {
  superadmin: '/superadmin/dashboard',
  schooladmin: '/admin/dashboard',
  teacher: '/teacher/dashboard',
};

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Let Next.js internals, static assets, Sentry tunnel, and API routes through.
  // /api/session/* must pass through to reach the local App Router handler that
  // sets/clears the HttpOnly cookies.
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    pathname.startsWith('/monitoring') ||
    pathname.includes('.')
  ) {
    return NextResponse.next();
  }

  // Always allow — e.g. force-reset-password must work even with a token present
  if (ALWAYS_ALLOW_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }

  const token    = req.cookies.get('eduvo_token')?.value;
  const roleRaw  = req.cookies.get('eduvo_role')?.value;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));

  // No token → send to login (unless already on a public page)
  if (!token) {
    if (isPublic) return NextResponse.next();
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  // Has token + on a public/login page → redirect to the appropriate dashboard
  if (isPublic) {
    const role = roleRaw ?? 'teacher';
    const url  = req.nextUrl.clone();
    url.pathname = ROLE_DASHBOARDS[role] ?? '/teacher/dashboard';
    return NextResponse.redirect(url);
  }

  // Has token + on a dashboard → make sure the role matches the path prefix
  if (roleRaw && ROLE_PREFIXES[roleRaw]) {
    const allowedPrefix  = ROLE_PREFIXES[roleRaw];
    const isDashboardPath = Object.values(ROLE_PREFIXES).some((p) => pathname.startsWith(p));

    if (isDashboardPath && !pathname.startsWith(allowedPrefix)) {
      const url = req.nextUrl.clone();
      url.pathname = ROLE_DASHBOARDS[roleRaw];
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
