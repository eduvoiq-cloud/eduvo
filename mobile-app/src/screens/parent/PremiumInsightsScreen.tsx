/**
 * PremiumInsightsScreen.tsx
 *
 * Parent Insights dashboard.
 * Shows:
 *   - AI weekly summary (latest)
 *   - Weak topics list, colour-coded (red/yellow/green)
 *   - Subject-wise score bar chart (pure RN bars)
 *   - Current streak (big number + flame icon)
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  StatusBar,
  Platform,
} from 'react-native';
import apiClient from '../../api/client';
import { useAuthStore } from '../../store/authStore';
// ── Types ─────────────────────────────────────────────────────────────────────

interface Child {
  id: string;
  full_name: string;
  class_name: string;
  section?: string;
}

interface WeakTopic {
  subject: string;
  topic: string;
  weakness_score: number;
  last_calculated_at: string;
}

interface MarksSummary {
  subject: string;
  average: number;
  count: number;
  latest: number | null;
}

interface Streak {
  current_streak: number;
  longest_streak: number;
  last_activity_date: string | null;
  total_active_days: number;
}

interface WeeklyReport {
  id: string;
  week_start_date: string;
  report_text: string;
  generated_at: string;
}

interface InsightsData {
  latest_report: WeeklyReport | null;
  weak_topics: WeakTopic[];
  streak: Streak | null;
  marks_summary: MarksSummary[];
  message?: string;
}

// ── Colour helpers ────────────────────────────────────────────────────────────

/** weakness_score: 80+ = red (urgent), 60-80 = yellow, 40-60 = orange, 0-40 = green */
function topicColor(score: number): { bg: string; text: string; label: string } {
  if (score >= 80) return { bg: '#FEE2E2', text: '#B91C1C', label: 'Urgent' };
  if (score >= 60) return { bg: '#FEF3C7', text: '#92400E', label: 'Needs Practice' };
  if (score >= 40) return { bg: '#FFF7ED', text: '#C2410C', label: 'Okay' };
  return { bg: '#DCFCE7', text: '#15803D', label: 'Strong' };
}

function averageBarColor(avg: number): string {
  if (avg >= 75) return '#22C55E';
  if (avg >= 50) return '#F59E0B';
  return '#EF4444';
}

function formatDate(iso: string): string {
  const d = (iso && !iso.endsWith('Z') && !iso.includes('+') && !/\d{2}:\d{2}$/.test(iso))
    ? new Date(iso + 'Z') : new Date(iso);
  return d.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SkeletonBlock({ width, height, style }: { width: number | string; height: number; style?: object }) {
  return (
    <View style={[{ width, height, borderRadius: 8, backgroundColor: '#E5E7EB' }, style]} />
  );
}

function InsightsSkeleton() {
  return (
    <View style={{ padding: 20 }}>
      <SkeletonBlock width="100%" height={120} style={{ borderRadius: 14, marginBottom: 16 }} />
      <SkeletonBlock width="40%" height={16} style={{ marginBottom: 12 }} />
      <SkeletonBlock width="100%" height={60} style={{ borderRadius: 12, marginBottom: 8 }} />
      <SkeletonBlock width="100%" height={60} style={{ borderRadius: 12, marginBottom: 8 }} />
      <SkeletonBlock width="100%" height={60} style={{ borderRadius: 12, marginBottom: 20 }} />
      <SkeletonBlock width="40%" height={16} style={{ marginBottom: 12 }} />
      <SkeletonBlock width="100%" height={180} style={{ borderRadius: 14, marginBottom: 16 }} />
    </View>
  );
}

/** Streak card with flame icon */
function StreakCard({ streak }: { streak: Streak }) {
  return (
    <View style={streakStyles.card}>
      <View style={streakStyles.left}>
        <Text style={streakStyles.flame}>🔥</Text>
        <View>
          <Text style={streakStyles.number}>{streak.current_streak}</Text>
          <Text style={streakStyles.label}>Day Streak</Text>
        </View>
      </View>
      <View style={streakStyles.divider} />
      <View style={streakStyles.right}>
        <View style={streakStyles.statRow}>
          <Text style={streakStyles.statLabel}>Best</Text>
          <Text style={streakStyles.statValue}>{streak.longest_streak}d</Text>
        </View>
        <View style={streakStyles.statRow}>
          <Text style={streakStyles.statLabel}>Total active</Text>
          <Text style={streakStyles.statValue}>{streak.total_active_days}d</Text>
        </View>
      </View>
    </View>
  );
}

const streakStyles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFBEB',
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#FCD34D',
    padding: 20,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 12,
  },
  flame: {
    fontSize: 44,
  },
  number: {
    fontSize: 42,
    fontWeight: '800',
    color: '#F59E0B',
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#92400E',
    marginTop: -2,
  },
  divider: {
    width: 1,
    height: 50,
    backgroundColor: '#FCD34D',
    marginHorizontal: 16,
  },
  right: {
    gap: 8,
  },
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  statLabel: {
    fontSize: 12,
    color: '#92400E',
  },
  statValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#78350F',
  },
});

