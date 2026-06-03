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
  Platform,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import apiClient from '../../api/client';
import { useAuthStore } from '../../store/authStore';
import { ParentTabParamList } from '../../navigation/AppNavigator';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Child {
  id: string;
  full_name: string;
  class_name: string;
  section?: string;
}

interface SubjectSummary {
  name: string;
  average: number;
  latest_score: number | null;
  previous_score: number | null;
  change: number | null;
  trend: 'improved' | 'dropped' | 'unchanged' | 'first';
  message: string;
}

interface PerformanceSummary {
  student_id: string;
  student_name: string;
  strongest_subject: { name: string; average: number } | null;
  weakest_subject: { name: string; average: number } | null;
  attendance_percentage: number;
  subjects: SubjectSummary[];
}

type ParentNavProp = BottomTabNavigationProp<ParentTabParamList>;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns a colour based on attendance percentage thresholds. */
function attendanceColor(pct: number): string {
  if (pct >= 75) return '#22C55E'; // green
  if (pct >= 50) return '#F59E0B'; // yellow
  return '#EF4444';                // red
}

/** Returns a colour for a subject average bar. */
function averageBarColor(avg: number): string {
  if (avg >= 75) return '#22C55E';
  if (avg >= 50) return '#F59E0B';
  return '#EF4444';
}

// ── Attendance Gauge ──────────────────────────────────────────────────────────

function AttendanceGauge({ percentage }: { percentage: number }) {
  const color = attendanceColor(percentage);
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  // We use a simple visual approximation with a View arc since SVG isn't
  // available without extra deps. We render a circular ring using border tricks.
  const fillDeg = Math.round((percentage / 100) * 360);

  return (
    <View style={gaugeStyles.wrapper} accessibilityLabel={`Attendance ${percentage}%`}>
      {/* Outer ring */}
      <View style={[gaugeStyles.ring, { borderColor: '#E5E7EB' }]}>
        {/* Filled arc overlay — approximated with a coloured inner circle */}
        <View style={[gaugeStyles.innerCircle, { borderColor: color }]}>
          <Text style={[gaugeStyles.pctText, { color }]}>{percentage}%</Text>
          <Text style={gaugeStyles.pctLabel}>Attendance</Text>
        </View>
      </View>
      {/* Progress bar below as a fallback visual */}
      <View style={gaugeStyles.barTrack}>
        <View
          style={[
            gaugeStyles.barFill,
            { width: `${percentage}%` as unknown as number, backgroundColor: color },
          ]}
        />
      </View>
      <Text style={[gaugeStyles.statusText, { color }]}>
        {percentage >= 75
          ? 'Good standing'
          : percentage >= 50
          ? 'Needs improvement'
          : 'Critical — below 50%'}
      </Text>
    </View>
  );
}

const gaugeStyles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
    paddingVertical: 20,
  },
  ring: {
    width: 130,
    height: 130,
    borderRadius: 65,
    borderWidth: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  innerCircle: {
    width: 108,
    height: 108,
    borderRadius: 54,
    borderWidth: 6,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  pctText: {
    fontSize: 26,
    fontWeight: '800',
  },
  pctLabel: {
    fontSize: 11,
    color: '#6B7280',
    marginTop: 2,
  },
  barTrack: {
    width: '80%',
    height: 8,
    backgroundColor: '#E5E7EB',
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 8,
  },
  barFill: {
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 13,
    fontWeight: '600',
  },
});

// ── Highlight Card (Star Performer / Needs Attention) ─────────────────────────

function HighlightCard({
  icon,
  label,
  subject,
  average,
  variant,
}: {
  icon: string;
  label: string;
  subject: string;
  average: number;
  variant: 'gold' | 'warning';
}) {
  const bg = variant === 'gold' ? '#FFFBEB' : '#FFF7ED';
  const border = variant === 'gold' ? '#FCD34D' : '#FDBA74';
  const textColor = variant === 'gold' ? '#92400E' : '#9A3412';

  return (
    <View style={[hlStyles.card, { backgroundColor: bg, borderColor: border }]}>
      <Text style={hlStyles.icon}>{icon}</Text>
      <View style={hlStyles.info}>
        <Text style={[hlStyles.label, { color: textColor }]}>{label}</Text>
        <Text style={hlStyles.subject}>{subject}</Text>
      </View>
      <View style={[hlStyles.badge, { backgroundColor: border }]}>
        <Text style={[hlStyles.badgeText, { color: textColor }]}>
          {average.toFixed(1)}%
        </Text>
      </View>
    </View>
  );
}

const hlStyles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1.5,
    padding: 14,
    marginBottom: 12,
  },
  icon: {
    fontSize: 28,
    marginRight: 12,
  },
  info: {
    flex: 1,
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  subject: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
  },
  badge: {
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  badgeText: {
    fontSize: 14,
    fontWeight: '700',
  },
});

// ── Subject Card ──────────────────────────────────────────────────────────────

