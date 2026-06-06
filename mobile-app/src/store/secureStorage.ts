/**
 * secureStorage.ts
 *
 * A Zustand-persist-compatible storage adapter that routes sensitive keys
 * (auth token) through expo-secure-store and everything else through
 * AsyncStorage.
 *
 * expo-secure-store uses the platform keychain (iOS Keychain / Android
 * Keystore) which is encrypted at rest and not accessible by other apps.
 * AsyncStorage is NOT encrypted, so we keep the JWT out of it.
 */

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StateStorage } from 'zustand/middleware';

// Keys that must be stored in the encrypted keychain
const SECURE_KEYS = new Set(['eduvo-auth-storage']);

export const secureStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      if (SECURE_KEYS.has(name)) {
        return await SecureStore.getItemAsync(name);
      }
      return await AsyncStorage.getItem(name);
    } catch {
      return null;
    }
  },

  setItem: async (name: string, value: string): Promise<void> => {
    try {
      if (SECURE_KEYS.has(name)) {
        await SecureStore.setItemAsync(name, value);
      } else {
        await AsyncStorage.setItem(name, value);
      }
    } catch {
      // Silently fail — the app will re-login on next launch
    }
  },

  removeItem: async (name: string): Promise<void> => {
    try {
      if (SECURE_KEYS.has(name)) {
        await SecureStore.deleteItemAsync(name);
      } else {
        await AsyncStorage.removeItem(name);
      }
    } catch {
      // Ignore
    }
  },
};
