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
import { MainStackParamList } from '../../navigation/AppNavigator';

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
}

interface TestsResponse {
  tests: TestRecord[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
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

// ── Test card ─────────────────────────────────────────────────────────────────

function TestCard({ test, onPress }: { test: TestRecord; onPress: () => void }) {
  const status = test.attempt_status ?? 'not_started';
  const config = STATUS_CONFIG[status];
  const isFeeRestricted = test.is_restricted === true;

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
        <View style={[styles.statusBadge, { backgroundColor: isFeeRestricted ? '#FEE2E2' : config.bg }]}>
          <Text style={[styles.statusText, { color: isFeeRestricted ? '#DC2626' : config.color }]}>
            {isFeeRestricted ? 'Locked' : config.label}
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
            🕐 {test.available_from ?? '—'} – {test.available_until ?? '—'}
          </Text>
        </View>
      )}

      <View style={styles.ctaRow}>
        <Text style={[
          styles.ctaText,
          status === 'completed' && { color: '#15803D' },
          isFeeRestricted && { color: '#DC2626' },
        ]}>
          {isFeeRestricted
            ? '🔒 Pay fees to unlock'
            : status === 'completed'
            ? 'View Results →'
            : status === 'in_progress'
            ? 'Continue Test →'
            : 'Start Test →'}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

// ── Tab definitions ───────────────────────────────────────────────────────────

type TabKey = 'not_attempted' | 'attempted' | 'upcoming';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'not_attempted', label: 'Not Attempted' },
  { key: 'attempted',     label: 'Attempted' },
  { key: 'upcoming',      label: 'Upcoming' },
];

function filterTests(tests: TestRecord[], tab: TabKey): TestRecord[] {
  const now = new Date();
  // Strip time so "today" counts as today not upcoming
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  return tests.filter((t) => {
    const testDate = new Date(t.date);
    const testDay = new Date(testDate.getFullYear(), testDate.getMonth(), testDate.getDate());
    const isFuture = testDay > todayStart;
    const status = t.attempt_status ?? 'not_started';

    switch (tab) {
      case 'upcoming':
        // Future-dated tests that haven't been completed
        return isFuture && status !== 'completed';
      case 'attempted':
        // in_progress OR completed (student has engaged with this test)
        return status === 'in_progress' || status === 'completed';
      case 'not_attempted':
        // not_started and NOT a future test (past/today tests student hasn't touched)
        return status === 'not_started' && !isFuture;
      default:
        return true;
    }
  }).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TestsScreen() {
  const [testsData, setTestsData] = useState<TestsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('attempted');

  const navigation = useNavigation<StackNavigationProp<MainStackParamList>>();

  const fetchTests = useCallback(async () => {
    setError(null);
    try {
      const response = await apiClient.get('/api/tests/student');
      const tests: TestRecord[] = response.data?.data ?? [];
      setTestsData({ tests });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load tests');
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
    if (test.is_restricted) {
      Alert.alert(
        'Test Locked',
        'Pay your fees to unlock this test. Please contact your teacher or school office.',
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
    not_attempted: filterTests(allTests, 'not_attempted').length,
    attempted:     filterTests(allTests, 'attempted').length,
    upcoming:      filterTests(allTests, 'upcoming').length,
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
            // Hide "Upcoming" tab when there are no upcoming tests
            if (tab.key === 'upcoming' && count === 0) return null;
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
                  {activeTab === 'not_attempted'
                    ? 'No pending tests.'
                    : activeTab === 'upcoming'
                    ? 'No upcoming tests.'
                    : 'No attempted tests yet.'}
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
