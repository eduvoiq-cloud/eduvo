import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform, Alert } from 'react-native';
import { NavigationContainerRef } from '@react-navigation/native';

// ── Navigation ref ────────────────────────────────────────────────────────────
// Set this ref in App.tsx so background-tap handlers can navigate without
// needing a component context.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export let navigationRef: NavigationContainerRef<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setNavigationRef(ref: NavigationContainerRef<any> | null) {
  navigationRef = ref;
}

// ── Foreground notification handler ──────────────────────────────────────────
// Show an in-app alert when a notification arrives while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// ── Register for push notifications ──────────────────────────────────────────

/**
 * Requests notification permissions and returns the Expo push token.
 * Returns null if running on a simulator or permissions are denied.
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  if (!Device.isDevice) {
    console.warn('[Notifications] Push notifications require a physical device.');
    return null;
  }

  // Android: create a notification channel
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Eduvo',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#1D4ED8',
    });
  }

  // Check existing permissions
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  // Request if not already granted
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.warn('[Notifications] Permission not granted for push notifications.');
    return null;
  }

  // Get the Expo push token
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId;

  if (!projectId) {
    console.warn('[Notifications] No EAS projectId found in app config.');
    return null;
  }

  const { data: expoPushToken } = await Notifications.getExpoPushTokenAsync({ projectId });
  return expoPushToken;
}

// ── Send FCM token to backend ─────────────────────────────────────────────────

/**
 * Registers the device push token with the backend so the server can send
 * targeted push notifications to this device.
 *
 * Endpoint: POST /api/users/fcm-token
 * Body:     { fcm_token: string }
 *
 * Call this after the user logs in and a token is obtained.
 */
export async function sendFcmTokenToBackend(
  token: string,
  // Accept apiClient as a parameter to avoid a circular import
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiClient: any
): Promise<void> {
  try {
    await apiClient.post('/api/users/fcm-token', { fcm_token: token });
    console.log('[Notifications] FCM token registered with backend.');
  } catch (error: any) {
    console.warn('[Notifications] Failed to register FCM token:', error.message);
  }
}

// ── Foreground notification listener ─────────────────────────────────────────

/**
 * Adds a listener for notifications received while the app is foregrounded.
 * Shows an in-app Alert so the user sees the message immediately.
 * Returns the subscription so the caller can remove it on unmount.
 */
export function addNotificationReceivedListener(
  handler?: (notification: Notifications.Notification) => void
): Notifications.EventSubscription {
  return Notifications.addNotificationReceivedListener((notification) => {
    const { title, body } = notification.request.content;

    // Show an in-app alert for foreground notifications
    Alert.alert(
      title ?? 'New Notification',
      body ?? '',
      [{ text: 'OK', style: 'default' }],
      { cancelable: true }
    );

    // Also call any custom handler the caller provided
    handler?.(notification);
  });
}

// ── Background / killed-state tap listener ────────────────────────────────────

/**
 * Adds a listener for when the user taps a notification (background or killed state).
 * Navigates to the Notifications screen if a navigation ref is available.
 * Returns the subscription so the caller can remove it on unmount.
 */
export function addNotificationResponseListener(
  handler?: (response: Notifications.NotificationResponse) => void
): Notifications.EventSubscription {
  return Notifications.addNotificationResponseReceivedListener((response) => {
    console.log('[Notifications] Tapped:', response.notification.request.content.title);

    // Navigate to the Notifications tab so the user sees the full list
    if (navigationRef?.isReady()) {
      navigationRef.navigate('Notifications' as never);
    }

    handler?.(response);
  });
}
