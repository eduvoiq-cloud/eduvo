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
import { authApi, registerOn401Handler, registerOn402Handler, type UserProfile, type MediumSchool, getActiveSchoolId, setActiveSchoolId } from '@/lib/api';
import {
  saveSession,
  flushSessionCookies,
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
  /** True when the school's subscription has expired */
  subscriptionExpired: boolean;
  /** All schools this admin can access (populated for schooladmin role) */
  schools: MediumSchool[];
  /** The currently active school ID (may differ from user.school_id when switched) */
  activeSchoolId: string | null;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Switch the active medium — updates activeSchoolId and persists to localStorage */
  switchMedium: (schoolId: string) => void;
  /** Refresh the schools list after adding a new medium */
  refreshSchools: () => Promise<void>;
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
    subscriptionExpired: false,
    schools: [],
    activeSchoolId: null,
  });

  // Hold the refresh timer so we can clear it on logout
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Hold a stable ref to scheduleRefresh so the recursive call inside
  // setTimeout always uses the latest version without needing it in deps.
  const scheduleRefreshRef = useRef<(expiresAt: number, refreshToken: string, user: UserProfile) => void>(null!);

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
        // Use the ref so this recursive call doesn't need scheduleRefresh in deps
        scheduleRefreshRef.current(newExpiresAt, newRefreshToken, user);
      } catch {
        // Refresh failed — session is dead, force re-login
        clearSession();
        setState({ user: null, token: null, loading: false, subscriptionExpired: false, schools: [], activeSchoolId: null });
        router.push('/login');
      }
    }, delayMs);
  }, [router]);

  // Keep the ref in sync with the latest scheduleRefresh instance.
  // useLayoutEffect runs synchronously after render so the ref is always
  // current before any effect callbacks can fire.
  React.useLayoutEffect(() => {
    scheduleRefreshRef.current = scheduleRefresh;
  });

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

    // Re-sync the HttpOnly cookie in case it expired or was cleared (e.g. new
    // browser tab, cookie cleared by browser, or first load after localStorage
    // login). The middleware reads the cookie — if it's missing, it redirects
    // to /login even though we have a valid token in localStorage.
    // We fire-and-forget here; this is best-effort to keep cookie in sync.
    void flushSessionCookies(token, user.role, refreshToken ?? undefined, expiresAt ?? undefined);

    // If the browser is offline, skip all network calls and use the cached user
    // immediately. Prevents an infinite spinner when the page loads without
    // internet — the session is still valid, we just can't verify it right now.
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      const activeSchoolId = getActiveSchoolId() ?? user.school_id;
      setState({ user, token, loading: false, subscriptionExpired: false, schools: [], activeSchoolId });
      if (expiresAt && refreshToken) scheduleRefresh(expiresAt, refreshToken, user);
      return;
    }

    // If token is already expired (or about to expire), try to refresh immediately
    const tokenExpiredOrSoon = expiresAt !== null && Date.now() >= expiresAt * 1000 - REFRESH_BUFFER_MS;

    if (tokenExpiredOrSoon && refreshToken) {
      Promise.race([
        authApi.refresh(refreshToken),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('refresh_timeout')), 8000)
        ),
      ])
        .then((res) => {
          const { token: newToken, refresh_token: newRefreshToken, expires_at: newExpiresAt } = res.data;
          saveSession(newToken, user, newRefreshToken, newExpiresAt);
          const activeSchoolId = getActiveSchoolId() ?? user.school_id;
          setState({ user, token: newToken, loading: false, subscriptionExpired: false, schools: [], activeSchoolId });
          scheduleRefresh(newExpiresAt, newRefreshToken, user);
        })
        .catch(() => {
          clearSession();
          setActiveSchoolId(null);
          setState({ user: null, token: null, loading: false, subscriptionExpired: false, schools: [], activeSchoolId: null });
          router.push('/login');
        });
      return;
    }

    // Optimistically set the cached user so the UI renders immediately,
    // then silently refresh the profile from the server in the background.
    const activeSchoolId = getActiveSchoolId() ?? user.school_id;
    setState({ user, token, loading: true, subscriptionExpired: false, schools: [], activeSchoolId });

    // Wrap /me in a 8-second timeout so a slow/dead backend never leaves
    // the spinner stuck forever — the cached user is good enough to proceed.
    const meWithTimeout = Promise.race([
      authApi.me(token),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('me_timeout')), 8000)
      ),
    ]);

    meWithTimeout
      .then((res) => {
        // /me returns { token_type: 'staff', user: {...}, schools: [...] }
        const freshUser: UserProfile = res.data.user;
        const freshSchools: MediumSchool[] = res.data.schools ?? [];

        // Persist the refreshed profile so future loads are up-to-date
        saveSession(token, freshUser, refreshToken ?? undefined, expiresAt ?? undefined);

        // Restore active school from localStorage, or use primary school_id
        let activeSchoolId = getActiveSchoolId();
        if (
          !activeSchoolId ||
          !freshSchools.find((s) => s.id === activeSchoolId)
        ) {
          activeSchoolId = freshUser.school_id;
          setActiveSchoolId(freshUser.school_id);
        }

        // Schedule a proactive refresh if we have the needed info
        if (expiresAt && refreshToken) {
          scheduleRefresh(expiresAt, refreshToken, freshUser);
        }

        if (freshUser.must_reset_password && !window.location.pathname.includes('force-reset-password')) {
          setState({ user: freshUser, token, loading: false, subscriptionExpired: false, schools: freshSchools, activeSchoolId });
          window.location.replace('/force-reset-password');
          return;
        }

        setState({ user: freshUser, token, loading: false, subscriptionExpired: false, schools: freshSchools, activeSchoolId });
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
          // Wrap refresh in a timeout so a dead backend never hangs the spinner
          Promise.race([
            authApi.refresh(refreshToken),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('refresh_timeout')), 8000)
            ),
          ])
            .then((res) => {
              const { token: newToken, refresh_token: newRefreshToken, expires_at: newExpiresAt } = res.data;
              saveSession(newToken, user, newRefreshToken, newExpiresAt);
              setState({ user, token: newToken, loading: false, subscriptionExpired: false, schools: [], activeSchoolId: state.activeSchoolId });
              scheduleRefresh(newExpiresAt, newRefreshToken, user);
            })
            .catch(() => {
              clearSession();
              setState({ user: null, token: null, loading: false, subscriptionExpired: false, schools: [], activeSchoolId: null });
              router.push('/login');
            });
        } else if (isAuthError) {
          clearSession();
          setState({ user: null, token: null, loading: false, subscriptionExpired: false, schools: [], activeSchoolId: null });
          router.push('/login');
        } else {
          // Network / server error (or timeout) — keep cached user, mark loading done
          setState((s) => ({ ...s, user, token, loading: false }));
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await authApi.login(email, password);
    const { token, refresh_token, expires_at, user } = res.data;

    saveSession(token, user, refresh_token, expires_at);

    // Preserve the previously-selected medium across logins.
    // The stored school_id will be validated against the fresh schools list
    // when /me resolves in the useEffect below. If it's invalid, it falls back
    // to user.school_id automatically. Only reset to the primary school when
    // there is no previously stored value (i.e., first-ever login).
    const existingSchoolId = getActiveSchoolId();
    const activeSchoolId = existingSchoolId ?? user.school_id;
    if (!existingSchoolId) {
      setActiveSchoolId(user.school_id);
    }
    setState({ user, token, loading: false, subscriptionExpired: false, schools: [], activeSchoolId });

    // Schedule proactive token refresh
    if (expires_at && refresh_token) {
      scheduleRefresh(expires_at, refresh_token, user);
    }

    if (res.data.must_reset_password || user.must_reset_password) {
      window.location.replace('/force-reset-password');
    } else {
      // Wait for the HttpOnly cookies to be set server-side before navigating.
      // The edge middleware reads eduvo_token + eduvo_role cookies on the very
      // next request — if we push() before the cookies land, the middleware sees
      // no token and redirects back to /login, creating a redirect loop.
      await flushSessionCookies(token, user.role, refresh_token, expires_at);
      router.push(dashboardPath(user.role));
    }
  }, [router, scheduleRefresh]);

  const logout = useCallback(async () => {
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
    setActiveSchoolId(null);
    setState({ user: null, token: null, loading: false, subscriptionExpired: false, schools: [], activeSchoolId: null });
    router.push('/login');
  }, [router]);

  /** Switch the active medium — updates context, localStorage, and re-fetches the current page */
  const switchMedium = useCallback((schoolId: string) => {
    setActiveSchoolId(schoolId);
    setState((s) => ({ ...s, activeSchoolId: schoolId }));
    // Refresh the current route so all page-level useEffects re-run with the new X-School-ID header
    router.refresh();
  }, [router]);

  /** Re-fetch /me to get an updated schools list after adding a new medium */
  const refreshSchools = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    try {
      const res = await authApi.me(token);
      const freshSchools: MediumSchool[] = res.data.schools ?? [];
      setState((s) => ({ ...s, schools: freshSchools }));
    } catch {
      // Silently ignore — schools list will update on next full reload
    }
  }, []);

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
      setActiveSchoolId(null);
      setState({ user: null, token: null, loading: false, subscriptionExpired: false, schools: [], activeSchoolId: null });
      router.push('/login');
    });

    // Register the global 402 handler — school subscription expired.
    registerOn402Handler(() => {
      setState((s) => ({ ...s, subscriptionExpired: true }));
    });
  }, [router]);

  return (
    <AuthContext.Provider value={{ ...state, login, logout, switchMedium, refreshSchools }}>
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
