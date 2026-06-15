import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform, Alert } from 'react-native';
import { NavigationContainerRef } from '@react-navigation/native';
import { isRunningInExpoGo } from 'expo';

// ── Navigation ref ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export let navigationRef: NavigationContainerRef<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setNavigationRef(ref: NavigationContainerRef<any> | null) {
  navigationRef = ref;
}

// Lazy-load expo-notifications only in real builds (not Expo Go).
// Importing it in Expo Go crashes since SDK 53 removed remote push support.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getNotifications(): any | null {
  if (isRunningInExpoGo()) return null;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('expo-notifications');
}

// ── Foreground notification handler ──────────────────────────────────────────
// Only set up when running in a real dev/production build.
const Notifications = getNotifications();
if (Notifications) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

// ── Register for push notifications ──────────────────────────────────────────
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  const N = getNotifications();
  if (!N) {
    console.warn('[Notifications] Push notifications not supported in Expo Go.');
    return null;
  }

  if (!Device.isDevice) {
    console.warn('[Notifications] Push notifications require a physical device.');
    return null;
  }

  if (Platform.OS === 'android') {
    await N.setNotificationChannelAsync('default', {
      name: 'Eduvo',
      importance: N.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#1D4ED8',
    });
  }

  const { status: existingStatus } = await N.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await N.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.warn('[Notifications] Permission not granted.');
    return null;
  }

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId;

  if (!projectId) {
    console.warn('[Notifications] No EAS projectId found.');
    return null;
  }

  const { data: expoPushToken } = await N.getExpoPushTokenAsync({ projectId });
  return expoPushToken;
}

// ── Send FCM token to backend ─────────────────────────────────────────────────
export async function sendFcmTokenToBackend(
  studentId: string,
  token: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiClient: any
): Promise<void> {
  try {
    await apiClient.post('/api/users/fcm-token-student', {
      student_id: studentId,
      fcm_token: token,
    });
  } catch (error: any) {
    console.warn('[Notifications] Failed to register FCM token:', error.message);
  }
}

export async function sendFcmTokenToBackendForUser(
  token: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiClient: any
): Promise<void> {
  try {
    await apiClient.post('/api/users/fcm-token', { fcm_token: token });
  } catch (error: any) {
    console.warn('[Notifications] Failed to register user FCM token:', error.message);
  }
}

// ── Listeners ─────────────────────────────────────────────────────────────────
export function addNotificationReceivedListener(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler?: (notification: any) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const N = getNotifications();
  if (!N) return { remove: () => {} };

  return N.addNotificationReceivedListener((notification: any) => {
    const { title, body } = notification.request.content;
    Alert.alert(title ?? 'New Notification', body ?? '', [{ text: 'OK' }], { cancelable: true });
    handler?.(notification);
  });
}

export function addNotificationResponseListener(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler?: (response: any) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const N = getNotifications();
  if (!N) return { remove: () => {} };

  return N.addNotificationResponseReceivedListener((response: any) => {
    const data = (response.notification.request.content.data ?? {}) as Record<string, unknown>;
    const type = data.type as string | undefined;

    if (navigationRef?.isReady()) {
      if (type === 'subject_resource') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (navigationRef as any).navigate('More', { screen: 'Resources' });
        } catch {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (navigationRef as any).navigate('More');
        }
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (navigationRef as any).navigate('More', { screen: 'Notifications' });
      }
    }

    handler?.(response);
  });
}
