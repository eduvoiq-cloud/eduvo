'use client';

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
} from 'react';
import { useRouter } from 'next/navigation';
import { authApi, registerOn401Handler, type UserProfile } from '@/lib/api';
import {
  saveSession,
  getToken,
  getRefreshToken,
  getExpiresAt,
  getUser,
  clearSession,
  dashboardPath,
} from '@/lib/session';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AuthState {
  user: UserProfile | null;
  token: string | null;
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

// ── Context ───────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | null>(null);

// Refresh the token 5 minutes before it expires
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ── Provider ──────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<AuthState>({
    user: null,
    token: null,
    loading: true,
  });

  // Hold the refresh timer so we can clear it on logout
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Schedule a token refresh to fire REFRESH_BUFFER_MS before the token expires.
   * If expiresAt is in the past (or very soon), refresh immediately.
   */
  const scheduleRefresh = useCallback((expiresAt: number, refreshToken: string, user: UserProfile) => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }

    // expiresAt from Supabase is a Unix timestamp in seconds
    const expiresAtMs = expiresAt * 1000;
    const delayMs = Math.max(0, expiresAtMs - Date.now() - REFRESH_BUFFER_MS);

    refreshTimerRef.current = setTimeout(async () => {
      try {
        const res = await authApi.refresh(refreshToken);
        const { token: newToken, refresh_token: newRefreshToken, expires_at: newExpiresAt } = res.data;
        saveSession(newToken, user, newRefreshToken, newExpiresAt);
        setState((s) => ({ ...s, token: newToken }));
        scheduleRefresh(newExpiresAt, newRefreshToken, user);
      } catch {
        // Refresh failed — session is dead, force re-login
        clearSession();
        setState({ user: null, token: null, loading: false });
        router.push('/login');
      }
    }, delayMs);
  }, [router]);

  // Rehydrate session from localStorage on mount, then verify + refresh
  // profile from the server. This ensures stale cached data (e.g. a null
  // school_id that was fixed in the DB) is always corrected on next load.
  useEffect(() => {
    const token = getToken();
    const user = getUser();
    const refreshToken = getRefreshToken();
    const expiresAt = getExpiresAt();

    if (!token || !user) {
      setState((s) => ({ ...s, loading: false }));
      return;
    }

    // If token is already expired (or about to expire), try to refresh immediately
    const tokenExpiredOrSoon = expiresAt !== null && Date.now() >= expiresAt * 1000 - REFRESH_BUFFER_MS;

    if (tokenExpiredOrSoon && refreshToken) {
      authApi.refresh(refreshToken)
        .then((res) => {
          const { token: newToken, refresh_token: newRefreshToken, expires_at: newExpiresAt } = res.data;
          saveSession(newToken, user, newRefreshToken, newExpiresAt);
          setState({ user, token: newToken, loading: false });
          scheduleRefresh(newExpiresAt, newRefreshToken, user);
        })
        .catch(() => {
          clearSession();
          setState({ user: null, token: null, loading: false });
          router.push('/login');
        });
      return;
    }

    // Optimistically set the cached user so the UI renders immediately,
    // then silently refresh the profile from the server in the background.
    setState({ user, token, loading: true });

    authApi.me(token)
      .then((res) => {
        // /me returns { token_type: 'staff', user: {...} }
        const freshUser: UserProfile = res.data.user;
        // Persist the refreshed profile so future loads are up-to-date
        saveSession(token, freshUser, refreshToken ?? undefined, expiresAt ?? undefined);

        // Schedule a proactive refresh if we have the needed info
        if (expiresAt && refreshToken) {
          scheduleRefresh(expiresAt, refreshToken, freshUser);
        }

        // If this is a first-login teacher who hasn't reset their password,
        // do a hard redirect before rendering the dashboard. Using
        // window.location avoids the async Next.js App Router race condition
        // where router.push fires but the dashboard layout re-renders first.
        // Only redirect if not already on the force-reset-password page to
        // prevent an infinite reload loop.
        if (freshUser.must_reset_password && !window.location.pathname.includes('force-reset-password')) {
          // Keep loading: true so nothing renders while we navigate away
          setState({ user: freshUser, token, loading: true });
          window.location.replace('/force-reset-password');
          return;
        }

        setState({ user: freshUser, token, loading: false });
      })
      .catch((err: unknown) => {
        // If the server explicitly rejected the token (401/403), try to refresh
        // before giving up — the token may have just expired.
        const message = err instanceof Error ? err.message : String(err);
        const isAuthError =
          message.includes('401') ||
          message.includes('403') ||
          message.toLowerCase().includes('unauthorized') ||
          message.toLowerCase().includes('invalid') ||
          message.toLowerCase().includes('expired');

        if (isAuthError && refreshToken) {
          authApi.refresh(refreshToken)
            .then((res) => {
              const { token: newToken, refresh_token: newRefreshToken, expires_at: newExpiresAt } = res.data;
              saveSession(newToken, user, newRefreshToken, newExpiresAt);
              setState({ user, token: newToken, loading: false });
              scheduleRefresh(newExpiresAt, newRefreshToken, user);
            })
            .catch(() => {
              clearSession();
              setState({ user: null, token: null, loading: false });
              router.push('/login');
            });
        } else if (isAuthError) {
          clearSession();
          setState({ user: null, token: null, loading: false });
          router.push('/login');
        } else {
          // Network / server error — keep cached user, mark loading done
          setState({ user, token, loading: false });
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await authApi.login(email, password);
    const { token, refresh_token, expires_at, user } = res.data;

    saveSession(token, user, refresh_token, expires_at);
    setState({ user, token, loading: false });

    // Schedule proactive token refresh
    if (expires_at && refresh_token) {
      scheduleRefresh(expires_at, refresh_token, user);
    }

    // Force password reset before going to dashboard.
    // Use a hard redirect (window.location) to avoid the Next.js App Router
    // async navigation race where the dashboard layout renders first and
    // gets stuck in a spinner loop.
    if (res.data.must_reset_password || user.must_reset_password) {
      window.location.replace('/force-reset-password');
    } else {
      router.push(dashboardPath(user.role));
    }
  }, [router, scheduleRefresh]);

  const logout = useCallback(async () => {
    // Cancel any pending refresh timer
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }

    const token = getToken();
    if (token) {
      try {
        await authApi.logout(token);
      } catch {
        // Proceed with local logout even if server call fails
      }
    }
    clearSession();
    setState({ user: null, token: null, loading: false });
    router.push('/login');
  }, [router]);

  // Register the global 401 handler so any API call that gets a 401
  // mid-session (expired token) automatically clears the session and
  // redirects to login — without needing per-call error handling.
  useEffect(() => {
    registerOn401Handler(() => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      clearSession();
      setState({ user: null, token: null, loading: false });
      router.push('/login');
    });
  }, [router]);

  return (
    <AuthContext.Provider value={{ ...state, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
