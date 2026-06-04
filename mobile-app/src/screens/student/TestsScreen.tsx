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
  Linking,
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
}

interface TestsResponse {
  feePaid: boolean;
  tests: TestRecord[];
  schoolContact?: string | null;
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

function isUpcoming(dateStr: string): boolean {
  return new Date(dateStr) >= new Date(new Date().toDateString());
}

/** Returns the window state for today: 'before' | 'open' | 'closed' | 'no_window' */
function getWindowState(
  date: string,
  availableFrom: string | null,
  availableUntil: string | null
): 'before' | 'open' | 'closed' | 'no_window' {
  if (!availableFrom && !availableUntil) return 'no_window';
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const testDateStr = new Date(date).toISOString().split('T')[0];
  if (todayStr !== testDateStr) return 'no_window'; // window only applies on the test date
  const nowHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (availableFrom && nowHHMM < availableFrom) return 'before';
  if (availableUntil && nowHHMM > availableUntil) return 'closed';
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

// ── Fee locked screen ─────────────────────────────────────────────────────────

function FeeLockedScreen({ schoolContact }: { schoolContact?: string | null }) {
  const handleContact = () => {
    if (schoolContact) {
      // Try to open as phone number or email
      const isEmail = schoolContact.includes('@');
      const url = isEmail ? `mailto:${schoolContact}` : `tel:${schoolContact}`;
      Linking.openURL(url).catch(() => {
        // Silently fail — contact info is still visible on screen
      });
    }
  };

  return (
    <View style={lockedStyles.container}>
      <View style={lockedStyles.iconWrapper}>
        <Text style={lockedStyles.lockIcon}>🔒</Text>
      </View>

      <Text style={lockedStyles.title}>Tests Locked</Text>
      <Text style={lockedStyles.subtitle}>
        Please pay your fees to access tests and unlock all exam features.
      </Text>

      <View style={lockedStyles.infoCard}>
        <Text style={lockedStyles.infoTitle}>What you're missing out on:</Text>
        {[
          'Access to all scheduled tests',
          'Online exam submissions',
          'Instant MCQ results',
          'Performance tracking',
        ].map((item) => (
          <View key={item} style={lockedStyles.infoRow}>
            <Text style={lockedStyles.infoDot}>•</Text>
            <Text style={lockedStyles.infoText}>{item}</Text>
          </View>
        ))}
      </View>

      <View style={lockedStyles.contactCard}>
        <Text style={lockedStyles.contactTitle}>Contact Your School</Text>
        <Text style={lockedStyles.contactBody}>
          Speak to your school administrator or accounts office to clear your fee balance.
        </Text>
        {schoolContact ? (
          <TouchableOpacity
            style={lockedStyles.contactButton}
            onPress={handleContact}
            accessibilityRole="button"
            accessibilityLabel={`Contact school at ${schoolContact}`}
          >
            <Text style={lockedStyles.contactButtonText}>📞 {schoolContact}</Text>
          </TouchableOpacity>
        ) : (
          <Text style={lockedStyles.contactFallback}>
            Visit the school office for assistance.
          </Text>
        )}
      </View>
    </View>
  );
}

const lockedStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapper: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: '#FEE2E2',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  lockIcon: { fontSize: 44 },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: '#111827',
    marginBottom: 10,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 28,
    paddingHorizontal: 8,
  },
  infoCard: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  infoTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 10,
  },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
  infoDot: { fontSize: 14, color: '#EF4444', marginRight: 8, lineHeight: 20 },
  infoText: { fontSize: 14, color: '#4B5563', flex: 1, lineHeight: 20 },
  contactCard: {
    width: '100%',
    backgroundColor: '#EFF6FF',
    borderRadius: 14,
    padding: 16,
    borderLeftWidth: 4,
    borderLeftColor: '#1D4ED8',
  },
  contactTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1E3A8A',
    marginBottom: 6,
  },
  contactBody: {
    fontSize: 13,
    color: '#374151',
    lineHeight: 19,
    marginBottom: 12,
  },
  contactButton: {
    backgroundColor: '#1D4ED8',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  contactButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  contactFallback: {
    fontSize: 13,
    color: '#6B7280',
    fontStyle: 'italic',
  },
});

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

  return (
    <TouchableOpacity
      style={[styles.card, upcoming && styles.cardUpcoming]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={`${test.title} test. Status: ${config.label}. Tap to open.`}
    >
      {/* Header row */}
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <Text style={styles.testTitle} numberOfLines={2}>
            {test.title}
          </Text>
          {upcoming && (
            <View style={styles.upcomingBadge}>
              <Text style={styles.upcomingText}>Upcoming</Text>
            </View>
          )}
        </View>
        <View style={[styles.statusBadge, { backgroundColor: config.bg }]}>
          <Text style={[styles.statusText, { color: config.color }]}>{config.label}</Text>
        </View>
      </View>

      {/* Time window banner */}
      {hasWindow && status !== 'completed' && (
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
              ? '🔴 Test window closed'
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
          <Text style={styles.metaValue}>{test.time_limit_minutes} min</Text>
        </View>
      </View>

      {/* CTA */}
      <View style={styles.ctaRow}>
        <Text style={[styles.ctaText, status === 'completed' && styles.ctaTextCompleted]}>
          {status === 'completed' ? 'View Results →' : status === 'in_progress' ? 'Continue Test →' : 'Start Test →'}
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

  const navigation = useNavigation<StackNavigationProp<StudentStackParamList>>();

  const fetchTests = useCallback(async () => {
    setError(null);
    try {
      const response = await apiClient.get('/api/tests/student');
      const payload = response.data;

      // The backend returns an empty array with a fee message when fee is unpaid
      const tests: TestRecord[] = payload.data ?? [];
      const message: string = payload.message ?? '';
      const feePaid = tests.length > 0 || !message.toLowerCase().includes('fee');

      // Fetch school contact info gracefully
      let schoolContact: string | null = null;
      try {
        const settingsRes = await apiClient.get('/api/settings');
        schoolContact = settingsRes.data.data?.contact_phone
          ?? settingsRes.data.data?.contact_email
          ?? null;
      } catch {
        // Settings endpoint may not exist — that's fine
      }

      setTestsData({ feePaid, tests, schoolContact });
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

  // ── Fee locked ──────────────────────────────────────────────────────────────
  if (testsData && !testsData.feePaid) {
    return (
      <>
        <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
        <FeeLockedScreen schoolContact={testsData.schoolContact} />
      </>
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
