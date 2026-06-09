/**
 * Session helpers — stores the JWT and user profile in localStorage
 * and mirrors the token in a cookie so Next.js middleware can read it
 * on the server edge without a round-trip.
 */

import type { UserProfile } from './api';

const TOKEN_KEY = 'eduvo_token';
const REFRESH_TOKEN_KEY = 'eduvo_refresh_token';
const EXPIRES_AT_KEY = 'eduvo_expires_at';
const USER_KEY = 'eduvo_user';
const COOKIE_NAME = 'eduvo_token';

// ── Write ─────────────────────────────────────────────────────────────────────

export function saveSession(
  token: string,
  user: UserProfile,
  refreshToken?: string,
  expiresAt?: number
): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  if (expiresAt !== undefined) localStorage.setItem(EXPIRES_AT_KEY, String(expiresAt));
  // Mirror in cookies for middleware (not HttpOnly — edge middleware reads them).
  // Add Secure flag in production so the cookie is only sent over HTTPS.
  const securePart = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE_NAME}=${token}; path=/; SameSite=Lax${securePart}`;
  document.cookie = `eduvo_role=${user.role}; path=/; SameSite=Lax${securePart}`;
}

// ── Read ──────────────────────────────────────────────────────────────────────

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
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
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(EXPIRES_AT_KEY);
  localStorage.removeItem(USER_KEY);
  // Expire both cookies
  const securePart = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE_NAME}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT${securePart}`;
  document.cookie = `eduvo_role=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT${securePart}`;
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
