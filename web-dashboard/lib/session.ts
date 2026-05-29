/**
 * Session helpers — stores the JWT and user profile in localStorage
 * and mirrors the token in a cookie so Next.js middleware can read it
 * on the server edge without a round-trip.
 */

import type { UserProfile } from './api';

const TOKEN_KEY = 'eduvo_token';
const USER_KEY = 'eduvo_user';
const COOKIE_NAME = 'eduvo_token';

// ── Write ─────────────────────────────────────────────────────────────────────

export function saveSession(token: string, user: UserProfile): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  // Mirror in cookies for middleware (not HttpOnly — edge middleware reads them)
  document.cookie = `${COOKIE_NAME}=${token}; path=/; SameSite=Lax`;
  document.cookie = `eduvo_role=${user.role}; path=/; SameSite=Lax`;
}

// ── Read ──────────────────────────────────────────────────────────────────────

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
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
  localStorage.removeItem(USER_KEY);
  // Expire both cookies
  document.cookie = `${COOKIE_NAME}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  document.cookie = `eduvo_role=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
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
