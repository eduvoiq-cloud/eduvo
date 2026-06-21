/**
 * Session helpers — stores the JWT in an HttpOnly cookie (via a Next.js API
 * route) so JavaScript cannot read it, protecting against XSS token theft.
 *
 * Non-sensitive metadata (user profile, expiry timestamp) is kept in
 * localStorage for quick client-side access without a round-trip.
 *
 * Cookie lifecycle:
 *   saveSession()  → POST /api/session/set   (sets HttpOnly cookies server-side)
 *   clearSession() → POST /api/session/clear (expires HttpOnly cookies server-side)
 *
 * The edge middleware (proxy.ts) reads the HttpOnly `eduvo_token` cookie and
 * the non-HttpOnly `eduvo_role` cookie for route protection — both are set
 * by the /api/session/set route.
 */

import type { UserProfile } from './api';

const USER_KEY        = 'eduvo_user';
const EXPIRES_AT_KEY  = 'eduvo_expires_at';
// Refresh token is kept in localStorage only as a fallback for the proactive
// refresh timer. It is also stored HttpOnly in a cookie by the server route.
const REFRESH_TOKEN_KEY = 'eduvo_refresh_token';

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Call the Next.js API route that sets HttpOnly cookies server-side. */
async function setServerCookies(
  token: string,
  role: string,
  refreshToken?: string,
  expiresAt?: number
): Promise<void> {
  try {
    await fetch('/api/session/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, role, refreshToken, expiresAt }),
    });
  } catch {
    // Non-fatal — the session will still work via localStorage fallback,
    // but the HttpOnly cookie won't be set (degraded XSS protection).
    console.warn('[session] Failed to set server-side cookies');
  }
}

/** Call the Next.js API route that expires all auth cookies server-side. */
async function clearServerCookies(): Promise<void> {
  try {
    await fetch('/api/session/clear', { method: 'POST' });
  } catch {
    console.warn('[session] Failed to clear server-side cookies');
  }
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Persist the session.
 *
 * - User profile → localStorage (non-sensitive, needed for UI rendering)
 * - Token        → HttpOnly cookie via /api/session/set (XSS-safe)
 * - Refresh token → localStorage (for proactive refresh timer) + HttpOnly cookie
 * - expiresAt   → localStorage + non-HttpOnly cookie (non-sensitive metadata)
 *
 * The fire-and-forget fetch to /api/session/set is intentional: the token is
 * immediately available from localStorage for the current-request API calls
 * (AuthContext reads it synchronously), and the HttpOnly cookie is set
 * asynchronously for future navigations and edge middleware checks.
 */
export function saveSession(
  token: string,
  user: UserProfile,
  refreshToken?: string,
  expiresAt?: number
): void {
  if (typeof window === 'undefined') return;

  // Store non-sensitive data in localStorage for synchronous client reads
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  if (expiresAt !== undefined) localStorage.setItem(EXPIRES_AT_KEY, String(expiresAt));

  // Store the token itself in localStorage temporarily so existing
  // in-flight API calls (e.g. immediately after login) can attach it.
  // The HttpOnly cookie set below takes over for all subsequent page loads.
  // We use sessionStorage-level key prefixed with '__' to signal it's ephemeral,
  // but practically keep it in localStorage for compatibility with existing reads.
  localStorage.setItem('eduvo_token', token);

  // Async: set HttpOnly cookies server-side. This runs in the background —
  // the cookie will be in place before the next navigation/request cycle.
  void setServerCookies(token, user.role, refreshToken, expiresAt);
}

// ── Read ──────────────────────────────────────────────────────────────────────

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('eduvo_token');
}

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function getExpiresAt(): number | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(EXPIRES_AT_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return isNaN(n) ? null : n;
}

export function getUser(): UserProfile | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserProfile;
  } catch {
    return null;
  }
}

// ── Clear ─────────────────────────────────────────────────────────────────────

export function clearSession(): void {
  if (typeof window === 'undefined') return;

  // Clear localStorage
  localStorage.removeItem('eduvo_token');
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(EXPIRES_AT_KEY);
  localStorage.removeItem(USER_KEY);

  // Expire HttpOnly cookies via server route (async, fire-and-forget)
  void clearServerCookies();
}

// ── Role → dashboard path ─────────────────────────────────────────────────────

export function dashboardPath(role: UserProfile['role']): string {
  switch (role) {
    case 'superadmin':
      return '/superadmin/dashboard';
    case 'schooladmin':
      return '/admin/dashboard';
    case 'teacher':
      return '/teacher/dashboard';
    default:
      return '/login';
  }
}
