/**
 * DailyTestScreen — shows today's pending daily test for a premium_senior student.
 * Navigates to DailyTestAttemptScreen to actually take the test.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StatusBar,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import apiClient from '../../api/client';
import { StudentStackParamList } from '../../navigation/AppNavigator';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DailyTestMeta {
  id: string;
  subject: string;
  topic: string;
  test_date: string;
  questions: Array<{
    question_text: string;
    options: string[];
    difficulty?: string;
    marks: number;
  }>;
  attempt_status: 'pending' | 'completed';
  attempt_score: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ScoreBadge({ score, total }: { score: number; total: number }) {
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const color = pct >= 70 ? '#15803D' : pct >= 40 ? '#D97706' : '#DC2626';
  const bg = pct >= 70 ? '#DCFCE7' : pct >= 40 ? '#FEF3C7' : '#FEE2E2';
  return (
    <View style={[styles.scoreBadge, { backgroundColor: bg }]}>
      <Text style={[styles.scoreBadgeText, { color }]}>
        {score}/{total} · {pct}%
      </Text>
    </View>
  );
}

// ── Test card ─────────────────────────────────────────────────────────────────

function TestCard({ test, onPress }: { test: DailyTestMeta; onPress: () => void }) {
  const completed = test.attempt_status === 'completed';
  return (
    <TouchableOpacity
      style={[styles.card, completed && styles.cardCompleted]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={`${test.subject} daily test on ${test.topic}. Status: ${completed ? 'Completed' : 'Pending'}.`}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <Text style={styles.subjectText}>{test.subject}</Text>
          <Text style={styles.topicText} numberOfLines={2}>{test.topic}</Text>
        </View>
        <View style={[styles.statusBadge, completed ? styles.statusCompleted : styles.statusPending]}>
          <Text style={[styles.statusText, completed ? styles.statusTextCompleted : styles.statusTextPending]}>
            {completed ? '✓ Done' : '⏳ Pending'}
          </Text>
        </View>
      </View>

      <View style={styles.metaRow}>
        <View style={styles.metaItem}>
          <Text style={styles.metaLabel}>QUESTIONS</Text>
          <Text style={styles.metaValue}>{test.questions.length}</Text>
        </View>
        <View style={styles.metaDivider} />
        <View style={styles.metaItem}>
          <Text style={styles.metaLabel}>MARKS</Text>
          <Text style={styles.metaValue}>{test.questions.reduce((s, q) => s + (q.marks ?? 1), 0)}</Text>
        </View>
        {completed && test.attempt_score !== null && (
          <>
            <View style={styles.metaDivider} />
            <View style={styles.metaItem}>
              <Text style={styles.metaLabel}>YOUR SCORE</Text>
              <ScoreBadge score={test.attempt_score} total={test.questions.length} />
            </View>
          </>
        )}
      </View>

      <View style={styles.ctaRow}>
        <Text style={[styles.ctaText, completed && styles.ctaTextCompleted]}>
          {completed ? 'View Results →' : 'Start Test →'}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DailyTestScreen() {
  const [tests, setTests] = useState<DailyTestMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notPremium, setNotPremium] = useState(false);

  const navigation = useNavigation<StackNavigationProp<StudentStackParamList>>();

  const fetchTests = useCallback(async () => {
    setError(null);
    setNotPremium(false);
    try {
      const res = await apiClient.get('/api/daily-tests/student/today');
      setTests(res.data?.data ?? []);
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? (err instanceof Error ? err.message : 'Failed to load daily tests');
      // 403 = not premium — show "Ask School Admin" message, not an error
      if (status === 403 || msg.toLowerCase().includes('premium')) {
        setTests([]);
        setNotPremium(true);
        setError(null);
      } else {
        setError(msg);
      }
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

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1D4ED8" />}
      >
        <Text style={styles.title}>📝 Daily Test</Text>
        <Text style={styles.subtitle}>
          {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
        </Text>

        {error ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>⚠️ {error}</Text>
            <TouchableOpacity
              style={styles.retryBtn}
              onPress={() => { setLoading(true); fetchTests(); }}
              accessibilityRole="button"
            >
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : notPremium ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>🔒</Text>
            <Text style={styles.emptyHeading}>Premium Required</Text>
            <Text style={styles.emptyText}>
              Ask your school admin to activate Premium for you to unlock Daily Tests.
            </Text>
          </View>
        ) : tests.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>🌟</Text>
            <Text style={styles.emptyHeading}>No test today</Text>
            <Text style={styles.emptyText}>
              Your teacher hasn&apos;t assigned a daily test yet. Check back later!
            </Text>
          </View>
        ) : (
          tests.map((test) => (
            <TestCard
              key={test.id}
              test={test}
              onPress={() =>
                navigation.navigate('DailyTestAttempt', { test })
              }
            />
          ))
        )}
      </ScrollView>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { padding: 20, paddingBottom: 48 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F9FAFB' },

  title: { fontSize: 22, fontWeight: '700', color: '#111827', marginBottom: 4 },
  subtitle: { fontSize: 13, color: '#6B7280', marginBottom: 20 },

  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    marginBottom: 14,
    borderLeftWidth: 4,
    borderLeftColor: '#1D4ED8',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 5,
    elevation: 2,
    overflow: 'hidden',
  },
  cardCompleted: { borderLeftColor: '#15803D', opacity: 0.9 },

  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: 16,
    paddingBottom: 12,
  },
  cardLeft: { flex: 1, marginRight: 10 },
  subjectText: { fontSize: 12, fontWeight: '700', color: '#1D4ED8', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  topicText: { fontSize: 16, fontWeight: '700', color: '#111827' },

  statusBadge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, alignSelf: 'flex-start' },
  statusPending: { backgroundColor: '#DBEAFE' },
  statusCompleted: { backgroundColor: '#DCFCE7' },
  statusText: { fontSize: 12, fontWeight: '600' },
  statusTextPending: { color: '#1D4ED8' },
  statusTextCompleted: { color: '#15803D' },

  scoreBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  scoreBadgeText: { fontSize: 12, fontWeight: '700' },

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

  ctaRow: { borderTopWidth: 1, borderTopColor: '#F3F4F6', paddingVertical: 10, paddingHorizontal: 16, alignItems: 'flex-end' },
  ctaText: { fontSize: 13, fontWeight: '600', color: '#1D4ED8' },
  ctaTextCompleted: { color: '#15803D' },

  emptyState: { alignItems: 'center', marginTop: 60 },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyHeading: { fontSize: 17, fontWeight: '700', color: '#374151', marginBottom: 6 },
  emptyText: { fontSize: 14, color: '#9CA3AF', textAlign: 'center', lineHeight: 20 },
  retryBtn: { marginTop: 16, backgroundColor: '#1D4ED8', borderRadius: 8, paddingHorizontal: 24, paddingVertical: 10 },
  retryText: { color: '#FFFFFF', fontWeight: '600', fontSize: 14 },
});
