/**
 * streak.unit.test.ts
 *
 * Unit tests for the streak update logic in streakService.ts.
 * All Supabase calls are mocked — no real database is used.
 *
 * Plain language: These tests verify that the daily streak counter works
 * correctly. A bug here means students lose their streaks unfairly or gain
 * streaks they didn't earn — destroying trust in the product.
 */

// ── Supabase mock ─────────────────────────────────────────────────────────────

const mockFrom = jest.fn();

jest.mock('../config/supabase', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

// ── FCM mock (fire-and-forget — non-critical) ─────────────────────────────────
jest.mock('../services/fcmService', () => ({
  checkAndSendStreakMilestone: jest.fn().mockResolvedValue(undefined),
  getTokensForStudents: jest.fn().mockResolvedValue([]),
  sendPushMulticast: jest.fn().mockResolvedValue({ successCount: 0, failureCount: 0 }),
}));

// ── Date utility mock ─────────────────────────────────────────────────────────
// We override these so tests are not tied to the real clock.

const mockGetTodayIST = jest.fn();
const mockGetYesterdayIST = jest.fn();

jest.mock('../utils/dateUtils', () => ({
  getTodayIST:     () => mockGetTodayIST(),
  getYesterdayIST: () => mockGetYesterdayIST(),
}));

// Import AFTER mocks are set up
import { updateStreak } from '../services/streakService';

// ── Helpers ───────────────────────────────────────────────────────────────────

const STUDENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TODAY      = '2026-06-23';
const YESTERDAY  = '2026-06-22';

/** Sets the mocked "today" and "yesterday" dates. */
function setDates(today: string, yesterday: string) {
  mockGetTodayIST.mockReturnValue(today);
  mockGetYesterdayIST.mockReturnValue(yesterday);
}

/**
 * Build a proper Supabase-style query chain mock.
 *
 * The real Supabase client's insert/update/delete calls return a thenable
 * (PromiseLike) that resolves to { data, error }.
 * buildQueryChain doesn't handle this for non-terminal calls, so we build
 * a proper mock here.
 */
function makeSupabaseChain(terminalResult: { data: unknown; error: unknown | null }) {
  const chain: Record<string, unknown> = {};

  // All chainable methods return `chain` so calls can be chained
  const passthrough = ['select', 'eq', 'neq', 'or', 'ilike', 'filter', 'order', 'limit', 'in', 'gte', 'lte', 'not', 'like'];
  for (const method of passthrough) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }

  // insert/update/delete return a THENABLE chain (resolves to terminalResult)
  // so that `await from(...).insert(...)` destructures { data, error } correctly
  for (const method of ['insert', 'update', 'delete', 'upsert']) {
    chain[method] = jest.fn().mockReturnValue({
      ...chain,
      // Make the result awaitable directly (for non-terminal awaits like `await from().insert()`)
      then: (resolve: (v: typeof terminalResult) => void) => resolve(terminalResult),
      catch: (_reject: unknown) => chain,
    });
  }

  // Terminal methods resolve to terminalResult
  chain['single'] = jest.fn().mockResolvedValue(terminalResult);
  chain['maybeSingle'] = jest.fn().mockResolvedValue(terminalResult);

  return chain;
}

/**
 * Set up mocks for the NORMAL (no conflict) flow.
 *
 * Call order inside updateStreak (happy path):
 *   1. from('streak_log').insert(...)          → { data: null, error: null }
 *   2. from('student_streaks').select(...).eq(...).maybeSingle()  → streakRow
 *   3. from('student_streaks').insert/update(...) → { data: null, error: null }
 */
function mockNormalFlow(streakRow: Record<string, unknown> | null) {
  let streakCallIndex = 0;

  mockFrom.mockImplementation((table: string) => {
    if (table === 'streak_log') {
      return makeSupabaseChain({ data: null, error: null });
    }

    if (table === 'student_streaks') {
      streakCallIndex++;
      if (streakCallIndex === 1) {
        // First call: SELECT — return existing row (or null for new student)
        return makeSupabaseChain({ data: streakRow, error: null });
      }
      // Second call: INSERT or UPDATE — succeed silently
      return makeSupabaseChain({ data: null, error: null });
    }

    return makeSupabaseChain({ data: null, error: null });
  });
}

/**
 * Set up mocks for the CONFLICT (23505) flow.
 *
 * Call order inside updateStreak on 23505:
 *   1. from('streak_log').insert(...)                              → { error: { code: '23505' } }
 *   2. from('streak_log').update(...).eq(...).neq(...).neq(...)    → success (result discarded)
 *   3. from('student_streaks').select(...).eq(...).maybeSingle()  → streakRow
 *   → returns already_counted_today: true
 */
