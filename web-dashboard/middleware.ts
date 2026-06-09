import { NextRequest, NextResponse } from 'next/server';

/**
 * Next.js Edge Middleware — server-side authentication guard.
 *
 * Reads the `eduvo_token` cookie that `lib/session.ts` mirrors on login.
 * If a request hits a protected dashboard route without a token, it is
 * redirected to /login immediately — before any client JS runs.
 *
 * This is defence-in-depth on top of the client-side AuthContext guard.
 * The real auth check (token validity + role) is done server-side by the
 * Express backend on every API call.
 */

/** Routes that require authentication */
const PROTECTED_PREFIXES = [
  '/admin',
  '/teacher',
  '/superadmin',
];

/** Routes that are always public (no redirect) */
const PUBLIC_PATHS = new Set([
  '/login',
  '/forgot-password',
  '/reset-password',
  '/force-reset-password',
  '/privacy-policy',
  '/terms-of-service',
  '/delete-account',
]);

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Always allow public paths, static assets, and Next.js internals
  if (
    PUBLIC_PATHS.has(pathname) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    pathname.startsWith('/monitoring') ||   // Sentry tunnel
    pathname.includes('.') ||               // static files (favicon, images, etc.)
    pathname === '/'
  ) {
    return NextResponse.next();
  }

  // Check if this is a protected route
  const isProtected = PROTECTED_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix)
  );

  if (!isProtected) {
    return NextResponse.next();
  }

  // Read the token cookie (set by lib/session.ts on login)
  const token = req.cookies.get('eduvo_token')?.value;

  if (!token) {
    // No token → redirect to login, preserving the originally requested URL
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Token present — allow through. The client-side AuthContext will verify
  // it via /api/auth/me on mount and handle expiry/invalidation.
  return NextResponse.next();
}

export const config = {
  // Run on all routes except static files — the pathname checks above
  // handle the filtering, but excluding _next/static avoids unnecessary work.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
