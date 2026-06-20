import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, ActivityIndicator, StatusBar,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp } from '@react-navigation/native';
import apiClient from '../../api/client';
import { StudentStackParamList } from '../../navigation/AppNavigator';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RecoveryTestMeta {
  id: string;
  subject: string;
  total_questions: number | null;
  time_limit_minutes: number | null;
  available_from: string | null;
  available_until: string | null;
  is_available: boolean;
  attempt_status: 'not_started' | 'in_progress' | 'submitted';
  percentage: number | null;
}

interface RecoveryTestListScreenProps {
  navigation: StackNavigationProp<StudentStackParamList, 'MonthlyRecoveryTests'>;
  route: RouteProp<StudentStackParamList, 'MonthlyRecoveryTests'>;
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status, percentage }: { status: string; percentage: number | null }) {
  if (status === 'submitted') {
    const pct = percentage ?? 0;
    const color = pct >= 75 ? '#15803D' : pct >= 50 ? '#D97706' : '#DC2626';
    const bg = pct >= 75 ? '#F0FDF4' : pct >= 50 ? '#FFFBEB' : '#FEF2F2';
    return (
      <View style={[badgeStyles.badge, { backgroundColor: bg }]}>
        <Text style={[badgeStyles.text, { color }]}>Completed — {pct}%</Text>
      </View>
    );
  }
  if (status === 'in_progress') {
    return <View style={[badgeStyles.badge, { backgroundColor: '#EFF6FF' }]}><Text style={[badgeStyles.text, { color: '#1D4ED8' }]}>In Progress</Text></View>;
  }
  return <View style={[badgeStyles.badge, { backgroundColor: '#F3F4F6' }]}><Text style={[badgeStyles.text, { color: '#6B7280' }]}>Not started</Text></View>;
}

const badgeStyles = StyleSheet.create({
  badge: { borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  text: { fontSize: 11, fontWeight: '600' },
});

// ── Test card ─────────────────────────────────────────────────────────────────

function TestCard({ test, onPress }: { test: RecoveryTestMeta; onPress: () => void }) {
  const canAttempt = test.is_available && test.attempt_status !== 'submitted';
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={canAttempt ? onPress : undefined}
      activeOpacity={canAttempt ? 0.8 : 1}
      accessibilityRole="button"
      accessibilityLabel={`${test.subject} recovery test`}
      accessibilityState={{ disabled: !canAttempt }}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <Text style={styles.subjectText}>{test.subject}</Text>
          <Text style={styles.metaText}>
            {test.total_questions ?? '?'} questions
            {test.time_limit_minutes ? ` · ${test.time_limit_minutes} min` : ''}
          </Text>
        </View>
        <View style={styles.iconWrap}>
          <Text style={styles.icon}>📝</Text>
        </View>
      </View>

      {(test.available_from || test.available_until) && (
        <View style={styles.windowRow}>
          <Text style={styles.windowText}>
            {test.available_from ? `From ${test.available_from}` : ''}
            {test.available_from && test.available_until ? ' — ' : ''}
            {test.available_until ? `Until ${test.available_until}` : ''}
          </Text>
        </View>
      )}

      <View style={styles.cardFooter}>
        <StatusBadge status={test.attempt_status} percentage={test.percentage} />
        {canAttempt && <Text style={styles.ctaText}>Start →</Text>}
      </View>
    </TouchableOpacity>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function RecoveryTestListScreen({ route }: RecoveryTestListScreenProps) {
  // Can be opened from a cycle pack detail (cycleId param) or standalone
  const cycleId = (route.params as { cycleId?: string })?.cycleId;

  const [tests, setTests] = useState<RecoveryTestMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigation = useNavigation<StackNavigationProp<StudentStackParamList>>();

  const fetchTests = useCallback(async () => {
    setError(null);
    try {
      if (cycleId) {
        const res = await apiClient.get(`/api/student-recovery/tests/by-cycle/${cycleId}`);
        setTests((res.data?.data ?? []) as RecoveryTestMeta[]);
      } else {
        const res = await apiClient.get('/api/student-recovery/tests');
        const data = res.data?.data as { available?: RecoveryTestMeta[]; completed?: RecoveryTestMeta[] };
        setTests([...(data.available ?? []), ...(data.completed ?? [])]);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load tests');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [cycleId]);

  useEffect(() => { fetchTests(); }, [fetchTests]);

  const onRefresh = useCallback(() => { setRefreshing(true); fetchTests(); }, [fetchTests]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1D4ED8" />
      </View>
    );
  }

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <FlatList
        style={styles.container}
        contentContainerStyle={styles.content}
        data={tests}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1D4ED8" />}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <Text style={styles.title}>Recovery Tests</Text>
            <Text style={styles.subtitle}>One test per subject based on your recovery pack</Text>
          </View>
        }
        renderItem={({ item }) => (
          <TestCard
            test={item}
            onPress={() => navigation.navigate('MonthlyRecoveryTestAttempt', { testId: item.id })}
          />
        )}
        ListEmptyComponent={
          error ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>⚠️ {error}</Text>
              <TouchableOpacity style={styles.retryButton} onPress={() => { setLoading(true); fetchTests(); }} accessibilityRole="button">
                <Text style={styles.retryText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>📝</Text>
              <Text style={styles.emptyText}>No recovery tests available yet.</Text>
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
  listHeader: { marginBottom: 16 },
  title: { fontSize: 22, fontWeight: '700', color: '#111827', marginBottom: 4 },
  subtitle: { fontSize: 13, color: '#6B7280' },
  card: {
    backgroundColor: '#FFFFFF', borderRadius: 14, marginBottom: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07, shadowRadius: 5, elevation: 2, overflow: 'hidden',
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', padding: 16, paddingBottom: 10 },
  cardLeft: { flex: 1 },
  subjectText: { fontSize: 17, fontWeight: '700', color: '#111827' },
  metaText: { fontSize: 13, color: '#6B7280', marginTop: 3 },
  iconWrap: { width: 44, height: 44, borderRadius: 12, backgroundColor: '#DBEAFE', justifyContent: 'center', alignItems: 'center' },
  icon: { fontSize: 22 },
  windowRow: { paddingHorizontal: 16, paddingBottom: 8 },
  windowText: { fontSize: 12, color: '#9CA3AF' },
  cardFooter: { borderTopWidth: 1, borderTopColor: '#F3F4F6', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 16 },
  ctaText: { fontSize: 13, fontWeight: '700', color: '#1D4ED8' },
  emptyState: { alignItems: 'center', marginTop: 60 },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyText: { fontSize: 15, color: '#9CA3AF', textAlign: 'center' },
  retryButton: { marginTop: 16, backgroundColor: '#1D4ED8', borderRadius: 8, paddingHorizontal: 24, paddingVertical: 10 },
  retryText: { color: '#FFFFFF', fontWeight: '600', fontSize: 14 },
});
