/**
 * POST /api/session/clear
 *
 * Expires all auth cookies server-side. Called on logout.
 * Because the token cookie is HttpOnly, client-side JS cannot delete it
 * directly — it must call this endpoint.
 */

import { NextResponse } from 'next/server';

export async function POST() {
  const res = NextResponse.json({ ok: true });

  const expiredOpts = {
    path: '/',
    sameSite: 'lax' as const,
    maxAge: 0, // immediate expiry
  };

  res.cookies.set('eduvo_token', '', expiredOpts);
  res.cookies.set('eduvo_role', '', expiredOpts);
  res.cookies.set('eduvo_refresh_token', '', expiredOpts);
  res.cookies.set('eduvo_expires_at', '', expiredOpts);

  return res;
}
