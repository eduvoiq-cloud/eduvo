'use client';

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from 'react';
import { useRouter } from 'next/navigation';
import { authApi, registerOn401Handler, type UserProfile } from '@/lib/api';
import { saveSession, getToken, getUser, clearSession, dashboardPath } from '@/lib/session';

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

// ── Provider ──────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<AuthState>({
    user: null,
    token: null,
    loading: true,
  });

  // Rehydrate session from localStorage on mount, then verify + refresh
  // profile from the server. This ensures stale cached data (e.g. a null
  // school_id that was fixed in the DB) is always corrected on next load.
  useEffect(() => {
    const token = getToken();
    const user = getUser();

    if (!token || !user) {
      setState((s) => ({ ...s, loading: false }));
      return;
    }

    // Optimistically set the cached user so the UI renders immediately,
    // then silently refresh the profile from the server in the background.
    setState({ user, token, loading: true });

    authApi.me(token)
      .then((res) => {
        const freshUser = res.data;
        // Persist the refreshed profile so future loads are up-to-date
        saveSession(token, freshUser);
        setState({ user: freshUser, token, loading: false });
      })
      .catch((err: unknown) => {
        // If the server explicitly rejected the token (401/403), the session
        // is dead — clear it and send the user back to login so they get a
        // fresh token. For network errors we keep the cached user so the app
        // still works offline / during transient outages.
        const message = err instanceof Error ? err.message : String(err);
        const isAuthError =
          message.includes('401') ||
          message.includes('403') ||
          message.toLowerCase().includes('unauthorized') ||
          message.toLowerCase().includes('invalid') ||
          message.toLowerCase().includes('expired');

        if (isAuthError) {
          clearSession();
          setState({ user: null, token: null, loading: false });
          router.push('/login');
        } else {
          // Network / server error — keep cached user, mark loading done
          setState({ user, token, loading: false });
        }
      });
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await authApi.login(email, password);
    const { token, user } = res.data;

    saveSession(token, user);
    setState({ user, token, loading: false });
    router.push(dashboardPath(user.role));
  }, [router]);

  const logout = useCallback(async () => {
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
