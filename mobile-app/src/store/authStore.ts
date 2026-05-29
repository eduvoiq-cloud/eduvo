import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AppRole = 'superadmin' | 'schooladmin' | 'teacher' | 'parent' | 'student';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: AppRole;
  school_id: string | null;
}

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  isLoggedIn: boolean;
}

interface AuthActions {
  login: (user: AuthUser, token: string) => void;
  logout: () => void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useAuthStore = create<AuthState & AuthActions>()(
  persist(
    (set) => ({
      // Initial state
      user: null,
      token: null,
      isLoggedIn: false,

      // Set user + token, mark as logged in
      login: (user: AuthUser, token: string) => {
        set({ user, token, isLoggedIn: true });
      },

      // Clear all auth state
      logout: () => {
        set({ user: null, token: null, isLoggedIn: false });
      },
    }),
    {
      name: 'eduvo-auth-storage',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
