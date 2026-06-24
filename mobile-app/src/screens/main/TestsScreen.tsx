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
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import * as Haptics from 'expo-haptics';
import apiClient from '../../api/client';
import { MainStackParamList } from '../../navigation/AppNavigator';
import { toMinutes, formatHHMM, nowISTMinutes, nowIST } from '../../utils/dateUtils';

// ── Leaderboard types & component ────────────────────────────────────────────

interface LeaderboardEntry {
  rank: number;
  first_name: string;
  score: number;
  max_score: number;
  is_self: boolean;
}

function TestLeaderboard({ testId }: { testId: string }) {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get(`/api/tests/${testId}/leaderboard`)
      .then((res) => {
        if (cancelled) return;
        const data = res.data?.data?.leaderboard ?? [];
        setEntries(data);
      })
      .catch(() => {
        if (!cancelled) setError('unavailable');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [testId]);

  if (loading) {
    return (
      <View style={lbStyles.container}>
        <ActivityIndicator size="small" color="#F59E0B" />
      </View>
    );
  }

  // If error or no entries yet, don't render the section
  if (error || entries.length === 0) return null;

  const MEDALS = ['🥇', '🥈', '🥉'];

  return (
    <View style={lbStyles.container}>
      <TouchableOpacity
        style={lbStyles.header}
        onPress={() => setExpanded((v) => !v)}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Collapse leaderboard' : 'Expand leaderboard'}
      >
        <Text style={lbStyles.headerText}>🏆 Top 3 Leaderboard</Text>
        <Text style={lbStyles.chevron}>{expanded ? '▲' : '▼'}</Text>
      </TouchableOpacity>

      {expanded && (
        <View style={lbStyles.list}>
          {entries.map((entry) => {
            const pct = entry.max_score > 0
              ? Math.round((entry.score / entry.max_score) * 100)
              : 0;
            const medal = MEDALS[entry.rank - 1] ?? `#${entry.rank}`;
            return (
              <View
                key={entry.rank}
                style={[lbStyles.row, entry.is_self && lbStyles.rowSelf]}
              >
                <Text style={lbStyles.medal}>{medal}</Text>
                <Text style={[lbStyles.name, entry.is_self && lbStyles.nameSelf]} numberOfLines={1}>
                  {entry.first_name}{entry.is_self ? ' (You)' : ''}
                </Text>
                <View style={lbStyles.scoreWrap}>
                  <Text style={[lbStyles.score, entry.is_self && lbStyles.scoreSelf]}>
                    {entry.score}/{entry.max_score}
                  </Text>
                  <Text style={lbStyles.pct}>{pct}%</Text>
                </View>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const lbStyles = StyleSheet.create({
  container: {
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    marginTop: 2,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 9,
    backgroundColor: '#FFFBEB',
  },
  headerText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#92400E',
  },
  chevron: { fontSize: 11, color: '#92400E' },
  list: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    paddingTop: 4,
    backgroundColor: '#FFFBEB',
    gap: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  rowSelf: {
    borderColor: '#1D4ED8',
    backgroundColor: '#EFF6FF',
  },
  medal: { fontSize: 18, marginRight: 10, width: 26 },
  name: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
  },
  nameSelf: { color: '#1D4ED8' },
  scoreWrap: { alignItems: 'flex-end' },
  score: {
    fontSize: 13,
    fontWeight: '700',
    color: '#92400E',
  },
  scoreSelf: { color: '#1D4ED8' },
  pct: { fontSize: 10, color: '#9CA3AF', marginTop: 1 },
});

// ── Types ─────────────────────────────────────────────────────────────────────

interface TestRecord {
  id: string;
  title: string;
  subject_id: string;
  date: string;
  time_limit_minutes: number;
  question_count: number;
  attempt_status?: 'not_started' | 'in_progress' | 'completed';
  available_from?: string | null;
  available_until?: string | null;
  /** True when the teacher has blocked this student from the test */
  is_restricted?: boolean;
  /** True when the teacher has enabled web attempt for this test */
  allow_web_attempt?: boolean;
  /** Integrity score (0-100), present only if integrity was recorded */
  integrity_score?: number | null;
  integrity_exit_count?: number | null;
  integrity_exit_duration_seconds?: number | null;
}

interface TestsResponse {
  tests: TestRecord[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  // Handle plain YYYY-MM-DD (treat as local date to avoid timezone shift)
  const plainDate = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const d = plainDate
    ? (() => { const [y, m, day] = iso.split('-').map(Number); return new Date(y, m - 1, day); })()
    : new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const STATUS_CONFIG: Record<
  NonNullable<TestRecord['attempt_status']>,
  { label: string; color: string; bg: string }
> = {
  not_started: { label: 'Not Started', color: '#6B7280', bg: '#F3F4F6' },
  in_progress:  { label: 'In Progress', color: '#D97706', bg: '#FEF3C7' },
  completed:    { label: 'Completed',   color: '#15803D', bg: '#DCFCE7' },
};

// ── Countdown helpers ─────────────────────────────────────────────────────────

function secondsUntilHHMM(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const ist = nowIST();
  const nowMins = ist.getUTCHours() * 60 + ist.getUTCMinutes() + ist.getUTCSeconds() / 60;
  const diff = (toMinutes(hhmm) - nowMins) * 60;
  return diff > 0 ? Math.round(diff) : null;
}

/** Returns true if the current IST time is past the HH:MM window end time (handles overnight) */
function isWindowClosed(available_until: string | null | undefined, available_from?: string | null): boolean {
  if (!available_until) return false;
  const currentMins = nowISTMinutes();
  const untilMins = toMinutes(available_until);
  const fromMins = available_from ? toMinutes(available_from) : 0;
  const isOvernight = fromMins > untilMins;
  if (isOvernight) {
    // Window is closed only in the gap between until and from
    return currentMins > untilMins && currentMins < fromMins;
  }
  return currentMins > untilMins;
}

function formatCountdown(seconds: number): string {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
  }
  return `${seconds}s`;
}

// ── Test card ─────────────────────────────────────────────────────────────────

function TestCard({ test, onPress }: { test: TestRecord; onPress: () => void }) {
  const status = test.attempt_status ?? 'not_started';
  const config = STATUS_CONFIG[status];
  const isFeeRestricted = test.is_restricted === true;

  // Check if this is a past-dated test that was never started (missed)
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const testDay = parseLocalDate(test.date);
  const isMissed = testDay && testDay < todayStart && status === 'not_started';

  // Check if this is a future test (not yet available)
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  const isFuture = testDay ? testDay >= tomorrowStart : false;

  // Check if the time window has already closed (only relevant for today's not-started tests)
  const windowClosed = !isMissed && !isFuture && status === 'not_started' && isWindowClosed(test.available_until, test.available_from);

  // Leaderboard is shown when no one can attempt the test anymore:
  // - test date is in the past (any status), OR
  // - today's test window has already closed (status = not_started or completed)
  const showLeaderboard = Boolean(
    (testDay && testDay < todayStart) ||  // test date has passed
    (windowClosed)                        // today's window is over
  );

  return (
    <TouchableOpacity
      style={[
        styles.card,
        isFeeRestricted && styles.cardRestricted,
      ]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={`${test.title}. Status: ${isFeeRestricted ? 'Fee required' : config.label}.`}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <Text style={styles.testTitle} numberOfLines={2}>{test.title}</Text>
        </View>
        <View style={[styles.statusBadge, {
          backgroundColor: isFeeRestricted ? '#FEE2E2'
            : isMissed ? '#F3F4F6'
            : isFuture ? '#EFF6FF'
            : windowClosed ? '#FEF3C7'
            : config.bg,
        }]}>
          <Text style={[styles.statusText, {
            color: isFeeRestricted ? '#DC2626'
              : isMissed ? '#9CA3AF'
              : isFuture ? '#3B82F6'
              : windowClosed ? '#D97706'
              : config.color,
          }]}>
            {isFeeRestricted ? 'Locked'
              : isMissed ? 'Missed'
              : isFuture ? 'Upcoming'
              : windowClosed ? 'Closed'
              : config.label}
          </Text>
        </View>
      </View>

      {isFeeRestricted && (
        <View style={styles.restrictedBanner}>
          <Text style={styles.restrictedBannerText}>
            🔒 Pay your fees to unlock this test · Contact your teacher
          </Text>
        </View>
      )}

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
          <Text style={styles.metaValue}>{test.time_limit_minutes} min</Text>
        </View>
      </View>

      {!isFeeRestricted && (test.available_from || test.available_until) && (
        <View style={styles.windowRow}>
          <Text style={styles.windowText}>
            {(() => {
              const secs = secondsUntilHHMM(test.available_from);
              if (secs !== null) {
                return `🕐 Opens at ${formatHHMM(test.available_from!)} · in ${formatCountdown(secs)}`;
              }
              if (windowClosed) {
                return `🔴 Window closed at ${formatHHMM(test.available_until!)}`;
              }
              if (test.available_from && test.available_until) {
                return `🟢 Window: ${formatHHMM(test.available_from)} – ${formatHHMM(test.available_until)}`;
              }
              return `🕐 Window: ${test.available_from ?? '—'} – ${test.available_until ?? '—'}`;
            })()}
          </Text>
        </View>
      )}

      <View style={styles.ctaRow}>
        <Text style={[
          styles.ctaText,
          status === 'completed' && { color: '#15803D' },
          isFeeRestricted && { color: '#DC2626' },
          isMissed && { color: '#9CA3AF' },
          isFuture && { color: '#3B82F6' },
          windowClosed && { color: '#D97706' },
        ]}>
          {isFeeRestricted
            ? '🔒 Pay fees to unlock'
            : isMissed
            ? 'Not attempted'
            : isFuture
            ? `Scheduled for ${formatDate(test.date)}`
            : status === 'completed'
            ? 'View Results →'
            : status === 'in_progress'
            ? 'Continue Test →'
            : windowClosed
            ? 'Window Closed'
            : 'Start Test →'}
        </Text>
      </View>

      {/* Integrity score — shown only for completed tests where data exists */}
      {status === 'completed' && test.integrity_score !== null && test.integrity_score !== undefined && (
        <View style={styles.integrityRow}>
          <Text style={[
            styles.integrityScore,
            test.integrity_score >= 80
              ? styles.integrityGreen
              : test.integrity_score >= 60
              ? styles.integrityAmber
              : styles.integrityRed,
          ]}>
            Integrity: {test.integrity_score}/100
          </Text>
          <Text style={styles.integrityMeta}>
            Exits: {test.integrity_exit_count ?? 0} · Outside: {test.integrity_exit_duration_seconds ?? 0}s
          </Text>
        </View>
      )}

      {/* Leaderboard — shown only after the test window is closed / test date has passed */}
      {showLeaderboard && <TestLeaderboard testId={test.id} />}
    </TouchableOpacity>
  );
}

// ── Tab definitions ───────────────────────────────────────────────────────────

type TabKey = 'current' | 'upcoming' | 'completed';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'current',   label: 'Ongoing' },
  { key: 'upcoming',  label: 'Upcoming' },
  { key: 'completed', label: 'Completed' },
];

function parseLocalDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function filterTests(tests: TestRecord[], tab: TabKey): TestRecord[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  return tests.filter((t) => {
    const testDay = parseLocalDate(t.date);
    const isToday   = testDay ? testDay >= todayStart && testDay < tomorrowStart : false;
    const isFuture  = testDay ? testDay >= tomorrowStart : false;
    const isPast    = testDay ? testDay < todayStart : false;
    const status    = t.attempt_status ?? 'not_started';

    switch (tab) {
      case 'current':
        // Include in_progress from any date (resume support).
        if (status === 'in_progress') return true;
        // Today's tests that are not yet completed — but exclude ones whose
        // time window has already closed (student can't start them anymore).
        if (isToday && status !== 'completed') {
          // If available_until has passed, move to completed/missed bucket
          return !isWindowClosed(t.available_until, t.available_from);
        }
        return false;
      case 'upcoming':
        // Future-dated tests that haven't been started/completed
        return isFuture && status !== 'completed';
      case 'completed':
        // Completed tests, plus past-dated tests that were never started (missed),
        // PLUS today's window-closed not-started tests (student missed the window).
        return (
          status === 'completed' ||
          (isPast && status === 'not_started') ||
          (isToday && status === 'not_started' && isWindowClosed(t.available_until, t.available_from))
        );
      default:
        return true;
    }
  }).sort((a, b) => {
    const da = parseLocalDate(a.date);
    const db = parseLocalDate(b.date);
    return (db?.getTime() ?? 0) - (da?.getTime() ?? 0);
  });
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TestsScreen() {
  const [testsData, setTestsData] = useState<TestsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('current');
  // Tick every second so countdown timers on window banners stay live
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const navigation = useNavigation<StackNavigationProp<MainStackParamList>>();

  const fetchTests = useCallback(async () => {
    setError(null);
    try {
      const response = await apiClient.get('/api/tests/student');
      // Backend returns sendSuccess(res, payload) which wraps as { data: payload }.
      // Two possible shapes depending on backend version:
      //   Paginated:  response.data.data = { data: [...], total, limit, offset }
      //   Direct:     response.data.data = [...]
      const payload = response.data?.data;
      const tests: TestRecord[] = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.data)
          ? payload.data
          : [];
      setTestsData({ tests });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load tests');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchTests(); }, [fetchTests]);

  // Re-fetch when screen comes back into focus (e.g. after completing a test)
  // so attempt_status updates without needing a manual pull-to-refresh.
  useFocusEffect(
    useCallback(() => {
      fetchTests();
    }, [fetchTests])
  );
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    fetchTests();
  }, [fetchTests]);

  const handleTestPress = (test: TestRecord) => {
    if (test.is_restricted) {
      Alert.alert(
        'Test Locked',
        'Pay your fees to unlock this test. Please contact your teacher or school office.',
        [{ text: 'OK' }]
      );
      return;
    }

    // Date enforcement: only allow starting on the scheduled date.
    // Allow resuming in_progress tests from any date (crash/reconnect safety).
    if (test.attempt_status !== 'in_progress' && test.attempt_status !== 'completed') {
      // Use IST date to match backend enforcement — prevents blocking students
      // between midnight and 5:30 AM IST when UTC is still the previous day.
      const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
      const todayISO = istNow.toISOString().slice(0, 10);
      if (test.date && test.date !== todayISO) {
        const testDateFormatted = formatDate(test.date);
        if (test.date > todayISO) {
          Alert.alert(
            'Test Not Available Yet',
            `This test is scheduled for ${testDateFormatted}. You can only start it on that day.`,
            [{ text: 'OK' }]
          );
        } else {
          Alert.alert(
            'Test Expired',
            `This test was scheduled for ${testDateFormatted} and can no longer be started.`,
            [{ text: 'OK' }]
          );
        }
        return;
      }

  // Client-side overnight window enforcement (mirrors backend logic added in Bug 6 fix)
      if (test.available_from || test.available_until) {
        const currentMins = nowISTMinutes();
        const toMins = (hhmm: string) => {
          const [h, m] = hhmm.split(':').map(Number);
          return h * 60 + m;
        };
        if (test.available_from && currentMins < toMins(test.available_from)) {
          Alert.alert(
            'Test Not Open Yet',
            `This test opens at ${formatHHMM(test.available_from)}. Please come back then.`,
            [{ text: 'OK' }]
          );
          return;
        }
        if (test.available_until) {
          const untilMins = toMins(test.available_until);
          const fromMins = test.available_from ? toMins(test.available_from) : 0;
          const isOvernight = fromMins > untilMins;
          const windowClosed = isOvernight
            ? (currentMins > untilMins && currentMins < fromMins)
            : currentMins > untilMins;
          if (windowClosed) {
            Alert.alert(
              'Test Window Closed',
              `The test window closed at ${formatHHMM(test.available_until)}. You can no longer start this test.`,
              [{ text: 'OK' }]
            );
            return;
          }
        }
      }
    }

    navigation.navigate('TestAttempt', {
      test: {
        id: test.id,
        title: test.title,
        time_limit_minutes: test.time_limit_minutes ?? 0,
        question_count: test.question_count,
        attempt_status: test.attempt_status,
        allow_web_attempt: test.allow_web_attempt ?? false,
      },
    });
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1D4ED8" />
      </View>
    );
  }

  const allTests = testsData?.tests ?? [];
  const tabCounts: Record<TabKey, number> = {
    current:   filterTests(allTests, 'current').length,
    upcoming:  filterTests(allTests, 'upcoming').length,
    completed: filterTests(allTests, 'completed').length,
  };
  const visibleTests = filterTests(allTests, activeTab);

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.headerBox}>
          <Text style={styles.title}>Tests</Text>
        </View>

        {/* Tab bar */}
        <View style={styles.tabBar}>
          {TABS.map((tab) => {
            const isActive = activeTab === tab.key;
            const count = tabCounts[tab.key];
            return (
              <TouchableOpacity
                key={tab.key}
                style={[styles.tab, isActive && styles.tabActive]}
                onPress={() => setActiveTab(tab.key)}
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive }}
                accessibilityLabel={`${tab.label}, ${count} tests`}
              >
                <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
                  {tab.label}
                </Text>
                {count > 0 && (
                  <View style={[styles.tabCount, isActive && styles.tabCountActive]}>
                    <Text style={[styles.tabCountText, isActive && styles.tabCountTextActive]}>
                      {count}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* List */}
        <FlatList
          style={styles.list}
          contentContainerStyle={styles.content}
          data={visibleTests}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1D4ED8" />
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
                >
                  <Text style={styles.retryText}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.emptyState}>
                <Text style={styles.emptyIcon}>📝</Text>
                <Text style={styles.emptyText}>
                  {activeTab === 'current'
                    ? 'No ongoing tests right now.'
                    : activeTab === 'upcoming'
                    ? 'No upcoming tests.'
                    : 'No completed tests yet.'}
                </Text>
              </View>
            )
          }
        />
      </View>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  list: { flex: 1 },
  content: { padding: 16, paddingBottom: 48 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F9FAFB' },
  headerBox: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12 },
  title: { fontSize: 22, fontWeight: '700', color: '#111827' },

  // ── Tab bar ────────────────────────────────────────────────────────────────
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    paddingHorizontal: 16,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 10,
    marginRight: 4,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: '#1D4ED8',
  },
  tabLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6B7280',
  },
  tabLabelActive: {
    color: '#1D4ED8',
  },
  tabCount: {
    marginLeft: 6,
    backgroundColor: '#F3F4F6',
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  tabCountActive: {
    backgroundColor: '#DBEAFE',
  },
  tabCountText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6B7280',
  },
  tabCountTextActive: {
    color: '#1D4ED8',
  },

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
  cardRestricted: { borderLeftWidth: 4, borderLeftColor: '#DC2626', opacity: 0.9 },

  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: 16,
    paddingBottom: 12,
  },
  cardLeft: { flex: 1, marginRight: 12 },
  testTitle: { fontSize: 16, fontWeight: '700', color: '#111827' },
  statusBadge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, alignSelf: 'flex-start' },
  statusText: { fontSize: 12, fontWeight: '600' },

  restrictedBanner: {
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: '#FEE2E2',
  },
  restrictedBannerText: { fontSize: 12, fontWeight: '600', color: '#DC2626' },

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

  // Integrity score row (completed tests only)
  integrityRow: {
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    paddingVertical: 8,
    paddingHorizontal: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  integrityScore: { fontSize: 12, fontWeight: '700' },
  integrityGreen: { color: '#15803D' },
  integrityAmber: { color: '#D97706' },
  integrityRed:   { color: '#DC2626' },
  integrityMeta:  { fontSize: 11, color: '#9CA3AF' },

  windowRow: {
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    paddingVertical: 7,
    paddingHorizontal: 16,
  },
  windowText: { fontSize: 12, color: '#6B7280' },

  emptyState: { alignItems: 'center', marginTop: 60 },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyText: { fontSize: 15, color: '#9CA3AF', textAlign: 'center' },
  retryButton: {
    marginTop: 16,
    backgroundColor: '#1D4ED8',
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  retryText: { color: '#FFFFFF', fontWeight: '600', fontSize: 14 },
});