function SubjectCard({ subject }: { subject: SubjectSummary }) {
  const barColor = averageBarColor(subject.average);
  const trendColor =
    subject.trend === 'improved'
      ? '#15803D'
      : subject.trend === 'dropped'
      ? '#B91C1C'
      : '#6B7280';
  const trendIcon =
    subject.trend === 'improved'
      ? '↑'
      : subject.trend === 'dropped'
      ? '↓'
      : subject.trend === 'first'
      ? '★'
      : '→';

  return (
    <View style={subStyles.card}>
      {/* Subject name + average */}
      <View style={subStyles.header}>
        <Text style={subStyles.name}>{subject.name}</Text>
        <Text style={[subStyles.avg, { color: barColor }]}>
          {subject.average.toFixed(1)}%
        </Text>
      </View>

      {/* Average bar */}
      <View style={subStyles.barTrack}>
        <View
          style={[
            subStyles.barFill,
            {
              width: `${Math.min(subject.average, 100)}%` as unknown as number,
              backgroundColor: barColor,
            },
          ]}
        />
      </View>

      {/* Trend message */}
      <View style={subStyles.trendRow}>
        <Text style={[subStyles.trendIcon, { color: trendColor }]}>{trendIcon}</Text>
        <Text style={[subStyles.trendMsg, { color: trendColor }]}>
          {subject.message}
        </Text>
      </View>

      {/* Latest vs previous score */}
      {subject.latest_score !== null && (
        <View style={subStyles.scoresRow}>
          <View style={subStyles.scoreItem}>
            <Text style={subStyles.scoreLabel}>Latest</Text>
            <Text style={subStyles.scoreValue}>{subject.latest_score.toFixed(1)}%</Text>
          </View>
          {subject.previous_score !== null && (
            <>
              <View style={subStyles.scoreDivider} />
              <View style={subStyles.scoreItem}>
                <Text style={subStyles.scoreLabel}>Previous</Text>
                <Text style={subStyles.scoreValue}>
                  {subject.previous_score.toFixed(1)}%
                </Text>
              </View>
              {subject.change !== null && (
                <>
                  <View style={subStyles.scoreDivider} />
                  <View style={subStyles.scoreItem}>
                    <Text style={subStyles.scoreLabel}>Change</Text>
                    <Text style={[subStyles.scoreValue, { color: trendColor }]}>
                      {subject.change > 0 ? '+' : ''}
                      {subject.change.toFixed(1)}%
                    </Text>
                  </View>
                </>
              )}
            </>
          )}
        </View>
      )}
    </View>
  );
}

const subStyles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  name: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
  },
  avg: {
    fontSize: 16,
    fontWeight: '700',
  },
  barTrack: {
    height: 8,
    backgroundColor: '#F3F4F6',
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 10,
  },
  barFill: {
    height: 8,
    borderRadius: 4,
  },
  trendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    gap: 5,
  },
  trendIcon: {
    fontSize: 14,
    fontWeight: '700',
  },
  trendMsg: {
    fontSize: 13,
    fontWeight: '500',
  },
  scoresRow: {
    flexDirection: 'row',
    backgroundColor: '#F9FAFB',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  scoreItem: {
    flex: 1,
    alignItems: 'center',
  },
  scoreLabel: {
    fontSize: 11,
    color: '#9CA3AF',
    marginBottom: 3,
  },
  scoreValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#374151',
  },
  scoreDivider: {
    width: 1,
    backgroundColor: '#E5E7EB',
    marginVertical: 2,
  },
});

// ── Skeleton ──────────────────────────────────────────────────────────────────

function SkeletonBlock({
  width,
  height,
  style,
}: {
  width: number | string;
  height: number;
  style?: object;
}) {
  return (
    <View
      style={[
        { width, height, borderRadius: 6, backgroundColor: '#E5E7EB' },
        style,
      ]}
    />
  );
}

