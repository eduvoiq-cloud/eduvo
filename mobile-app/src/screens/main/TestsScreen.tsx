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
    if (!schoolContact) return;
    const url = schoolContact.includes('@')
      ? `mailto:${schoolContact}`
      : `tel:${schoolContact}`;
    Linking.openURL(url).catch(() => {});
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
          >
            <Text style={lockedStyles.contactButtonText}>📞 {schoolContact}</Text>
          </TouchableOpacity>
        ) : (
          <Text style={lockedStyles.contactFallback}>Visit the school office for assistance.</Text>
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
  title: { fontSize: 26, fontWeight: '800', color: '#111827', marginBottom: 10, textAlign: 'center' },
  subtitle: { fontSize: 15, color: '#6B7280', textAlign: 'center', lineHeight: 22, marginBottom: 28 },
  contactCard: {
    width: '100%',
    backgroundColor: '#EFF6FF',
    borderRadius: 14,
    padding: 16,
    borderLeftWidth: 4,
    borderLeftColor: '#1D4ED8',
  },
  contactTitle: { fontSize: 14, fontWeight: '700', color: '#1E3A8A', marginBottom: 6 },
  contactBody: { fontSize: 13, color: '#374151', lineHeight: 19, marginBottom: 12 },
  contactButton: {
    backgroundColor: '#1D4ED8',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  contactButtonText: { fontSize: 14, fontWeight: '600', color: '#FFFFFF' },
  contactFallback: { fontSize: 13, color: '#6B7280', fontStyle: 'italic' },
});

// ── Test card ─────────────────────────────────────────────────────────────────

function TestCard({ test, onPress }: { test: TestRecord; onPress: () => void }) {
  const status = test.attempt_status ?? 'not_started';
  const config = STATUS_CONFIG[status];
  const upcoming = isUpcoming(test.date);

  return (
    <TouchableOpacity
      style={[styles.card, upcoming && styles.cardUpcoming]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={`${test.title}. Status: ${config.label}.`}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <Text style={styles.testTitle} numberOfLines={2}>{test.title}</Text>
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
      {status !== 'completed' && (
        <View style={styles.ctaRow}>
          <Text style={styles.ctaText}>
            {status === 'in_progress' ? 'Continue Test →' : 'Start Test →'}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TestsScreen() {
  const [testsData, setTestsData] = useState<TestsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigation = useNavigation<StackNavigationProp<MainStackParamList>>();

  const fetchTests = useCallback(async () => {
    setError(null);
    try {
      const response = await apiClient.get('/api/tests/student');
      const payload = response.data;
      const tests: TestRecord[] = payload.data ?? [];
      const message: string = payload.message ?? '';
      const feePaid = tests.length > 0 || !message.toLowerCase().includes('fee');

      let schoolContact: string | null = null;
      try {
        const settingsRes = await apiClient.get('/api/settings');
        schoolContact =
          settingsRes.data.data?.contact_phone ??
          settingsRes.data.data?.contact_email ??
          null;
      } catch { /* settings endpoint optional */ }

      setTestsData({ feePaid, tests, schoolContact });
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

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1D4ED8" />
      </View>
    );
  }

  if (testsData && !testsData.feePaid) {
    return (
      <>
        <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
        <FeeLockedScreen schoolContact={testsData.schoolContact} />
      </>
    );
  }

  const tests = testsData?.tests ?? [];
  const sorted = [...tests].sort((a, b) => {
    const aUp = isUpcoming(a.date);
    const bUp = isUpcoming(b.date);
    if (aUp && !bUp) return -1;
    if (!aUp && bUp) return 1;
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <FlatList
        style={styles.container}
        contentContainerStyle={styles.content}
        data={sorted}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1D4ED8" />
        }
        ListHeaderComponent={
          <Text style={styles.title}>Tests</Text>
        }
        renderItem={({ item }) => (
          <TestCard
            test={item}
            onPress={() =>
              navigation.navigate('TestAttempt', {
                test: {
                  id: item.id,
                  title: item.title,
                  time_limit_minutes: item.time_limit_minutes ?? 0,
                  question_count: item.question_count,
                  attempt_status: item.attempt_status,
                },
              })
            }
          />
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
              <Text style={styles.emptyText}>No tests available right now.</Text>
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
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F9FAFB' },
  title: { fontSize: 22, fontWeight: '700', color: '#111827', marginBottom: 16 },
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
  cardUpcoming: { borderLeftWidth: 4, borderLeftColor: '#1D4ED8' },
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
  statusBadge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, alignSelf: 'flex-start' },
  statusText: { fontSize: 12, fontWeight: '600' },
  metaRow: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  metaItem: { flex: 1 },
  metaLabel: { fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 },
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
