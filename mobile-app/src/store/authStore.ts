import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { secureStorage } from './secureStorage';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StudentUser {
  id: string;
  name: string;
  phone: string;
  class: string;
  section: string;
  school_id: string;
  roll_number?: string | null;
}

interface AuthState {
  student: StudentUser | null;
  token: string | null;
  isLoggedIn: boolean;
  isFirstLogin: boolean;
}

interface AuthActions {
  login: (student: StudentUser, token: string, isFirstLogin?: boolean) => void;
  logout: () => void;
  markPasswordChanged: () => void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useAuthStore = create<AuthState & AuthActions>()(
  persist(
    (set) => ({
      // Initial state
      student: null,
      token: null,
      isLoggedIn: false,
      isFirstLogin: false,

      // Save student + token, mark as logged in
      login: (student: StudentUser, token: string, isFirstLogin = false) => {
        set({ student, token, isLoggedIn: true, isFirstLogin });
      },

      // Clear all auth state
      logout: () => {
        set({ student: null, token: null, isLoggedIn: false, isFirstLogin: false });
      },

      // Called after successful password change on first login
      markPasswordChanged: () => {
        set({ isFirstLogin: false });
      },
    }),
    {
      name: 'eduvo-auth-storage',
      storage: createJSONStorage(() => secureStorage),
    }
  )
);
