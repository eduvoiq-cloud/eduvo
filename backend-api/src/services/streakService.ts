/**
 * streakService.ts
 *
 * Centralised streak logic used by daily_tests and activity_packs routes.
 *
 *  - updateStreak(studentId, activityType)
 *      Called after a student completes a daily test (class 7-12) or
 *      a parent marks an activity_completion done (class 1-6).
 *
 * IST offset: UTC+5:30. "Today" is resolved in IST so students in India
 * never have their streak broken by a UTC midnight vs IST midnight mismatch.
 *
 * Simple streak rules:
 *   - last_activity_date = yesterday  → current_streak += 1
 *   - last_activity_date = today      → no change (already counted)
 *   - Otherwise (gap of 2+ days or null) → current_streak = 1
 *   - Update longest_streak if current_streak > longest_streak
 *   - Increment total_active_days on every new activity day
 */

import { supabaseAdmin } from '../config/supabase';
import { checkAndSendStreakMilestone } from './fcmService';
import { getTodayIST, getYesterdayIST } from '../utils/dateUtils';

// ── IST date helper ───────────────────────────────────────────────────────────

/**
 * Returns today's date string (YYYY-MM-DD) in IST (UTC+5:30).
 * Re-exported from dateUtils for backward compatibility.
 */
export function todayIST(): string {
  return getTodayIST();
}

/** Returns yesterday's date string (YYYY-MM-DD) in IST. */
function yesterdayIST(): string {
  return getYesterdayIST();
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type ActivityType = 'daily_test' | 'activity_pack' | 'test' | 'both';

export interface StreakResult {
  current_streak: number;
  longest_streak: number;
  total_active_days: number;
  already_counted_today: boolean;
}

// ── Core streak update ────────────────────────────────────────────────────────

/**
 * updateStreak — call this whenever a student completes a qualifying activity.
 *
 * @param studentId    The student's UUID
 * @param activityType 'test' | 'activity_pack' | 'daily_test' (legacy)
 * @returns            Updated streak info, or zeroed defaults on error.
 */
export async function updateStreak(
  studentId: string,
  activityType: 'daily_test' | 'activity_pack' | 'test'
): Promise<StreakResult> {
  const today = todayIST();
  const yesterday = yesterdayIST();

  try {
    // ── Step 1: Atomically insert today's streak_log entry ─────────────────
    // Using INSERT with ON CONFLICT DO NOTHING makes this race-condition safe.
    // If two completions arrive simultaneously, only one insert will succeed;
    // the second will hit the unique constraint (student_id, activity_date)
    // and return error code 23505 — which we use to short-circuit the update.
    const { error: logError } = await supabaseAdmin
      .from('streak_log')
      .insert({
        student_id: studentId,
        activity_date: today,
        activity_type: activityType,
      });

    if (logError) {
      if (logError.code === '23505') {
        // Unique conflict — this student+date was already logged (possibly by a
        // concurrent request). Attempt to upgrade single-type → 'both' if needed,
        // then return the current streak without double-incrementing anything.
        await supabaseAdmin
          .from('streak_log')
          .update({ activity_type: 'both' })
          .eq('student_id', studentId)
          .eq('activity_date', today)
          .neq('activity_type', 'both')
          .neq('activity_type', activityType);

        const { data: streakRow } = await supabaseAdmin
          .from('student_streaks')
          .select('current_streak, longest_streak, total_active_days')
          .eq('student_id', studentId)
          .maybeSingle();

        const row = (streakRow as Record<string, unknown> | null) ?? {};
        return {
          current_streak: (row.current_streak as number) ?? 0,
          longest_streak: (row.longest_streak as number) ?? 0,
          total_active_days: (row.total_active_days as number) ?? 0,
          already_counted_today: true,
        };
      }
      // Any other DB error — rethrow to be caught by the outer try/catch
      throw logError;
    }

    // ── Step 2: Fetch (or create) student_streaks row ───────────────────────
    const { data: streakRow } = await supabaseAdmin
      .from('student_streaks')
      .select('*')
      .eq('student_id', studentId)
      .maybeSingle();

    // Brand new student — first ever activity
    if (!streakRow) {
      await supabaseAdmin.from('student_streaks').insert({
        student_id: studentId,
        current_streak: 1,
        longest_streak: 1,
        last_activity_date: today,
        total_active_days: 1,
        updated_at: new Date().toISOString(),
      });
      return {
        current_streak: 1,
        longest_streak: 1,
        total_active_days: 1,
        already_counted_today: false,
      };
    }

    const row = streakRow as Record<string, unknown>;
    const lastDate = row.last_activity_date as string | null;
    const prevStreak = row.current_streak as number;
    const prevLongest = row.longest_streak as number;
    const prevTotalDays = row.total_active_days as number;

    // ── Step 3: Calculate new streak ───────────────────────────────────────
    //
    //   lastDate == today      → already counted (caught above by streak_log check)
    //   lastDate == yesterday  → consecutive day → increment
    //   otherwise              → gap of 2+ days, or null → reset to 1
    let newCurrent: number;

    if (lastDate === today) {
      // Defensive fallthrough — should be caught by streak_log check above
      newCurrent = prevStreak;
    } else if (lastDate === yesterday) {
      newCurrent = prevStreak + 1;
    } else {
      // Gap of 2+ days, or no prior history — reset streak
      newCurrent = 1;
    }

    const newLongest = Math.max(prevLongest, newCurrent);
    const newTotalDays = prevTotalDays + 1;

    // ── Step 4: Persist updated student_streaks ─────────────────────────────
    await supabaseAdmin
      .from('student_streaks')
      .update({
        current_streak: newCurrent,
        longest_streak: newLongest,
        last_activity_date: today,
        total_active_days: newTotalDays,
        updated_at: new Date().toISOString(),
      })
      .eq('student_id', studentId);

    return {
      current_streak: newCurrent,
      longest_streak: newLongest,
      total_active_days: newTotalDays,
      already_counted_today: false,
    };
  } catch (err) {
    console.error('[streakService] updateStreak error:', err);
    return {
      current_streak: 0,
      longest_streak: 0,
      total_active_days: 0,
      already_counted_today: false,
    };
  }
}

/**
 * updateStreakWithMilestone — convenience wrapper that also fires FCM milestone
 * notifications if the new streak hits a milestone (3, 7, 14, 30, 50, 100).
 *
 * @param studentId    The student's UUID
 * @param activityType 'daily_test' | 'activity_pack'
 * @param studentName  Used in the parent push notification text
 * @param parentId     Parent's user UUID (null = skip parent push)
 * @returns            Same as updateStreak()
 */
export async function updateStreakWithMilestone(
  studentId: string,
  activityType: 'daily_test' | 'activity_pack' | 'test',
  studentName: string,
  parentId: string | null
): Promise<StreakResult> {
  const result = await updateStreak(studentId, activityType);

  // Only check milestone if we actually incremented today
  if (!result.already_counted_today && result.current_streak > 0) {
    // Fire-and-forget — don't await, it's non-critical
    checkAndSendStreakMilestone(
      studentId,
      result.current_streak,
      studentName,
      parentId
    ).catch((err) => {
      console.error('[streakService] Milestone notification failed:', err);
    });
  }

  return result;
}