function mockConflictFlow(streakRow: Record<string, unknown>) {
  let streakLogCallIndex = 0;

  mockFrom.mockImplementation((table: string) => {
    if (table === 'streak_log') {
      streakLogCallIndex++;
      if (streakLogCallIndex === 1) {
        // First call: INSERT — return unique constraint violation
        return makeSupabaseChain({
          data: null,
          error: { code: '23505', message: 'unique constraint violation' },
        });
      }
      // Second call: UPDATE (upgrade activity_type to 'both') — succeed silently
      return makeSupabaseChain({ data: null, error: null });
    }

    if (table === 'student_streaks') {
      // SELECT to read back the current streak (not modified)
      return makeSupabaseChain({ data: streakRow, error: null });
    }

    return makeSupabaseChain({ data: null, error: null });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Streak Logic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setDates(TODAY, YESTERDAY);
  });

  // ── TEST 2.1 ──────────────────────────────────────────────────────────────
  it('starts streak at 1 for a student with no prior streak history', async () => {
    mockNormalFlow(null);

    const result = await updateStreak(STUDENT_ID, 'test');

    expect(result.current_streak).toBe(1);
    expect(result.longest_streak).toBe(1);
    expect(result.total_active_days).toBe(1);
    expect(result.already_counted_today).toBe(false);
  });

  // ── TEST 2.2 ──────────────────────────────────────────────────────────────
  it('increments streak when last activity was yesterday (consecutive day)', async () => {
    mockNormalFlow({
      student_id: STUDENT_ID,
      current_streak: 5,
      longest_streak: 5,
      last_activity_date: YESTERDAY,
      total_active_days: 10,
    });

    const result = await updateStreak(STUDENT_ID, 'test');

    expect(result.current_streak).toBe(6);
    expect(result.longest_streak).toBe(6); // 6 > previous longest 5 → updated
    expect(result.total_active_days).toBe(11);
    expect(result.already_counted_today).toBe(false);
  });

  // ── TEST 2.3 ──────────────────────────────────────────────────────────────
  it('does not increment streak when activity already counted today (23505 conflict)', async () => {
    mockConflictFlow({
      student_id: STUDENT_ID,
      current_streak: 3,
      longest_streak: 7,
      last_activity_date: TODAY,
      total_active_days: 15,
    });

    const result = await updateStreak(STUDENT_ID, 'test');

    // Must not increment — already counted today
    expect(result.current_streak).toBe(3);
    expect(result.total_active_days).toBe(15);
    expect(result.already_counted_today).toBe(true);
  });

  // ── TEST 2.4 ──────────────────────────────────────────────────────────────
  it('resets current_streak to 1 when last activity was more than 1 day ago', async () => {
    const threeDaysAgo = '2026-06-20';

    mockNormalFlow({
      student_id: STUDENT_ID,
      current_streak: 10,
      longest_streak: 10,
      last_activity_date: threeDaysAgo,
      total_active_days: 30,
    });

    const result = await updateStreak(STUDENT_ID, 'test');

    expect(result.current_streak).toBe(1);     // reset — gap broke the streak
    expect(result.longest_streak).toBe(10);    // longest_streak preserved
    expect(result.total_active_days).toBe(31); // new active day still counted
    expect(result.already_counted_today).toBe(false);
  });

  // ── TEST 2.5 ──────────────────────────────────────────────────────────────
  it('preserves longest_streak when current streak breaks and restarts', async () => {
    const twoDaysAgo = '2026-06-21';

    mockNormalFlow({
      student_id: STUDENT_ID,
      current_streak: 5,
      longest_streak: 20,
      last_activity_date: twoDaysAgo,
      total_active_days: 50,
    });

    const result = await updateStreak(STUDENT_ID, 'test');

    expect(result.current_streak).toBe(1);  // reset after gap
    expect(result.longest_streak).toBe(20); // historical record unchanged
  });

  // ── TEST 2.6 ──────────────────────────────────────────────────────────────
  it('handles race condition: exactly one of two concurrent calls counts for today', async () => {
    // Simulate: first concurrent call's INSERT succeeds; second hits 23505.
    // Because JS is single-threaded, Promise.all runs both coroutines interleaved.
    // The mock uses a call counter to return success for call #1 and conflict for call #2.

    let streakLogInsertCount = 0;

    const existingRow = {
      student_id: STUDENT_ID,
      current_streak: 3,
      longest_streak: 7,
      last_activity_date: YESTERDAY,
      total_active_days: 15,
    };

    mockFrom.mockImplementation((table: string) => {
      if (table === 'streak_log') {
        // Count only INSERT calls (there's also an UPDATE call in the conflict path)
        streakLogInsertCount++;

        const isFirst = streakLogInsertCount === 1;
        const insertError = isFirst
          ? null
          : { code: '23505', message: 'unique constraint' };

        return makeSupabaseChain({ data: null, error: insertError });
      }

      if (table === 'student_streaks') {
        return makeSupabaseChain({ data: existingRow, error: null });
      }

      return makeSupabaseChain({ data: null, error: null });
    });

    const [first, second] = await Promise.all([
      updateStreak(STUDENT_ID, 'test'),
      updateStreak(STUDENT_ID, 'test'),
    ]);

    const countedCalls   = [first, second].filter((r) => !r.already_counted_today);
    const duplicateCalls = [first, second].filter((r) => r.already_counted_today);

    // Exactly one counts, one is a no-op
    expect(countedCalls.length).toBe(1);
    expect(duplicateCalls.length).toBe(1);

    // The duplicate must not modify the streak
    const duplicate = duplicateCalls[0];
    expect(duplicate.already_counted_today).toBe(true);

    // The successful call increments the streak (was 3, last = yesterday)
    const counted = countedCalls[0];
    expect(counted.current_streak).toBe(4);
    expect(counted.total_active_days).toBe(16);
    expect(counted.already_counted_today).toBe(false);
  });
});