/** Subject bar chart (pure RN) */
function SubjectBarChart({ marksSummary }: { marksSummary: MarksSummary[] }) {
  if (marksSummary.length === 0) {
    return (
      <View style={chartStyles.empty}>
        <Text style={chartStyles.emptyText}>No marks data yet</Text>
      </View>
    );
  }

  const sorted = [...marksSummary].sort((a, b) => b.average - a.average);

  return (
    <View style={chartStyles.container}>
      {sorted.map((item) => {
        const color = averageBarColor(item.average);
        return (
          <View key={item.subject} style={chartStyles.row}>
            <Text style={chartStyles.label} numberOfLines={1}>{item.subject}</Text>
            <View style={chartStyles.barTrack}>
              <View
                style={[
                  chartStyles.barFill,
                  { width: `${Math.min(item.average, 100)}%` as unknown as number, backgroundColor: color },
                ]}
              />
            </View>
            <Text style={[chartStyles.value, { color }]}>{item.average}%</Text>
          </View>
        );
      })}
    </View>
  );
}

const chartStyles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
    marginBottom: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  label: {
    width: 90,
    fontSize: 13,
    color: '#374151',
    fontWeight: '500',
  },
  barTrack: {
    flex: 1,
    height: 10,
    backgroundColor: '#F3F4F6',
    borderRadius: 5,
    overflow: 'hidden',
  },
  barFill: {
    height: 10,
    borderRadius: 5,
  },
  value: {
    width: 38,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'right',
  },
  empty: {
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
    marginBottom: 16,
  },
  emptyText: {
    fontSize: 14,
    color: '#9CA3AF',
  },
});

/** Weak topic pill */
function WeakTopicPill({ topic }: { topic: WeakTopic }) {
  const { bg, text, label } = topicColor(topic.weakness_score);
  return (
    <View style={[topicStyles.pill, { backgroundColor: bg }]}>
      <View style={topicStyles.pillHeader}>
        <Text style={[topicStyles.topicText, { color: text }]} numberOfLines={1}>
          {topic.topic}
        </Text>
        <View style={[topicStyles.badge, { backgroundColor: text + '20' }]}>
          <Text style={[topicStyles.badgeText, { color: text }]}>{label}</Text>
        </View>
      </View>
      <Text style={[topicStyles.subjectText, { color: text + 'AA' }]}>
        {topic.subject} · Score: {Math.round(100 - topic.weakness_score)}%
      </Text>
    </View>
  );
}

