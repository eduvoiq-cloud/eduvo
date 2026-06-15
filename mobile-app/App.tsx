import React, { useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { isRunningInExpoGo } from 'expo';
// expo-notifications is NOT imported here — it is lazy-loaded in notifications.ts
// to avoid crashing in Expo Go (remote push removed since SDK 53).
import * as Sentry from '@sentry/react-native';
import { NavigationContainerRef } from '@react-navigation/native';
import AppNavigator from './src/navigation/AppNavigator';
import {
  registerForPushNotificationsAsync,
  sendFcmTokenToBackend,
  addNotificationReceivedListener,
  addNotificationResponseListener,
  setNavigationRef,
} from './src/utils/notifications';
import { useAuthStore } from './src/store/authStore';
import apiClient from './src/api/client';

// ── Sentry initialisation ─────────────────────────────────────────────────────
// Must be called before any other app code.
Sentry.init({
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
  sendDefaultPii: true,

  // Capture all transactions in dev; lower in production to manage quota
  tracesSampleRate: __DEV__ ? 1.0 : 0.1,

  // Profile 100% of traced transactions (profiling is a subset of tracing)
  profilesSampleRate: 1.0,

  // Session Replay: all error sessions + 10% of normal sessions
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: __DEV__ ? 1.0 : 0.1,

  // Structured logs via Sentry.logger.*
  enableLogs: true,

  integrations: [
    // Record screenshots alongside errors (text + images masked by default)
    Sentry.mobileReplayIntegration({
      maskAllText: true,
      maskAllImages: true,
    }),
  ],

  // Slow/frozen frames tracking — disable in Expo Go to avoid warnings
  enableNativeFramesTracking: !isRunningInExpoGo(),

  environment: __DEV__ ? 'development' : 'production',

  // Verbose SDK logging in dev only
  debug: __DEV__,
});

function App() {
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const student = useAuthStore((state) => state.student);
  const [hydrated, setHydrated] = useState(false);
  const notificationListener = useRef<{ remove: () => void } | null>(null);
  const responseListener = useRef<{ remove: () => void } | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const navRef = useRef<NavigationContainerRef<any>>(null);

  // Wait for Zustand persisted store to rehydrate from AsyncStorage before
  // rendering any screens — prevents token being null on first render.
  useEffect(() => {
    const unsub = useAuthStore.persist.onFinishHydration(() => {
      setHydrated(true);
    });
    // If already hydrated (e.g. synchronous storage), fire immediately
    if (useAuthStore.persist.hasHydrated()) {
      setHydrated(true);
    }
    return () => unsub();
  }, []);

  // Keep the navigation ref in the notifications util so background-tap
  // handlers can navigate without needing a component context.
  useEffect(() => {
    setNavigationRef(navRef.current);
    return () => setNavigationRef(null);
  }, []);

  useEffect(() => {
    // Register for push notifications when user is logged in
    if (isLoggedIn && student?.id) {
      registerForPushNotificationsAsync().then((token) => {
        if (token) {
          // Send the FCM/Expo push token to the backend so it can target this device
          sendFcmTokenToBackend(student.id, token, apiClient);
        }
      });
    }

    // Push notification listeners are not supported in Expo Go since SDK 53.
    if (!isRunningInExpoGo()) {
      // Listen for notifications received while app is foregrounded (shows in-app Alert)
      notificationListener.current = addNotificationReceivedListener();

      // Listen for user tapping a notification (navigates to Notifications screen)
      responseListener.current = addNotificationResponseListener();
    }

    return () => {
      notificationListener.current?.remove();
      responseListener.current?.remove();
    };
  }, [isLoggedIn, student?.id]);

  // Don't render anything until the persisted auth state is loaded
  if (!hydrated) return null;

  return (
    <>
      <StatusBar style="light" />
      <AppNavigator navigationRef={navRef} />
    </>
  );
}

// Wrap the root component so React render errors are captured by Sentry
export default Sentry.wrap(App);
