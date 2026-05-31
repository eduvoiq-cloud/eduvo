import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LinkedChild {
  id: string;
  phone: string;
  token: string;
  name: string;
  class: string;
  section: string;
  school_id: string;
  roll_number?: string | null;
}

interface ChildState {
  linkedChildren: LinkedChild[];
  activeChildIndex: number;
}

interface ChildActions {
  addChild: (child: LinkedChild) => void;
  removeChild: (phone: string) => void;
  switchChild: (index: number) => void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useChildStore = create<ChildState & ChildActions>()(
  persist(
    (set, get) => ({
      linkedChildren: [],
      activeChildIndex: 0,

      addChild: (child: LinkedChild) => {
        const existing = get().linkedChildren;
        // Avoid duplicates by phone
        const alreadyLinked = existing.some((c) => c.phone === child.phone);
        if (alreadyLinked) return;
        set({ linkedChildren: [...existing, child] });
      },

      removeChild: (phone: string) => {
        const updated = get().linkedChildren.filter((c) => c.phone !== phone);
        const activeIndex = get().activeChildIndex;
        // Clamp active index if needed
        const newIndex = Math.min(activeIndex, Math.max(0, updated.length - 1));
        set({ linkedChildren: updated, activeChildIndex: newIndex });
      },

      switchChild: (index: number) => {
        const { linkedChildren } = get();
        if (index >= 0 && index < linkedChildren.length) {
          set({ activeChildIndex: index });
        }
      },
    }),
    {
      name: 'eduvo-child-storage',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