const topicStyles = StyleSheet.create({
  pill: {
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
  pillHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  topicText: {
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
    marginRight: 8,
  },
  badge: {
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  subjectText: {
    fontSize: 12,
  },
});

// ── Main component ────────────────────────────────────────────────────────────

export default function PremiumInsightsScreen() {
  const user = useAuthStore((s) => s.student);

  const [children, setChildren] = useState<Child[]>([]);
  const [selectedChild, setSelectedChild] = useState<Child | null>(null);
  const [insights, setInsights] = useState<InsightsData | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Fetch children ──────────────────────────────────────────────────────────

  const fetchChildren = useCallback(async (): Promise<Child[]> => {
    try {
      const res = await apiClient.get('/api/students', {
        params: { parent_id: user?.id },
      });
      return res.data.data ?? [];
    } catch {
      return [];
    }
  }, [user?.id]);

  // ── Fetch insights ──────────────────────────────────────────────────────────

  const fetchInsights = useCallback(async (child: Child) => {
    setError(null);
    try {
      const res = await apiClient.get(`/api/weekly-analysis/insights/${child.id}`);
      setInsights(res.data.data ?? null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load insights';
      setError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // ── Initial load ────────────────────────────────────────────────────────────

  useEffect(() => {
    const init = async () => {
      setLoading(true);
      const list = await fetchChildren();
      setChildren(list);
      if (list.length > 0) {
        setSelectedChild(list[0]);
      } else {
        setLoading(false);
      }
    };
    void init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selectedChild) {
      setLoading(true);
      setInsights(null);
      void fetchInsights(selectedChild);
    }
  }, [selectedChild, fetchInsights]);

  const onRefresh = useCallback(() => {
    if (!selectedChild) return;
    setRefreshing(true);
    void fetchInsights(selectedChild);
  }, [selectedChild, fetchInsights]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            ✨ Insights
          </Text>
          {selectedChild && (
            <Text style={styles.headerSub}>
              {selectedChild.full_name} · {selectedChild.class_name}
              {selectedChild.section ? ` ${selectedChild.section}` : ''}
            </Text>
          )}
        </View>
      </View>

      {/* ── Child selector ──────────────────────────────────────────────────── */}
      {children.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.childTabsScroll}
          contentContainerStyle={styles.childTabsContent}
        >
          {children.map((child) => (
            <TouchableOpacity
              key={child.id}
              style={[
                styles.childTab,
                selectedChild?.id === child.id && styles.childTabActive,
              ]}
              onPress={() => setSelectedChild(child)}
              accessibilityRole="button"
              accessibilityLabel={`View insights for ${child.full_name}`}
            >
              <Text
                style={[
                  styles.childTabText,
                  selectedChild?.id === child.id && styles.childTabTextActive,
                ]}
              >
                {child.full_name.split(' ')[0]}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* ── Content ────────────────────────────────────────────────────────── */}
      {loading ? (
        <ScrollView style={styles.container}>
          <InsightsSkeleton />
        </ScrollView>
      ) : error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>⚠️ {error}</Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={() => { if (selectedChild) { setLoading(true); void fetchInsights(selectedChild); } }}
            accessibilityRole="button"
            accessibilityLabel="Retry"
          >
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : !insights ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>📊</Text>
          <Text style={styles.emptyText}>No data available yet.</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.container}
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#1D4ED8"
              colors={['#1D4ED8']}
            />
          }
        >
          {/* ── Streak ───────────────────────────────────────────────────── */}
          {insights.streak && (
            <StreakCard streak={insights.streak} />
          )}

          {/* ── AI Weekly Summary ─────────────────────────────────────────── */}
          <Text style={styles.sectionTitle}>📝 Weekly Summary</Text>
          {insights.latest_report ? (
            <View style={styles.reportCard}>
              <View style={styles.reportHeader}>
                <Text style={styles.reportBadge}>AI Generated</Text>
                <Text style={styles.reportDate}>
                  Week of {formatDate(insights.latest_report.week_start_date)}
                </Text>
              </View>
              <Text style={styles.reportText}>{insights.latest_report.report_text}</Text>
            </View>
          ) : (
            <View style={styles.reportCard}>
              <Text style={styles.noReportText}>
                Your child's first weekly report will be generated this Sunday. Check back soon! 🌟
              </Text>
            </View>
          )}

          {/* ── Weak Topics ──────────────────────────────────────────────── */}
          {insights.weak_topics.length > 0 && (
            <>
              <View style={styles.sectionRow}>
                <Text style={styles.sectionTitle}>🎯 Topic Analysis</Text>
                <View style={styles.legendRow}>
                  <View style={[styles.legendDot, { backgroundColor: '#EF4444' }]} />
                  <Text style={styles.legendText}>Urgent</Text>
                  <View style={[styles.legendDot, { backgroundColor: '#F59E0B', marginLeft: 8 }]} />
                  <Text style={styles.legendText}>Practice</Text>
                  <View style={[styles.legendDot, { backgroundColor: '#22C55E', marginLeft: 8 }]} />
                  <Text style={styles.legendText}>Strong</Text>
                </View>
              </View>
              {insights.weak_topics.map((topic, idx) => (
                <WeakTopicPill key={`${topic.subject}-${topic.topic}-${idx}`} topic={topic} />
              ))}
            </>
          )}

          {/* ── Subject Score Chart ───────────────────────────────────────── */}
          {insights.marks_summary.length > 0 && (
            <>
              <Text style={[styles.sectionTitle, { marginTop: 8 }]}>📊 Subject Performance</Text>
              <SubjectBarChart marksSummary={insights.marks_summary} />
            </>
          )}

          {/* ── No data state ─────────────────────────────────────────────── */}
          {insights.weak_topics.length === 0 && insights.marks_summary.length === 0 && (
            <View style={styles.noDataBox}>
              <Text style={styles.noDataIcon}>🌱</Text>
              <Text style={styles.noDataText}>
                Analysis starts once your child completes some tests and activities.
              </Text>
            </View>
          )}
        </ScrollView>
      )}
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    paddingTop: Platform.OS === 'ios' ? 52 : 16,
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 2,
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#111827',
  },
  headerSub: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 1,
  },
  childTabsScroll: {
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
    maxHeight: 48,
  },
  childTabsContent: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
    flexDirection: 'row',
  },
  childTab: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#F3F4F6',
  },
  childTabActive: {
    backgroundColor: '#DBEAFE',
  },
  childTabText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#6B7280',
  },
  childTabTextActive: {
    color: '#1D4ED8',
    fontWeight: '600',
  },
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  content: {
    padding: 16,
    paddingBottom: 48,
  },
  errorBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  errorText: {
    fontSize: 14,
    color: '#B91C1C',
    textAlign: 'center',
    marginBottom: 16,
  },
  retryBtn: {
    backgroundColor: '#EF4444',
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  retryText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  emptyText: {
    fontSize: 16,
    color: '#6B7280',
    textAlign: 'center',
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#374151',
    marginBottom: 12,
  },
  sectionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    marginTop: 8,
    flexWrap: 'wrap',
    gap: 8,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    fontSize: 11,
    color: '#6B7280',
    marginLeft: 3,
  },

  // Report card
  reportCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 18,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
    borderLeftWidth: 4,
    borderLeftColor: '#1D4ED8',
  },
  reportHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  reportBadge: {
    fontSize: 11,
    fontWeight: '700',
    color: '#1D4ED8',
    backgroundColor: '#DBEAFE',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
  },
  reportDate: {
    fontSize: 12,
    color: '#9CA3AF',
  },
  reportText: {
    fontSize: 15,
    color: '#374151',
    lineHeight: 24,
  },
  noReportText: {
    fontSize: 14,
    color: '#9CA3AF',
    textAlign: 'center',
    lineHeight: 22,
    paddingVertical: 8,
  },

  // No data
  noDataBox: {
    backgroundColor: '#F0FDF4',
    borderRadius: 14,
    padding: 24,
    alignItems: 'center',
  },
  noDataIcon: {
    fontSize: 36,
    marginBottom: 10,
  },
  noDataText: {
    fontSize: 14,
    color: '#166534',
    textAlign: 'center',
    lineHeight: 22,
  },
});