function PerformanceSkeleton() {
  return (
    <View style={{ padding: 20 }}>
      <SkeletonBlock width="100%" height={160} style={{ borderRadius: 14, marginBottom: 16 }} />
      <SkeletonBlock width="100%" height={72} style={{ borderRadius: 14, marginBottom: 12 }} />
      <SkeletonBlock width="100%" height={72} style={{ borderRadius: 14, marginBottom: 20 }} />
      <SkeletonBlock width="40%" height={16} style={{ marginBottom: 12 }} />
      <SkeletonBlock width="100%" height={120} style={{ borderRadius: 14, marginBottom: 12 }} />
      <SkeletonBlock width="100%" height={120} style={{ borderRadius: 14, marginBottom: 12 }} />
      <SkeletonBlock width="100%" height={120} style={{ borderRadius: 14 }} />
    </View>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PerformanceScreen() {
  const navigation = useNavigation<ParentNavProp>();
  const user = useAuthStore((s) => s.student);

  const [children, setChildren] = useState<Child[]>([]);
  const [selectedChild, setSelectedChild] = useState<Child | null>(null);
  const [performance, setPerformance] = useState<PerformanceSummary | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Fetch children ──────────────────────────────────────────────────────────

  const fetchChildren = useCallback(async (): Promise<Child[]> => {
    const res = await apiClient.get('/api/students', {
      params: { parent_id: user?.id },
    });
    return res.data.data ?? [];
  }, [user?.id]);

  // ── Fetch performance ───────────────────────────────────────────────────────

  const fetchPerformance = useCallback(async (child: Child) => {
    setError(null);
    try {
      const res = await apiClient.get(`/api/performance/${child.id}`);
      setPerformance(res.data.data ?? null);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Failed to load performance data';
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
      try {
        const list = await fetchChildren();
        setChildren(list);
        if (list.length > 0) {
          setSelectedChild(list[0]);
        } else {
          setLoading(false);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to load children';
        setError(msg);
        setLoading(false);
      }
    };
    void init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // When selected child changes, reload performance
  useEffect(() => {
    if (selectedChild) {
      setLoading(true);
      setPerformance(null);
      void fetchPerformance(selectedChild);
    }
  }, [selectedChild, fetchPerformance]);

  // ── Pull-to-refresh ─────────────────────────────────────────────────────────

  const onRefresh = useCallback(() => {
    if (!selectedChild) return;
    setRefreshing(true);
    void fetchPerformance(selectedChild);
  }, [selectedChild, fetchPerformance]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.navigate('Dashboard')}
          accessibilityRole="button"
          accessibilityLabel="Go back to dashboard"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.backArrow}>‹</Text>
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {selectedChild ? selectedChild.full_name : 'Performance'}
          </Text>
          {selectedChild && (
            <Text style={styles.headerSub}>
              {selectedChild.class_name}
              {selectedChild.section ? ` · ${selectedChild.section}` : ''}
            </Text>
          )}
        </View>

        {/* Spacer to balance back button */}
        <View style={styles.backBtn} />
      </View>

      {/* ── Child selector (if multiple children) ──────────────────────────── */}
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
              accessibilityLabel={`View performance for ${child.full_name}`}
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
          <PerformanceSkeleton />
        </ScrollView>
      ) : error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>⚠️ {error}</Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={() => {
              if (selectedChild) {
                setLoading(true);
                void fetchPerformance(selectedChild);
              }
            }}
            accessibilityRole="button"
            accessibilityLabel="Retry loading performance"
          >
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : !performance ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>📊</Text>
          <Text style={styles.emptyText}>No performance data yet.</Text>
          <Text style={styles.emptySubtext}>
            Marks will appear here once recorded by teachers.
          </Text>
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
          {/* ── Attendance gauge ──────────────────────────────────────────── */}
          <View style={styles.section}>
            <View style={styles.sectionCard}>
              <AttendanceGauge percentage={performance.attendance_percentage} />
            </View>
          </View>

          {/* ── Star Performer card ───────────────────────────────────────── */}
          {performance.strongest_subject && (
            <HighlightCard
              icon="⭐"
              label="Star Performer"
              subject={performance.strongest_subject.name}
              average={performance.strongest_subject.average}
              variant="gold"
            />
          )}

          {/* ── Needs Attention card ──────────────────────────────────────── */}
          {performance.weakest_subject &&
            performance.strongest_subject?.name !==
              performance.weakest_subject.name && (
              <HighlightCard
                icon="⚠️"
                label="Needs Attention"
                subject={performance.weakest_subject.name}
                average={performance.weakest_subject.average}
                variant="warning"
              />
            )}

          {/* ── Subject breakdown ─────────────────────────────────────────── */}
          {performance.subjects.length > 0 && (
            <>
              <Text style={styles.sectionTitle}>Subject Breakdown</Text>
              {performance.subjects.map((subject) => (
                <SubjectCard key={subject.name} subject={subject} />
              ))}
            </>
          )}

          {performance.subjects.length === 0 && (
            <View style={styles.noSubjectsBox}>
              <Text style={styles.noSubjectsText}>
                No subject marks recorded yet.
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
  // Header
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
  backBtn: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backArrow: {
    fontSize: 28,
    color: '#1D4ED8',
    lineHeight: 32,
    fontWeight: '300',
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

  // Child tabs
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

  // Scroll
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  content: {
    padding: 16,
    paddingBottom: 48,
  },

  // Section card wrapper
  section: {
    marginBottom: 12,
  },
  sectionCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
    overflow: 'hidden',
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#374151',
    marginBottom: 12,
    marginTop: 4,
  },

  // Error
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

  // Empty state
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
    fontWeight: '600',
    color: '#374151',
    textAlign: 'center',
    marginBottom: 6,
  },
  emptySubtext: {
    fontSize: 13,
    color: '#9CA3AF',
    textAlign: 'center',
  },

  // No subjects
  noSubjectsBox: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
  },
  noSubjectsText: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
  },
});
