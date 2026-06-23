/**
 * recoverySchedulerHelpers.ts
 *
 * Pure date helpers extracted from cronRecovery.ts so they can be
 * unit-tested without importing the Express router or Supabase.
 */

/**
 * Returns the date of the last Monday in the given year/month.
 * month is 1-based (1 = January, 12 = December).
 */
export function getLastMondayOfMonth(year: number, month: number): Date {
  // day 0 of month+1 === last day of `month`
  const lastDay = new Date(year, month, 0);
  const dayOfWeek = lastDay.getDay(); // 0=Sun 1=Mon ... 6=Sat
  const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const lastMonday = new Date(lastDay);
  lastMonday.setDate(lastDay.getDate() - daysToSubtract);
  return lastMonday;
}

/**
 * Format a Date as YYYY-MM-DD (local, no timezone shift).
 */
export function toDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Subtract N days from a Date and return a new Date.
 */
export function subtractDays(d: Date, days: number): Date {
  const result = new Date(d);
  result.setDate(result.getDate() - days);
  return result;
}

/**
 * Calculate the recovery_pack_date: always 7 days before the scheduled test date.
 * If the resulting date is before today, clamp to today (immediate generation).
 *
 * @param testDate    The scheduled test date (Date object).
 * @param today       Today's date (for clamping). Defaults to new Date().
 * @returns           { recoveryPackDate, isImmediate }
 */
export function calculateRecoveryPackDate(
  testDate: Date,
  today: Date = new Date()
): { recoveryPackDate: Date; isImmediate: boolean } {
  const sevenDaysBefore = subtractDays(testDate, 7);

  // Normalise both to midnight for comparison
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const packMidnight  = new Date(
    sevenDaysBefore.getFullYear(),
    sevenDaysBefore.getMonth(),
    sevenDaysBefore.getDate()
  );

  if (packMidnight < todayMidnight) {
    // Pack date would be in the past — clamp to today (immediate generation)
    return { recoveryPackDate: todayMidnight, isImmediate: true };
  }

  return { recoveryPackDate: packMidnight, isImmediate: false };
}

/**
 * Calculate improvement percentage between two monthly scores.
 *
 * @param previousScore  Previous month's percentage (0–100), or null if first month.
 * @param currentScore   Current month's percentage (0–100).
 * @returns              Improvement percentage, or null if no previous data.
 */
export function calculateImprovementPercentage(
  previousScore: number | null,
  currentScore: number
): number | null {
  if (previousScore === null) return null;
  return Math.round((currentScore - previousScore) * 100) / 100;
}
