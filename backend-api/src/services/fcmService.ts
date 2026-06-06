/**
 * fcmService.ts
 *
 * Shared Firebase Cloud Messaging helpers used by multiple routes/services.
 *
 * Firebase Admin is initialised exactly once. All other modules that need
 * FCM should import from here rather than calling firebase-admin directly,
 * so there is never a double-init conflict with admin.ts or
 * attendanceNotifications.ts (which also guards with `!admin.apps.length`).
 */

import * as admin from 'firebase-admin';
import { supabaseAdmin } from '../config/supabase';

// ── Firebase Admin initialisation ─────────────────────────────────────────────
// Guard against double-init (hot-reload, multiple imports, etc.)
if (!admin.apps.length) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  const isConfigured =
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    privateKey &&
    !privateKey.includes('YOUR_PRIVATE_KEY_HERE') &&
    privateKey.includes('BEGIN');

  if (!isConfigured) {
    console.warn(
      '[FCM] Firebase env vars missing or contain placeholder values. ' +
      'Push notifications will be skipped.'
    );
  } else {
    try {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId:   process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey,
        }),
      });
      console.log('[FCM] Firebase Admin initialised.');
    } catch (err) {
      console.warn(
        '[FCM] Firebase init failed — push notifications disabled:',
        err instanceof Error ? err.message : err
      );
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** True when Firebase Admin is available and ready to send messages. */
export function isFcmReady(): boolean {
  return admin.apps.length > 0;
}

/**
 * Token error codes that indicate a token is permanently invalid.
 * When we get one of these we should remove the token from the DB.
 */
const INVALID_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
  'messaging/invalid-argument',
]);

/**
 * Remove a single token from both storage locations (fcm_tokens table
 * and the fcm_token column on users / students).
 * Errors are swallowed — cleanup is best-effort.
 */
async function removeInvalidToken(token: string): Promise<void> {
  try {
    // Remove from dedicated fcm_tokens table
    await supabaseAdmin
      .from('fcm_tokens')
      .delete()
      .eq('token', token);

    // Clear from users.fcm_token
    await supabaseAdmin
      .from('users')
      .update({ fcm_token: null })
      .eq('fcm_token', token);

    // Clear from students.fcm_token (if column exists)
    await supabaseAdmin
      .from('students')
      .update({ fcm_token: null })
      .eq('fcm_token', token);

    console.log('[FCM] Removed invalid/expired token from database.');
  } catch (err) {
    console.error('[FCM] Failed to remove invalid token:', err);
  }
}

/**
 * Send a single FCM push notification to one device token.
 *
 * @returns `true` on success, `false` on failure.
 *          On a permanent token failure the token is removed from the DB.
 */
export async function sendPush(
  token: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<boolean> {
  if (!isFcmReady()) return false;

  try {
    await admin.messaging().send({
      token,
      notification: { title, body },
      data,
      android: { priority: 'high' },
      apns:    { payload: { aps: { sound: 'default' } } },
    });
    return true;
  } catch (err: unknown) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? (err as { code: string }).code
        : 'unknown';

    console.error(`[FCM] Send failed (${code}):`, err instanceof Error ? err.message : err);

    // Permanently bad token — clean it up
    if (INVALID_TOKEN_CODES.has(code)) {
      await removeInvalidToken(token);
    }

    return false;
  }
}

/**
 * Send a push notification to multiple device tokens (up to 500 per call).
 * Invalid tokens are automatically removed from the database.
 *
 * @returns Object with `successCount` and `failureCount`.
 */
export async function sendPushMulticast(
  tokens: string[],
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<{ successCount: number; failureCount: number }> {
  if (!isFcmReady() || tokens.length === 0) {
    return { successCount: 0, failureCount: 0 };
  }

  let successCount = 0;
  let failureCount = 0;

  // Firebase multicast supports max 500 tokens per call
  const CHUNK = 500;

  for (let i = 0; i < tokens.length; i += CHUNK) {
    const chunk = tokens.slice(i, i + CHUNK);

    const response = await admin.messaging().sendEachForMulticast({
      tokens: chunk,
      notification: { title, body },
      data,
      android: { priority: 'high' },
      apns:    { payload: { aps: { sound: 'default' } } },
    });

    successCount += response.successCount;
    failureCount += response.failureCount;

    // Remove permanently-invalid tokens
    const tokensToRemove: string[] = [];
    response.responses.forEach((resp, idx) => {
      if (!resp.success && resp.error) {
        const code = resp.error.code ?? '';
        if (INVALID_TOKEN_CODES.has(code)) {
          tokensToRemove.push(chunk[idx]);
        }
      }
    });

    if (tokensToRemove.length > 0) {
      await Promise.all(tokensToRemove.map(removeInvalidToken));
    }
  }

  return { successCount, failureCount };
}

/**
 * Fetch all FCM tokens for a list of student IDs.
 * Pulls from both the dedicated fcm_tokens table and the students.fcm_token
 * column so every storage path is covered.
 *
 * @returns Deduplicated list of token strings.
 */
export async function getTokensForStudents(studentIds: string[]): Promise<string[]> {
  if (studentIds.length === 0) return [];

  const tokenSet = new Set<string>();

  // 1. fcm_tokens table
  const { data: tableRows } = await supabaseAdmin
    .from('fcm_tokens')
    .select('token')
    .in('student_id', studentIds);

  for (const row of tableRows ?? []) {
    if (row.token) tokenSet.add(row.token);
  }

  // 2. students.fcm_token column (legacy / single-device path)
  const { data: studentRows } = await supabaseAdmin
    .from('students')
    .select('fcm_token')
    .in('id', studentIds)
    .not('fcm_token', 'is', null);

  for (const row of studentRows ?? []) {
    if (row.fcm_token) tokenSet.add(row.fcm_token);
  }

  return Array.from(tokenSet);
}

/**
 * Fetch all FCM tokens for a list of user IDs (staff / parents).
 * Pulls from both the dedicated fcm_tokens table and the users.fcm_token column.
 *
 * @returns Deduplicated list of token strings.
 */
export async function getTokensForUsers(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];

  const tokenSet = new Set<string>();

  // 1. fcm_tokens table
  const { data: tableRows } = await supabaseAdmin
    .from('fcm_tokens')
    .select('token')
    .in('user_id', userIds);

  for (const row of tableRows ?? []) {
    if (row.token) tokenSet.add(row.token);
  }

  // 2. users.fcm_token column (legacy / single-device path)
  const { data: userRows } = await supabaseAdmin
    .from('users')
    .select('fcm_token')
    .in('id', userIds)
    .not('fcm_token', 'is', null);

  for (const row of userRows ?? []) {
    if (row.fcm_token) tokenSet.add(row.fcm_token);
  }

  return Array.from(tokenSet);
}
