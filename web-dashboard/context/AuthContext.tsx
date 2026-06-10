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
import { authApi, registerOn401Handler, type UserProfile, type MediumSchool, getActiveSchoolId, setActiveSchoolId } from '@/lib/api';
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
    schools: [],
    activeSchoolId: null,
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
        setState({ user: null, token: null, loading: false, schools: [], activeSchoolId: null });
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
          const activeSchoolId = getActiveSchoolId() ?? user.school_id;
          setState({ user, token: newToken, loading: false, schools: [], activeSchoolId });
          scheduleRefresh(newExpiresAt, newRefreshToken, user);
        })
        .catch(() => {
          clearSession();
          setActiveSchoolId(null);
          setState({ user: null, token: null, loading: false, schools: [], activeSchoolId: null });
          router.push('/login');
        });
      return;
    }

    // Optimistically set the cached user so the UI renders immediately,
    // then silently refresh the profile from the server in the background.
    const activeSchoolId = getActiveSchoolId() ?? user.school_id;
    setState({ user, token, loading: true, schools: [], activeSchoolId });

    authApi.me(token)
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
          setState({ user: freshUser, token, loading: true, schools: freshSchools, activeSchoolId });
          window.location.replace('/force-reset-password');
          return;
        }

        setState({ user: freshUser, token, loading: false, schools: freshSchools, activeSchoolId });
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
              setState({ user, token: newToken, loading: false, schools: state.schools, activeSchoolId: state.activeSchoolId });
              scheduleRefresh(newExpiresAt, newRefreshToken, user);
            })
            .catch(() => {
              clearSession();
              setState({ user: null, token: null, loading: false, schools: [], activeSchoolId: null });
              router.push('/login');
            });
        } else if (isAuthError) {
          clearSession();
          setState({ user: null, token: null, loading: false, schools: [], activeSchoolId: null });
          router.push('/login');
        } else {
          // Network / server error — keep cached user, mark loading done
          setState({ user, token, loading: false, schools: state.schools, activeSchoolId: state.activeSchoolId });
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await authApi.login(email, password);
    const { token, refresh_token, expires_at, user } = res.data;

    saveSession(token, user, refresh_token, expires_at);

    // Set active school to primary on fresh login
    setActiveSchoolId(user.school_id);
    setState({ user, token, loading: false, schools: [], activeSchoolId: user.school_id });

    // Schedule proactive token refresh
    if (expires_at && refresh_token) {
      scheduleRefresh(expires_at, refresh_token, user);
    }

    if (res.data.must_reset_password || user.must_reset_password) {
      window.location.replace('/force-reset-password');
    } else {
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
    setState({ user: null, token: null, loading: false, schools: [], activeSchoolId: null });
    router.push('/login');
  }, [router]);

  /** Switch the active medium — updates context and localStorage */
  const switchMedium = useCallback((schoolId: string) => {
    setActiveSchoolId(schoolId);
    setState((s) => ({ ...s, activeSchoolId: schoolId }));
  }, []);

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
      setState({ user: null, token: null, loading: false, schools: [], activeSchoolId: null });
      router.push('/login');
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
