import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  StatusBar,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import apiClient from '../../api/client';
import { StudentStackParamList } from '../../navigation/AppNavigator';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AvailableTest {
  id: string;
  subject: string;
  scheduled_month: string;
  total_questions: number | null;
  attempt_status: 'not_started' | 'in_progress';
}

interface CompletedTest {
  id: string;
  subject: string;
  scheduled_month: string;
  total_questions: number | null;
  attempt_id: string;
  score: number | null;
  score_percentage: number | null;
  improvement_percentage: number | null;
  completed_at: string | null;
}

interface TestsData {
  available: AvailableTest[];
  completed: CompletedTest[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatMonth(dateStr: string): string {
  const [y, m] = dateStr.split('-');
  const date = new Date(parseInt(y), parseInt(m) - 1, 1);
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function improvementLabel(pct: number | null): { text: string; color: string } | null {
  if (pct === null || pct === undefined) return null;
  if (pct > 0) return { text: `📈 +${pct}% vs last month`, color: '#15803D' };
  if (pct < 0) return { text: `📉 ${pct}% vs last month`, color: '#D97706' };
  return { text: 'Same as last month', color: '#6B7280' };
}

function scoreColor(pct: number | null): string {
  if (pct === null) return '#6B7280';
  if (pct >= 70) return '#15803D';
  if (pct >= 50) return '#D97706';
  return '#DC2626';
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MonthlyRecoveryTestsScreen() {
  const [data, setData] = useState<TestsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigation = useNavigation<StackNavigationProp<StudentStackParamList>>();

  const fetchTests = useCallback(async () => {
    setError(null);
    try {
      const res = await apiClient.get('/api/student-recovery/tests');
      setData(res.data?.data as TestsData);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load recovery tests');
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

  const available = data?.available ?? [];
  const completed = data?.completed ?? [];

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1D4ED8" />
        }
      >
        <Text style={styles.title}>Recovery Tests</Text>
        <Text style={styles.subtitle}>Monthly tests based on your weak topics</Text>

        {/* Error */}
        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>⚠️ {error}</Text>
            <TouchableOpacity
              style={styles.retryBtn}
              onPress={() => { setLoading(true); fetchTests(); }}
            >
              <Text style={styles.retryBtnText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Available tests */}
        {available.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>Available</Text>
            {available.map((test) => (
              <View key={test.id} style={styles.availableCard}>
                <View style={styles.cardLeft}>
                  <Text style={styles.cardSubject}>{test.subject}</Text>
                  <Text style={styles.cardMonth}>{formatMonth(test.scheduled_month)}</Text>
                  {test.total_questions != null && (
                    <Text style={styles.cardMeta}>{test.total_questions} questions</Text>
                  )}
                </View>
                <TouchableOpacity
                  style={styles.startBtn}
                  onPress={() => navigation.navigate('MonthlyRecoveryTestAttempt', { testId: test.id })}
                  accessibilityRole="button"
                  accessibilityLabel={`Start ${test.subject} recovery test`}
                >
                  <Text style={styles.startBtnText}>
                    {test.attempt_status === 'in_progress' ? 'Continue →' : 'Start Test →'}
                  </Text>
                </TouchableOpacity>
              </View>
            ))}
          </>
        )}

        {/* Empty available */}
        {!error && available.length === 0 && completed.length === 0 && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>🎯</Text>
            <Text style={styles.emptyText}>No recovery tests available right now.</Text>
            <Text style={styles.emptySubtext}>
              Tests are released by your teacher after the recovery pack is ready.
            </Text>
          </View>
        )}

        {/* Completed tests */}
        {completed.length > 0 && (
          <>
            <Text style={[styles.sectionLabel, { marginTop: available.length > 0 ? 20 : 0 }]}>
              Completed
            </Text>
            {completed.map((test) => {
              const improvement = improvementLabel(test.improvement_percentage);
              const pctColor = scoreColor(test.score_percentage);
              return (
                <View key={test.id} style={styles.completedCard}>
                  <View style={styles.completedCardTop}>
                    <View style={styles.cardLeft}>
                      <Text style={styles.cardSubject}>{test.subject}</Text>
                      <Text style={styles.cardMonth}>{formatMonth(test.scheduled_month)}</Text>
                    </View>
                    <View style={[styles.scoreBadge, { backgroundColor: pctColor + '20' }]}>
                      <Text style={[styles.scorePct, { color: pctColor }]}>
                        {test.score_percentage != null ? `${test.score_percentage}%` : '—'}
                      </Text>
                    </View>
                  </View>
                  {test.score != null && test.total_questions != null && (
                    <Text style={styles.scoreDetail}>
                      {test.score} / {test.total_questions} correct
                    </Text>
                  )}
                  {improvement && (
                    <Text style={[styles.improvementText, { color: improvement.color }]}>
                      {improvement.text}
                    </Text>
                  )}
                </View>
              );
            })}
          </>
        )}

        <View style={{ height: 32 }} />
      </ScrollView>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { padding: 20 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F9FAFB' },

  title: { fontSize: 22, fontWeight: '700', color: '#111827', marginBottom: 4 },
  subtitle: { fontSize: 13, color: '#6B7280', marginBottom: 20 },

  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#9CA3AF',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 10,
    marginLeft: 2,
  },

  availableCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 5,
    elevation: 2,
    borderLeftWidth: 4,
    borderLeftColor: '#1D4ED8',
  },
  cardLeft: { flex: 1 },
  cardSubject: { fontSize: 16, fontWeight: '700', color: '#111827' },
  cardMonth: { fontSize: 13, color: '#6B7280', marginTop: 2 },
  cardMeta: { fontSize: 12, color: '#9CA3AF', marginTop: 3 },

  startBtn: {
    backgroundColor: '#1D4ED8',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  startBtnText: { fontSize: 13, fontWeight: '700', color: '#FFFFFF' },

  completedCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  completedCardTop: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
  scoreBadge: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  scorePct: { fontSize: 18, fontWeight: '800' },
  scoreDetail: { fontSize: 13, color: '#6B7280' },
  improvementText: { fontSize: 13, fontWeight: '600', marginTop: 5 },

  emptyState: { alignItems: 'center', marginTop: 40 },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyText: { fontSize: 15, color: '#9CA3AF', textAlign: 'center' },
  emptySubtext: { fontSize: 13, color: '#D1D5DB', marginTop: 6, textAlign: 'center', paddingHorizontal: 20 },

  errorBox: { marginBottom: 20 },
  errorText: { fontSize: 14, color: '#DC2626', marginBottom: 8 },
  retryBtn: {
    backgroundColor: '#1D4ED8',
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 8,
    alignSelf: 'flex-start',
  },
  retryBtnText: { color: '#FFFFFF', fontWeight: '600', fontSize: 13 },
});
