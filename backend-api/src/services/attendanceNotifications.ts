/**
 * attendanceNotifications.ts
 *
 * Background service that sends FCM push notifications + in-app notifications
 * to parents after attendance is submitted for a class.
 *
 * Called via setImmediate() from the attendance submit route so it never
 * blocks the HTTP response.
 */

import { sendPush, isFcmReady } from './fcmService';
import { supabaseAdmin } from '../config/supabase';
import { logAudit } from '../utils/audit';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AttendanceRecord {
  id: string;
  student_id: string;
  status: 'present' | 'absent';
}

interface StudentRow {
  id: string;
  full_name: string;
  parent_id: string | null;
}

interface ParentRow {
  id: string;
  fcm_token: string | null;
}

interface NotificationPayload {
  attendanceId: string;
  studentName: string;
  parentId: string;
  fcmToken: string | null;
  status: 'present' | 'absent';
  formattedDate: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format a YYYY-MM-DD date string as "DD MMM YYYY" (e.g. "29 May 2026"). */
function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${String(day).padStart(2, '0')} ${months[month - 1]} ${year}`;
}

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// ── Main export ───────────────────────────────────────────────────────────────

/**
 * sendAttendanceNotifications
 *
 * Fetches all unsent attendance records for the given class/section/date,
 * sends FCM push notifications to parents in batches of 100, inserts
 * in-app notification rows, and marks attendance records as notification_sent.
 *
 * Designed to be called fire-and-forget:
 *   setImmediate(() => sendAttendanceNotifications(school_id, className, section, date))
 */
export async function sendAttendanceNotifications(
  schoolId: string,
  className: string,
  section: string,
  date: string
): Promise<void> {
  const formattedDate = formatDate(date);
  let sentCount = 0;
  let failedCount = 0;

  try {
    // ── 1. Fetch unsent attendance records for this class/section/date ─────────
    const { data: studentIds, error: stuIdErr } = await supabaseAdmin
      .from('students')
      .select('id')
      .eq('school_id', schoolId)
      .eq('class_name', className)
      .eq('section', section)
      .eq('is_deleted', false);

    if (stuIdErr || !studentIds || studentIds.length === 0) {
      console.warn('[FCM] No students found for class/section:', { className, section });
      return;
    }

    const ids = studentIds.map((s: { id: string }) => s.id);

    const { data: attendanceRecords, error: attErr } = await supabaseAdmin
      .from('attendance')
      .select('id, student_id, status')
      .in('student_id', ids)
      .eq('date', date)
      .eq('notification_sent', false);

    if (attErr) {
      console.error('[FCM] Failed to fetch attendance records:', attErr.message);
      return;
    }

    if (!attendanceRecords || attendanceRecords.length === 0) {
      console.log('[FCM] No unsent attendance records found — skipping.');
      return;
    }

    const records = attendanceRecords as AttendanceRecord[];

    // ── 2. Fetch student details ───────────────────────────────────────────────
    const recordStudentIds = records.map((r) => r.student_id);

    const { data: students, error: stuErr } = await supabaseAdmin
      .from('students')
      .select('id, full_name, parent_id')
      .in('id', recordStudentIds)
      .eq('is_deleted', false);

    if (stuErr || !students) {
      console.error('[FCM] Failed to fetch student details:', stuErr?.message);
      return;
    }

    const studentMap = new Map<string, StudentRow>();
    for (const s of students as StudentRow[]) {
      studentMap.set(s.id, s);
    }

    // ── 3. Fetch parent FCM tokens ─────────────────────────────────────────────
    const parentIds = [
      ...new Set(
        (students as StudentRow[])
          .map((s) => s.parent_id)
          .filter((id): id is string => id !== null)
      ),
    ];

    const parentMap = new Map<string, ParentRow>();

    if (parentIds.length > 0) {
      const { data: parents, error: parErr } = await supabaseAdmin
        .from('users')
        .select('id, fcm_token')
        .in('id', parentIds);

      if (parErr) {
        console.error('[FCM] Failed to fetch parent FCM tokens:', parErr.message);
        // Continue — we can still insert in-app notifications
      } else {
        for (const p of (parents ?? []) as ParentRow[]) {
          parentMap.set(p.id, p);
        }
      }
    }

    // ── 4. Resolve a system sender_id for in-app notifications ────────────────
    // notifications.sender_id is NOT NULL — use a school admin as the system sender.
    const { data: adminUser } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('school_id', schoolId)
      .eq('role', 'schooladmin')
      .limit(1)
      .maybeSingle();

    const senderId: string | null = adminUser?.id ?? null;

    // ── 5. Build notification payloads ────────────────────────────────────────
    const payloads: NotificationPayload[] = [];

    for (const record of records) {
      const student = studentMap.get(record.student_id);
      if (!student) continue;
      if (!student.parent_id) {
        // No parent linked — insert in-app only (handled below with null fcmToken)
        payloads.push({
          attendanceId: record.id,
          studentName: student.full_name,
          parentId: '',          // sentinel: no parent
          fcmToken: null,
          status: record.status,
          formattedDate,
        });
        continue;
      }

      const parent = parentMap.get(student.parent_id);
      payloads.push({
        attendanceId: record.id,
        studentName: student.full_name,
        parentId: student.parent_id,
        fcmToken: parent?.fcm_token ?? null,
        status: record.status,
        formattedDate,
      });
    }

    // ── 6. Process in batches of 100 ──────────────────────────────────────────
    const BATCH_SIZE = 100;
    const BATCH_DELAY_MS = 100;

    const fcmEnabled = isFcmReady();

    for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
      const batch = payloads.slice(i, i + BATCH_SIZE);

      // Process each item in the batch concurrently within the batch
      await Promise.all(
        batch.map(async (payload) => {
          const { attendanceId, studentName, parentId, fcmToken, status, formattedDate: fd } = payload;

          // Build message text
          const title =
            status === 'absent' ? 'Attendance Alert' : 'Attendance Update';
          const body =
            status === 'absent'
              ? `Your child ${studentName} was marked absent on ${fd}.`
              : `Your child ${studentName} was present today.`;

          // 6a. Send FCM push notification (if token available and Firebase is configured)
          let fcmSuccess = false;
          if (fcmEnabled && fcmToken) {
            fcmSuccess = await sendPush(fcmToken, title, body);
            if (fcmSuccess) {
              sentCount++;
            } else {
              failedCount++;
              console.error(
                `[FCM] Push failed for student "${studentName}" (parent: ${parentId})`
              );
            }
          } else if (!fcmToken && parentId) {
            // Parent exists but has no FCM token — in-app only, not a failure
            console.log(
              `[FCM] No FCM token for parent ${parentId} — in-app notification only.`
            );
          }

          // 6b. Insert in-app notification (skip if no parent linked)
          if (parentId && senderId) {
            try {
              await supabaseAdmin.from('notifications').insert({
                title,
                body,
                type: 'attendance',
                recipient_id: parentId,
                sender_id: senderId,
                is_read: false,
                created_at: new Date().toISOString(),
              });
            } catch (notifErr) {
              console.error(
                `[FCM] Failed to insert in-app notification for parent ${parentId}:`,
                notifErr
              );
            }
          }

          // 6c. Mark attendance record as notification_sent = true
          try {
            await supabaseAdmin
              .from('attendance')
              .update({ notification_sent: true })
              .eq('id', attendanceId);
          } catch (updateErr) {
            console.error(
              `[FCM] Failed to mark notification_sent for attendance ${attendanceId}:`,
              updateErr
            );
          }
        })
      );

      // Wait between batches to avoid FCM throttling (skip after last batch)
      if (i + BATCH_SIZE < payloads.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    // ── 7. Audit log ──────────────────────────────────────────────────────────
    await logAudit(null, 'attendance_notifications_sent', 'attendance', {
      sent_count: sentCount,
      failed_count: failedCount,
      class: className,
      section,
      date,
      school_id: schoolId,
      total_processed: payloads.length,
    });

    console.log(
      `[FCM] Attendance notifications complete — sent: ${sentCount}, failed: ${failedCount}, total: ${payloads.length}`
    );
  } catch (err) {
    console.error('[FCM] Unexpected error in sendAttendanceNotifications:', err);

    // Best-effort audit log for the failure
    await logAudit(null, 'attendance_notifications_error', 'attendance', {
      class: className,
      section,
      date,
      school_id: schoolId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
