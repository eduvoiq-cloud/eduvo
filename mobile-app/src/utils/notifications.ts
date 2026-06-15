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
 * Registers the device push token with the backend for the student.
 *
 * Endpoint: POST /api/users/fcm-token-student
 * Body:     { student_id: string, fcm_token: string }
 *
 * Call this after the user logs in and a token is obtained.
 */
export async function sendFcmTokenToBackend(
  studentId: string,
  token: string,
  // Accept apiClient as a parameter to avoid a circular import
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiClient: any
): Promise<void> {
  try {
    await apiClient.post('/api/users/fcm-token-student', {
      student_id: studentId,
      fcm_token: token,
    });
    console.log('[Notifications] FCM token registered with backend.');
  } catch (error: any) {
    console.warn('[Notifications] Failed to register FCM token:', error.message);
  }
}

/**
 * Registers the device push token with the backend for a staff/parent user.
 *
 * Endpoint: POST /api/users/fcm-token
 * Body:     { fcm_token: string }
 *
 * Call this after a parent/staff user logs in and a token is obtained.
 * Requires the apiClient to have a staff/parent auth token set in headers.
 */
export async function sendFcmTokenToBackendForUser(
  token: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiClient: any
): Promise<void> {
  try {
    await apiClient.post('/api/users/fcm-token', {
      fcm_token: token,
    });
    console.log('[Notifications] FCM token registered for user with backend.');
  } catch (error: any) {
    console.warn('[Notifications] Failed to register user FCM token:', error.message);
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

    Alert.alert(
      title ?? 'New Notification',
      body ?? '',
      [{ text: 'OK', style: 'default' }],
      { cancelable: true }
    );

    handler?.(notification);
  });
}

// ── Background / killed-state tap listener ────────────────────────────────────

/**
 * Adds a listener for when the user taps a notification (background or killed state).
 * Deep-links to the appropriate screen based on the notification data payload.
 * Returns the subscription so the caller can remove it on unmount.
 */
export function addNotificationResponseListener(
  handler?: (response: Notifications.NotificationResponse) => void
): Notifications.EventSubscription {
  return Notifications.addNotificationResponseReceivedListener((response) => {
    console.log('[Notifications] Tapped:', response.notification.request.content.title);

    const data = (response.notification.request.content.data ?? {}) as Record<string, unknown>;
    const type = data.type as string | undefined;

    if (navigationRef?.isReady()) {
      if (type === 'subject_resource') {
        // Deep-link to the Notes & Resources screen inside the More stack
        // Navigate to the More tab first, then Resources screen
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (navigationRef as any).navigate('More', { screen: 'Resources' });
        } catch {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (navigationRef as any).navigate('More');
        }
      } else {
        // Default: navigate to Notifications screen inside the More tab
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (navigationRef as any).navigate('More', { screen: 'Notifications' });
      }
    }

    handler?.(response);
  });
}
