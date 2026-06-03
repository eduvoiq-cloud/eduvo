import React, { useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
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

export default function App() {
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const student = useAuthStore((state) => state.student);
  const [hydrated, setHydrated] = useState(false);
  const notificationListener = useRef<Notifications.EventSubscription | null>(null);
  const responseListener = useRef<Notifications.EventSubscription | null>(null);
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

    // Listen for notifications received while app is foregrounded (shows in-app Alert)
    notificationListener.current = addNotificationReceivedListener();

    // Listen for user tapping a notification (navigates to Notifications screen)
    responseListener.current = addNotificationResponseListener();

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
