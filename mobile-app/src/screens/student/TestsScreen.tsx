import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  StatusBar,
  Alert,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import apiClient from '../../api/client';
import { StudentStackParamList } from '../../navigation/AppNavigator';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TestRecord {
  id: string;
  title: string;
  subject_id: string;
  date: string;
  time_limit_minutes: number;
  available_from: string | null;
  available_until: string | null;
  question_count: number;
  /** Attempt status derived from test_attempts — may not be present in initial list */
  attempt_status?: 'not_started' | 'in_progress' | 'completed';
  /** True when the teacher has blocked this student from the test */
  is_restricted?: boolean;
}

interface TestsResponse {
  tests: TestRecord[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = (iso && !iso.endsWith('Z') && !iso.includes('+') && !/\d{2}:\d{2}$/.test(iso))
    ? new Date(iso + 'Z') : new Date(iso);
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** True when the test date is strictly in the future (not today). */
function isUpcoming(dateStr: string): boolean {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const testDate = new Date(dateStr);
  const testStr = `${testDate.getFullYear()}-${pad(testDate.getMonth() + 1)}-${pad(testDate.getDate())}`;
  return testStr > todayStr;
}

/** Converts "HH:MM" to minutes-since-midnight for arithmetic comparison. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Returns the window state for the given test.
 *
 * Handles overnight windows (e.g. 23:00 – 00:30) where available_until is
 * numerically less than available_from.  In that case the window spans midnight
 * and the student can open the test on the test date after available_from OR on
 * the following day before available_until.
 */
function getWindowState(
  date: string,
  availableFrom: string | null,
  availableUntil: string | null
): 'before' | 'open' | 'closed' | 'no_window' {
  if (!availableFrom && !availableUntil) return 'no_window';
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  // Split the YYYY-MM-DD string directly — never use new Date('YYYY-MM-DD') because
  // JS parses bare date strings as UTC midnight, which gives the wrong local date for
  // timezones behind UTC.
  const [y, m, d] = date.split('-');
  const testDateStr = `${y}-${m}-${d}`;

  // For overnight windows the "until" part falls on the next calendar day.
  // Build the next-day string so we can check it too.
  const testDateObj = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
  const nextDay = new Date(testDateObj);
  nextDay.setDate(nextDay.getDate() + 1);
  const nextDayStr = `${nextDay.getFullYear()}-${pad(nextDay.getMonth() + 1)}-${pad(nextDay.getDate())}`;

  const isTestDate = todayStr === testDateStr;
  const isNextDay  = todayStr === nextDayStr;

  const nowHHMM = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const nowMins  = toMinutes(nowHHMM);

  // Determine if this is an overnight window: until < from (e.g. 23:00 → 00:30)
  const fromMins  = availableFrom  ? toMinutes(availableFrom)  : null;
  const untilMins = availableUntil ? toMinutes(availableUntil) : null;
  const isOvernight = fromMins !== null && untilMins !== null && untilMins < fromMins;

  if (isOvernight) {
    // On the test date: before the open time → 'before'; from open time onward → 'open'
    if (isTestDate) {
      if (fromMins !== null && nowMins < fromMins) return 'before';
      return 'open';
    }
    // On the next calendar day: still within the until time → 'open'; past it → 'closed'
    if (isNextDay) {
      if (untilMins !== null && nowMins <= untilMins) return 'open';
      return 'closed';
    }
    return 'no_window';
  }

  // Normal (same-day) window
  if (!isTestDate) return 'no_window';

  if (availableFrom && nowMins < toMinutes(availableFrom)) return 'before';
  // If until == from the teacher accidentally set a zero-duration window — treat as
  // no close time so students aren't locked out immediately.
  const effectiveUntil = (availableUntil && availableUntil !== availableFrom) ? availableUntil : null;
  if (effectiveUntil && nowMins > toMinutes(effectiveUntil)) return 'closed';
  return 'open';
}

function formatHHMM(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(':');
  const h = parseInt(hStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${mStr} ${ampm}`;
}

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  NonNullable<TestRecord['attempt_status']>,
  { label: string; color: string; bg: string }
> = {
  not_started: { label: 'Not Started', color: '#6B7280', bg: '#F3F4F6' },
  in_progress:  { label: 'In Progress', color: '#D97706', bg: '#FEF3C7' },
  completed:    { label: 'Completed',   color: '#15803D', bg: '#DCFCE7' },
};

// ── Test card ─────────────────────────────────────────────────────────────────

function TestCard({
  test,
  onPress,
}: {
  test: TestRecord;
  onPress: () => void;
}) {
  const status = test.attempt_status ?? 'not_started';
  const config = STATUS_CONFIG[status];
  const upcoming = isUpcoming(test.date);
  const windowState = getWindowState(test.date, test.available_from, test.available_until);
  const hasWindow = test.available_from || test.available_until;
  // A test is locked if it's a future date OR before the window opens
  const isLocked = (upcoming || windowState === 'before') && status === 'not_started';
  const isClosed = windowState === 'closed' && status === 'not_started';
  const isFeeRestricted = test.is_restricted === true;

  return (
    <TouchableOpacity
      style={[
        styles.card,
        upcoming && styles.cardUpcoming,
        isClosed && styles.cardClosed,
        isFeeRestricted && styles.cardRestricted,
      ]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={`${test.title} test. Status: ${isFeeRestricted ? 'Fee required' : config.label}. Tap to open.`}
    >
      {/* Header row */}
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <Text style={styles.testTitle} numberOfLines={2}>
            {test.title}
          </Text>
          {isFeeRestricted ? (
            <View style={[styles.upcomingBadge, { backgroundColor: '#FEE2E2' }]}>
              <Text style={[styles.upcomingText, { color: '#DC2626' }]}>🔒 Fee Required</Text>
            </View>
          ) : upcoming ? (
            <View style={styles.upcomingBadge}>
              <Text style={styles.upcomingText}>Upcoming</Text>
            </View>
          ) : null}
        </View>
        <View style={[styles.statusBadge, { backgroundColor: isFeeRestricted ? '#FEE2E2' : config.bg }]}>
          <Text style={[styles.statusText, { color: isFeeRestricted ? '#DC2626' : config.color }]}>
            {isFeeRestricted ? 'Locked' : config.label}
          </Text>
        </View>
      </View>

      {/* Fee restriction banner */}
      {isFeeRestricted && (
        <View style={[styles.windowBanner, styles.windowBannerClosed]}>
          <Text style={[styles.windowBannerText, styles.windowBannerTextClosed]}>
            🔒 Pay your fees to unlock this test · Contact your teacher
          </Text>
        </View>
      )}

      {/* Time window banner — show on test date; also show on upcoming dates */}
      {!isFeeRestricted && upcoming && status === 'not_started' && (
        <View style={[styles.windowBanner, styles.windowBannerBefore]}>
          <Text style={[styles.windowBannerText, styles.windowBannerTextBefore]}>
            🔒 Available on {formatDate(test.date)}
            {test.available_from ? ` at ${formatHHMM(test.available_from)}` : ''}
          </Text>
        </View>
      )}
      {!isFeeRestricted && !upcoming && hasWindow && status !== 'completed' && (
        <View style={[
          styles.windowBanner,
          windowState === 'open' && styles.windowBannerOpen,
          windowState === 'closed' && styles.windowBannerClosed,
          windowState === 'before' && styles.windowBannerBefore,
        ]}>
          <Text style={[
            styles.windowBannerText,
            windowState === 'open' && styles.windowBannerTextOpen,
            windowState === 'closed' && styles.windowBannerTextClosed,
            windowState === 'before' && styles.windowBannerTextBefore,
          ]}>
            {windowState === 'open'
              ? `🟢 Window open${test.available_until ? ` · closes at ${formatHHMM(test.available_until)}` : ''}`
              : windowState === 'before'
              ? `🕐 Opens at ${formatHHMM(test.available_from!)}${test.available_until ? ` · closes ${formatHHMM(test.available_until)}` : ''}`
              : windowState === 'closed'
              ? '🔴 Test window closed · Unattempted'
              : `⏰ ${test.available_from ? formatHHMM(test.available_from) : ''}${test.available_from && test.available_until ? ' – ' : ''}${test.available_until ? formatHHMM(test.available_until) : ''}`
            }
          </Text>
        </View>
      )}

      {/* Meta row */}
      <View style={styles.metaRow}>
        <View style={styles.metaItem}>
          <Text style={styles.metaLabel}>DATE</Text>
          <Text style={styles.metaValue}>{formatDate(test.date)}</Text>
        </View>
        <View style={styles.metaDivider} />
        <View style={styles.metaItem}>
          <Text style={styles.metaLabel}>QUESTIONS</Text>
          <Text style={styles.metaValue}>{test.question_count}</Text>
        </View>
        <View style={styles.metaDivider} />
        <View style={styles.metaItem}>
          <Text style={styles.metaLabel}>TIME LIMIT</Text>
          <Text style={styles.metaValue}>{test.time_limit_minutes > 0 ? `${test.time_limit_minutes} min` : '—'}</Text>
        </View>
      </View>

      {/* CTA */}
      <View style={styles.ctaRow}>
        <Text style={[
          styles.ctaText,
          status === 'completed' && styles.ctaTextCompleted,
          (isLocked || isClosed) && !isFeeRestricted && styles.ctaTextLocked,
          isFeeRestricted && styles.ctaTextRestricted,
        ]}>
          {isFeeRestricted
            ? '🔒 Pay fees to unlock'
            : status === 'completed'
            ? 'View Results →'
            : status === 'in_progress'
            ? 'Continue Test →'
            : isClosed
            ? '🔴 Window Closed'
            : isLocked
            ? '🔒 Locked'
            : 'Start Test →'}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function StudentTestsScreen() {
  const [testsData, setTestsData] = useState<TestsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tick every 30 s so window-state banners (before / open / closed) update
  // automatically without the student having to pull-to-refresh.
  const [, setTick] = useState(0);

  const navigation = useNavigation<StackNavigationProp<StudentStackParamList>>();

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const fetchTests = useCallback(async () => {
    setError(null);
    try {
      const response = await apiClient.get('/api/tests/student');
      const payload = response.data;

      const tests: TestRecord[] = payload.data ?? [];

      setTestsData({ tests });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load tests';
      console.warn('[StudentTests] fetchTests error:', msg);
      setError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchTests(); }, [fetchTests]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchTests();
  }, [fetchTests]);

  const handleTestPress = (test: TestRecord) => {
    const windowState = getWindowState(test.date, test.available_from, test.available_until);
    const status = test.attempt_status ?? 'not_started';
    const upcoming = isUpcoming(test.date);

    // Fee-restricted — show message, do not allow access
    if (test.is_restricted) {
      Alert.alert(
        'Test Locked',
        'Pay your fees to unlock this test. Please contact your teacher or school office.',
        [{ text: 'OK' }]
      );
      return;
    }

    // Test date is in the future — block entirely regardless of window
    if (upcoming && status === 'not_started') {
      Alert.alert(
        'Test Not Available Yet',
        `This test is scheduled for ${formatDate(test.date)}. It will be available on that date.`,
        [{ text: 'OK' }]
      );
      return;
    }

    // Block access when the window is closed and the student hasn't started yet.
    // Students who have an in-progress or completed attempt are always allowed through.
    if (windowState === 'closed' && status === 'not_started') {
      Alert.alert(
        'Test Window Closed',
        'The time window for this test has passed. You can no longer attempt it.',
        [{ text: 'OK' }]
      );
      return;
    }

    // Block access before the window opens (unless already started)
    if (windowState === 'before' && status === 'not_started') {
      Alert.alert(
        'Test Not Yet Open',
        test.available_from
          ? `This test opens at ${formatHHMM(test.available_from)}. Please come back then.`
          : 'This test is not open yet.',
        [{ text: 'OK' }]
      );
      return;
    }

    navigation.navigate('TestAttempt', {
      test: {
        id: test.id,
        title: test.title,
        time_limit_minutes: test.time_limit_minutes ?? 0,
        question_count: test.question_count,
        attempt_status: test.attempt_status,
        available_from: test.available_from ?? null,
        available_until: test.available_until ?? null,
      },
    });
  };

  // ── Loading ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1D4ED8" />
      </View>
    );
  }

  // ── Tests list ──────────────────────────────────────────────────────────────
  const tests = testsData?.tests ?? [];

  // Sort: upcoming first, then by date descending
  const sortedTests = [...tests].sort((a, b) => {
    const aUp = isUpcoming(a.date);
    const bUp = isUpcoming(b.date);
    if (aUp && !bUp) return -1;
    if (!aUp && bUp) return 1;
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });

  const notStarted = sortedTests.filter((t) => (t.attempt_status ?? 'not_started') === 'not_started').length;
  const inProgress = sortedTests.filter((t) => t.attempt_status === 'in_progress').length;
  const completed  = sortedTests.filter((t) => t.attempt_status === 'completed').length;

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <FlatList
        style={styles.container}
        contentContainerStyle={styles.content}
        data={sortedTests}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1D4ED8" />
        }
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <Text style={styles.title}>Tests</Text>

            {/* Summary chips */}
            {sortedTests.length > 0 && (
              <View style={styles.summaryRow}>
                {notStarted > 0 && (
                  <View style={[styles.summaryChip, { backgroundColor: '#F3F4F6' }]}>
                    <Text style={[styles.summaryChipText, { color: '#6B7280' }]}>
                      {notStarted} Not Started
                    </Text>
                  </View>
                )}
                {inProgress > 0 && (
                  <View style={[styles.summaryChip, { backgroundColor: '#FEF3C7' }]}>
                    <Text style={[styles.summaryChipText, { color: '#D97706' }]}>
                      {inProgress} In Progress
                    </Text>
                  </View>
                )}
                {completed > 0 && (
                  <View style={[styles.summaryChip, { backgroundColor: '#DCFCE7' }]}>
                    <Text style={[styles.summaryChipText, { color: '#15803D' }]}>
                      {completed} Completed
                    </Text>
                  </View>
                )}
              </View>
            )}
          </View>
        }
        renderItem={({ item }) => (
          <TestCard test={item} onPress={() => handleTestPress(item)} />
        )}
        ListEmptyComponent={
          error ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>⚠️ {error}</Text>
              <TouchableOpacity
                style={styles.retryButton}
                onPress={() => { setLoading(true); fetchTests(); }}
                accessibilityRole="button"
                accessibilityLabel="Retry loading tests"
              >
                <Text style={styles.retryText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>📝</Text>
              <Text style={styles.emptyText}>No tests available right now.</Text>
              <Text style={styles.emptySubtext}>
                Check back later or contact your teacher.
              </Text>
            </View>
          )
        }
      />
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { padding: 20, paddingBottom: 48 },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
  },

  listHeader: { marginBottom: 16 },
  title: { fontSize: 22, fontWeight: '700', color: '#111827', marginBottom: 10 },
  summaryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  summaryChip: {
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  summaryChipText: { fontSize: 12, fontWeight: '600' },

  // Test card
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 5,
    elevation: 2,
    overflow: 'hidden',
  },
  cardUpcoming: {
    borderLeftWidth: 4,
    borderLeftColor: '#1D4ED8',
  },
  cardClosed: {
    opacity: 0.75,
    borderLeftWidth: 4,
    borderLeftColor: '#DC2626',
  },
  cardRestricted: {
    borderLeftWidth: 4,
    borderLeftColor: '#DC2626',
    opacity: 0.9,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: 16,
    paddingBottom: 12,
  },
  cardLeft: { flex: 1, marginRight: 12 },
  testTitle: { fontSize: 16, fontWeight: '700', color: '#111827' },
  upcomingBadge: {
    marginTop: 6,
    alignSelf: 'flex-start',
    backgroundColor: '#DBEAFE',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  upcomingText: { fontSize: 11, fontWeight: '600', color: '#1D4ED8' },
  statusBadge: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    alignSelf: 'flex-start',
  },
  statusText: { fontSize: 12, fontWeight: '600' },

  metaRow: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  metaItem: { flex: 1 },
  metaLabel: {
    fontSize: 10,
    color: '#9CA3AF',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 3,
  },
  metaValue: { fontSize: 13, fontWeight: '600', color: '#374151' },
  metaDivider: { width: 1, backgroundColor: '#F3F4F6', marginVertical: 2, marginHorizontal: 8 },

  ctaRow: {
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'flex-end',
  },
  ctaText: { fontSize: 13, fontWeight: '600', color: '#1D4ED8' },
  ctaTextCompleted: { color: '#15803D' },
  ctaTextLocked: { color: '#9CA3AF' },
  ctaTextRestricted: { color: '#DC2626' },

  // Window banner
  windowBanner: {
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: '#F3F4F6',
  },
  windowBannerOpen: { backgroundColor: '#DCFCE7' },
  windowBannerClosed: { backgroundColor: '#FEE2E2' },
  windowBannerBefore: { backgroundColor: '#FEF3C7' },
  windowBannerText: { fontSize: 12, fontWeight: '600', color: '#6B7280' },
  windowBannerTextOpen: { color: '#15803D' },
  windowBannerTextClosed: { color: '#DC2626' },
  windowBannerTextBefore: { color: '#D97706' },

  // Empty / error
  emptyState: { alignItems: 'center', marginTop: 60 },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyText: { fontSize: 15, color: '#9CA3AF', textAlign: 'center' },
  emptySubtext: { fontSize: 13, color: '#D1D5DB', marginTop: 6, textAlign: 'center' },
  retryButton: {
    marginTop: 16,
    backgroundColor: '#1D4ED8',
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  retryText: { color: '#FFFFFF', fontWeight: '600', fontSize: 14 },
});
