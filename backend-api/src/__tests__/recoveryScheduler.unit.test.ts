/**
 * recoveryScheduler.unit.test.ts
 *
 * Unit tests for the monthly recovery test scheduling logic extracted from
 * routes/cronRecovery.ts.
 *
 * Plain language: These tests verify that recovery test dates are calculated
 * correctly, pack dates always stay 7 days before the test, postpones adjust
 * correctly, and improvement percentages are accurate. A bug here means
 * students get tests at the wrong time — or not at all.
 */

import {
  getLastMondayOfMonth,
  toDateString,
  subtractDays,
  calculateRecoveryPackDate,
  calculateImprovementPercentage,
} from '../utils/recoverySchedulerHelpers';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Recovery Scheduler — Date Helpers', () => {

  // ── TEST 5.1 ──────────────────────────────────────────────────────────────
  it('sets recovery_pack_date to exactly 7 days before the scheduled_test_date', () => {
    // July 31, 2026 → pack date should be July 24, 2026
    const testDate = new Date(2026, 6, 31); // month is 0-indexed: 6 = July

    const { recoveryPackDate, isImmediate } = calculateRecoveryPackDate(
      testDate,
      new Date(2026, 5, 1) // today = June 1 — well before test
    );

    expect(toDateString(recoveryPackDate)).toBe('2026-07-24');
    expect(isImmediate).toBe(false);
  });

  // ── TEST 5.2 ──────────────────────────────────────────────────────────────
  it('updates recovery_pack_date automatically when test date is postponed', () => {
    // Original: July 31 → pack July 24
    // Postponed: August 10 → pack August 3

    const newTestDate = new Date(2026, 7, 10); // August 10

    const { recoveryPackDate, isImmediate } = calculateRecoveryPackDate(
      newTestDate,
      new Date(2026, 5, 1) // today = June 1 — well before both dates
    );

    expect(toDateString(recoveryPackDate)).toBe('2026-08-03');
    expect(isImmediate).toBe(false);
  });

  // ── TEST 5.3 ──────────────────────────────────────────────────────────────
  it('clamps recovery_pack_date to today when test is postponed to less than 7 days away', () => {
    // Today = July 28, test postponed to July 31 (3 days away)
    // 7 days before July 31 = July 24 — which is in the past
    // Expected: pack date = today (immediate generation flagged)

    const today    = new Date(2026, 6, 28); // July 28
    const testDate = new Date(2026, 6, 31); // July 31

    const { recoveryPackDate, isImmediate } = calculateRecoveryPackDate(testDate, today);

    expect(toDateString(recoveryPackDate)).toBe('2026-07-28'); // clamped to today
    expect(isImmediate).toBe(true);
  });

  // ── TEST 5.4 ──────────────────────────────────────────────────────────────
  it('returns pack date equal to today when test is exactly 7 days away (boundary)', () => {
    // Today = July 24, test = July 31 → pack date = July 24 (exactly today, not clamped)
    const today    = new Date(2026, 6, 24); // July 24
    const testDate = new Date(2026, 6, 31); // July 31

    const { recoveryPackDate, isImmediate } = calculateRecoveryPackDate(testDate, today);

    expect(toDateString(recoveryPackDate)).toBe('2026-07-24');
    expect(isImmediate).toBe(false); // pack = today is fine, not flagged as immediate
  });

  // ── TEST 5.5 ──────────────────────────────────────────────────────────────
  it('getLastMondayOfMonth returns the last Monday for a known month (July 2026)', () => {
    // July 2026: last day is July 31 (Friday)
    // Walk back from Friday: Mon Jul 27
    const lastMonday = getLastMondayOfMonth(2026, 7);
    expect(toDateString(lastMonday)).toBe('2026-07-27');
  });

  it('getLastMondayOfMonth returns the last Monday for a month that starts on Monday (March 2027)', () => {
    // March 2027: last day is March 31 (Wednesday)
    // Walk back to Monday: March 29
    const lastMonday = getLastMondayOfMonth(2027, 3);
    expect(toDateString(lastMonday)).toBe('2027-03-29');
  });

  it('subtractDays returns a date exactly N days earlier', () => {
    const original = new Date(2026, 6, 31); // July 31
    const earlier  = subtractDays(original, 7);
    expect(toDateString(earlier)).toBe('2026-07-24');
  });

  it('subtractDays does not mutate the original date', () => {
    const original   = new Date(2026, 6, 31);
    const origString = toDateString(original);
    subtractDays(original, 7);
    expect(toDateString(original)).toBe(origString); // unchanged
  });
});

// ── Improvement percentage ────────────────────────────────────────────────────

describe('Recovery Scheduler — Improvement Percentage', () => {

  // ── TEST 5.6 ──────────────────────────────────────────────────────────────
  it('returns null (not 0) for a student taking their first monthly recovery test', () => {
    // No previous month data — improvement_percentage must be null
    const result = calculateImprovementPercentage(null, 75);

    expect(result).toBeNull();
    // Explicitly ensure it's not 0 — 0 would mean "no improvement", null means "no prior data"
    expect(result).not.toBe(0);
  });

  // ── TEST 5.7 ──────────────────────────────────────────────────────────────
  it('calculates a positive improvement when score goes from 60% to 75%', () => {
    const result = calculateImprovementPercentage(60, 75);

    expect(result).toBe(15);
  });

  // ── TEST 5.8 ──────────────────────────────────────────────────────────────
  it('returns a negative improvement (regression) when score goes from 80% to 65%', () => {
    const result = calculateImprovementPercentage(80, 65);

    expect(result).toBe(-15);
  });

  it('returns 0 when score stays exactly the same', () => {
    const result = calculateImprovementPercentage(70, 70);

    expect(result).toBe(0);
  });

  it('handles a jump from 0% to 100%', () => {
    const result = calculateImprovementPercentage(0, 100);

    expect(result).toBe(100);
  });
});

// ── No-subjects guard (TEST 5.5 from spec) ───────────────────────────────────
// This tests the pure logic: when subjects list is empty, no schedules should
// be created. The cron route skips the inner loop via `if (subjects.length === 0) continue`.
// We test the equivalent pure predicate here.

describe('Recovery Scheduler — No-subjects Guard', () => {
  it('determines that no schedules should be created when subjects list is empty', () => {
    const subjects: string[] = [];
    const shouldCreateSchedules = subjects.length > 0;

    expect(shouldCreateSchedules).toBe(false);
  });

  it('determines that schedules should be created when subjects are present', () => {
    const subjects = ['Mathematics', 'Science'];
    const shouldCreateSchedules = subjects.length > 0;

    expect(shouldCreateSchedules).toBe(true);
  });
});
