/**
 * POST /api/session/set
 *
 * Sets the auth cookies server-side with HttpOnly so JavaScript cannot read
 * the JWT. Called by the client immediately after a successful login.
 *
 * Body: { token: string; role: string; refreshToken?: string; expiresAt?: number }
 *
 * The access token goes into an HttpOnly cookie.
 * The role goes into a non-HttpOnly cookie so the edge middleware (proxy.ts)
 * can read it for role-based routing without a DB round-trip.
 *
 * NOTE: This route is intentionally excluded from the Next.js rewrite that
 * proxies /api/* to Railway — it is a Next.js API route, not a backend call.
 * The rewrite only fires when RAILWAY_API_URL is set (production), and Next.js
 * matches local App Router routes before applying rewrites.
 */

import { NextRequest, NextResponse } from 'next/server';

const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days — matches Supabase session lifetime

export async function POST(req: NextRequest) {
  let body: { token?: string; role?: string; refreshToken?: string; expiresAt?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { token, role, refreshToken, expiresAt } = body;

  if (!token || typeof token !== 'string') {
    return NextResponse.json({ error: 'token is required' }, { status: 400 });
  }
  if (!role || typeof role !== 'string') {
    return NextResponse.json({ error: 'role is required' }, { status: 400 });
  }

  const isSecure = req.headers.get('x-forwarded-proto') === 'https' ||
    req.url.startsWith('https://');

  const res = NextResponse.json({ ok: true });

  const cookieOpts = {
    path: '/',
    sameSite: 'lax' as const,
    secure: isSecure,
    maxAge: COOKIE_MAX_AGE,
  };

  // HttpOnly — not readable by JS, protects against XSS token theft
  res.cookies.set('eduvo_token', token, {
    ...cookieOpts,
    httpOnly: true,
  });

  // Not HttpOnly — edge middleware (proxy.ts) reads this for role-based routing
  res.cookies.set('eduvo_role', role, {
    ...cookieOpts,
    httpOnly: false,
  });

  // Store refresh token HttpOnly as well
  if (refreshToken && typeof refreshToken === 'string') {
    res.cookies.set('eduvo_refresh_token', refreshToken, {
      ...cookieOpts,
      httpOnly: true,
    });
  }

  // Store expiry (non-sensitive metadata) — readable by JS for proactive refresh scheduling
  if (expiresAt !== undefined && typeof expiresAt === 'number') {
    res.cookies.set('eduvo_expires_at', String(expiresAt), {
      ...cookieOpts,
      httpOnly: false,
    });
  }

  return res;
}
