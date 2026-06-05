import { NextRequest, NextResponse } from 'next/server';

/**
 * Edge middleware — runs before every request.
 * Reads the token cookie (set by saveSession) and enforces:
 *   - Unauthenticated users → /login
 *   - Authenticated users on /login → their dashboard
 *   - Wrong-role users → their correct dashboard
 */

const PUBLIC_PATHS = ['/login', '/gate', '/forgot-password', '/reset-password', '/force-reset-password', '/delete-account', '/terms-of-service', '/privacy-policy'];

// Which path prefixes each role is allowed on
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

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Let Next.js internals and static files through
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    pathname.includes('.')
  ) {
    return NextResponse.next();
  }

  const token = req.cookies.get('eduvo_token')?.value;
  const roleRaw = req.cookies.get('eduvo_role')?.value;

  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));

  // No token → send to login (unless already there)
  if (!token) {
    if (isPublic) return NextResponse.next();
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  // Has token + on login page → redirect to dashboard
  if (token && isPublic) {
    const role = roleRaw ?? 'teacher';
    const url = req.nextUrl.clone();
    url.pathname = ROLE_DASHBOARDS[role] ?? '/teacher/dashboard';
    return NextResponse.redirect(url);
  }

  // Has token + on a dashboard → check role matches the path
  if (roleRaw && ROLE_PREFIXES[roleRaw]) {
    const allowedPrefix = ROLE_PREFIXES[roleRaw];
    const isDashboardPath = Object.values(ROLE_PREFIXES).some((p) =>
      pathname.startsWith(p)
    );

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
