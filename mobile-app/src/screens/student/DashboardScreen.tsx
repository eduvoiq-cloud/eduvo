import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  StatusBar,
  ActivityIndicator,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useAuthStore } from '../../store/authStore';
import apiClient from '../../api/client';
import { StudentTabParamList } from '../../navigation/AppNavigator';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AttendanceSummary {
  percentage: number;
  present: number;
  absent: number;
  total: number;
}

interface TodayAttendance {
  status: 'present' | 'absent' | 'late' | 'excused' | null;
  created_at: string | null;
}

interface MarkRecord {
  id: string;
  subject: string;
  score: number;
  max_score: number;
  term: string;
  exam_type: string;
  created_at: string;
}

interface TestRecord {
  id: string;
  title: string;
  subject_id: string;
  date: string;
  time_limit_minutes: number;
  question_count: number;
}

interface DashboardData {
  attendance: AttendanceSummary | null;
  todayAttendance: TodayAttendance;
  recentMarks: MarkRecord[];
  availableTests: TestRecord[];
  feePaid: boolean;
}

type StudentNavProp = BottomTabNavigationProp<StudentTabParamList>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function calcAvgMarks(marks: MarkRecord[]): number {
  if (marks.length === 0) return 0;
  const sum = marks.reduce((acc, m) => acc + Math.round((m.score / m.max_score) * 100), 0);
  return Math.round(sum / marks.length);
}

// ── Attendance status badge ───────────────────────────────────────────────────

function TodayBadge({ status, time }: { status: TodayAttendance['status']; time: string | null }) {
  if (!status) {
    return (
      <View style={[badge.pill, badge.grey]}>
        <Text style={[badge.text, badge.greyText]}>Not marked yet</Text>
      </View>
    );
  }
  if (status === 'present' || status === 'late') {
    return (
      <View style={[badge.pill, badge.green]}>
        <Text style={[badge.text, badge.greenText]}>
          Present{time ? ` · ${formatTime(time)}` : ''}
        </Text>
      </View>
    );
  }
  if (status === 'absent') {
    return (
      <View style={[badge.pill, badge.red]}>
        <Text style={[badge.text, badge.redText]}>Absent today</Text>
      </View>
    );
  }
  return (
    <View style={[badge.pill, badge.amber]}>
      <Text style={[badge.text, badge.amberText]}>
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </Text>
    </View>
  );
}

const badge = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginTop: 8,
  },
  text: { fontSize: 13, fontWeight: '600' },
  green: { backgroundColor: '#DCFCE7' },
  greenText: { color: '#15803D' },
  red: { backgroundColor: '#FEE2E2' },
  redText: { color: '#B91C1C' },
  grey: { backgroundColor: '#F3F4F6' },
  greyText: { color: '#6B7280' },
  amber: { backgroundColor: '#FEF3C7' },
  amberText: { color: '#92400E' },
});

// ── Skeleton block ────────────────────────────────────────────────────────────

function Skeleton({ w, h, style }: { w: number | string; h: number; style?: object }) {
  return <View style={[{ width: w, height: h, borderRadius: 6, backgroundColor: '#E5E7EB' }, style]} />;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function StudentDashboardScreen() {
  const user = useAuthStore((s) => s.user);
  const navigation = useNavigation<StudentNavProp>();

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Fetch all dashboard data in parallel ────────────────────────────────────
  const fetchAll = useCallback(async () => {
    setError(null);
    try {
      const today = todayISO();
      const yearStart = `${new Date().getFullYear()}-01-01`;
      const yearEnd   = `${new Date().getFullYear()}-12-31`;

      // We need the student's own ID — it's stored in the user record
      // The marks and attendance endpoints filter by role automatically
      const [marksRes, testsRes, attHistRes, attTodayRes] = await Promise.allSettled([
        apiClient.get('/api/marks'),
        apiClient.get('/api/tests/student'),
        apiClient.get('/api/attendance/history', {
          params: { student_id: user?.id, start_date: yearStart, end_date: yearEnd },
        }),
        apiClient.get('/api/attendance', {
          params: { student_id: user?.id, date: today },
        }),
      ]);

      // Marks
      const recentMarks: MarkRecord[] =
        marksRes.status === 'fulfilled' ? (marksRes.value.data.data ?? []) : [];

      // Tests — if fee not paid the API returns empty array with a message
      const testsPayload =
        testsRes.status === 'fulfilled' ? testsRes.value.data : null;
      const availableTests: TestRecord[] = testsPayload?.data ?? [];
      // Fee is considered paid if we got tests back OR if the response has data
      const feePaid = availableTests.length > 0 ||
        (testsPayload?.success && !testsPayload?.message?.toLowerCase().includes('fee'));

      // Attendance history summary
      let attendance: AttendanceSummary | null = null;
      if (attHistRes.status === 'fulfilled') {
        const payload = attHistRes.value.data.data ?? {};
        const s = payload.summary;
        if (s) {
          attendance = {
            percentage: s.percentage ?? 0,
            present: s.present ?? 0,
            absent: s.absent ?? 0,
            total: s.total ?? 0,
          };
        }
      }

      // Today's attendance
      let todayAttendance: TodayAttendance = { status: null, created_at: null };
      if (attTodayRes.status === 'fulfilled') {
        const records: Array<{ status: string; created_at: string }> =
          attTodayRes.value.data.data ?? [];
        if (records.length > 0) {
          todayAttendance = {
            status: records[0].status as TodayAttendance['status'],
            created_at: records[0].created_at,
          };
        }
      }

      setData({ attendance, todayAttendance, recentMarks, availableTests, feePaid });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load dashboard';
      console.warn('[StudentDashboard] fetchAll error:', msg);
      setError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user?.id]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchAll();
  }, [fetchAll]);

  const firstName = user?.name?.split(' ')[0] ?? 'there';
  const avgMarks = data ? calcAvgMarks(data.recentMarks) : 0;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
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
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <View style={styles.header}>
          <View>
            <Text style={styles.greeting}>
              {getGreeting()}, {firstName} 👋
            </Text>
            <Text style={styles.subGreeting}>Here's your daily overview</Text>
          </View>
        </View>

        {/* ── Error state ─────────────────────────────────────────────────── */}
        {error && !loading && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>⚠️ {error}</Text>
            <TouchableOpacity
              style={styles.retryButton}
              onPress={() => { setLoading(true); fetchAll(); }}
              accessibilityRole="button"
              accessibilityLabel="Retry loading dashboard"
            >
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Attendance card (big, center) ────────────────────────────────── */}
        <Text style={styles.sectionTitle}>Attendance</Text>

        {loading ? (
          <View style={styles.attendanceCard}>
            <Skeleton w={100} h={72} style={{ alignSelf: 'center', borderRadius: 12 }} />
            <Skeleton w="60%" h={14} style={{ alignSelf: 'center', marginTop: 12 }} />
            <Skeleton w={120} h={28} style={{ alignSelf: 'center', marginTop: 10 }} />
          </View>
        ) : (
          <View style={styles.attendanceCard}>
            {/* Big percentage */}
            <Text style={styles.attendancePct}>
              {data?.attendance?.percentage ?? 0}%
            </Text>
            <Text style={styles.attendanceLabel}>Overall Attendance</Text>

            {/* Sub-stats */}
            {data?.attendance && (
              <View style={styles.attStatsRow}>
                <View style={styles.attStat}>
                  <Text style={[styles.attStatVal, { color: '#22C55E' }]}>
                    {data.attendance.present}
                  </Text>
                  <Text style={styles.attStatLabel}>Present</Text>
                </View>
                <View style={styles.attStatDivider} />
                <View style={styles.attStat}>
                  <Text style={[styles.attStatVal, { color: '#EF4444' }]}>
                    {data.attendance.absent}
                  </Text>
                  <Text style={styles.attStatLabel}>Absent</Text>
                </View>
                <View style={styles.attStatDivider} />
                <View style={styles.attStat}>
                  <Text style={[styles.attStatVal, { color: '#6B7280' }]}>
                    {data.attendance.total}
                  </Text>
                  <Text style={styles.attStatLabel}>Total Days</Text>
                </View>
              </View>
            )}

            {/* Today's status */}
            <View style={styles.todayRow}>
              <Text style={styles.todayLabel}>Today</Text>
              <TodayBadge
                status={data?.todayAttendance.status ?? null}
                time={data?.todayAttendance.created_at ?? null}
              />
            </View>
          </View>
        )}

        {/* ── Quick action cards row ────────────────────────────────────────── */}
        <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Quick Access</Text>

        <View style={styles.quickRow}>
          {/* Marks card */}
          <TouchableOpacity
            style={[styles.quickCard, styles.quickCardBlue]}
            onPress={() => navigation.navigate('Marks')}
            accessibilityRole="button"
            accessibilityLabel="View my marks"
            activeOpacity={0.8}
          >
            <Text style={styles.quickIcon}>📊</Text>
            {loading ? (
              <Skeleton w={60} h={36} style={{ marginVertical: 4 }} />
            ) : (
              <Text style={styles.quickValue}>{avgMarks}%</Text>
            )}
            <Text style={styles.quickLabel}>Avg. Marks</Text>
            <Text style={styles.quickSub}>
              {data?.recentMarks.length ?? 0} record{data?.recentMarks.length !== 1 ? 's' : ''}
            </Text>
            <Text style={styles.quickArrow}>View Performance →</Text>
          </TouchableOpacity>

          {/* Tests card */}
          <TouchableOpacity
            style={[styles.quickCard, styles.quickCardAmber]}
            onPress={() => navigation.navigate('Tests')}
            accessibilityRole="button"
            accessibilityLabel="View available tests"
            activeOpacity={0.8}
          >
            <Text style={styles.quickIcon}>📝</Text>
            {loading ? (
              <Skeleton w={60} h={36} style={{ marginVertical: 4 }} />
            ) : (
              <Text style={[styles.quickValue, { color: '#92400E' }]}>
                {data?.feePaid ? data.availableTests.length : '🔒'}
              </Text>
            )}
            <Text style={[styles.quickLabel, { color: '#78350F' }]}>Tests</Text>
            <Text style={[styles.quickSub, { color: '#92400E' }]}>
              {data?.feePaid ? 'Available' : 'Fee required'}
            </Text>
            <Text style={[styles.quickArrow, { color: '#B45309' }]}>View Tests →</Text>
          </TouchableOpacity>
        </View>

        {/* ── Latest marks summary ──────────────────────────────────────────── */}
        {!loading && data && data.recentMarks.length > 0 && (
          <>
            <View style={styles.sectionRow}>
              <Text style={[styles.sectionTitle, { marginTop: 24, marginBottom: 0 }]}>
                Recent Marks
              </Text>
              <TouchableOpacity
                onPress={() => navigation.navigate('Marks')}
                accessibilityRole="link"
                accessibilityLabel="See all marks"
              >
                <Text style={styles.seeAll}>See all</Text>
              </TouchableOpacity>
            </View>

            <View style={{ marginTop: 12 }}>
              {data.recentMarks.slice(0, 3).map((mark) => {
                const pct = Math.round((mark.score / mark.max_score) * 100);
                const color = pct >= 75 ? '#22C55E' : pct >= 50 ? '#F59E0B' : '#EF4444';
                return (
                  <View key={mark.id} style={styles.markRow}>
                    <View style={styles.markLeft}>
                      <Text style={styles.markSubject}>{mark.subject}</Text>
                      <Text style={styles.markMeta}>
                        {mark.exam_type} · {mark.term}
                      </Text>
                    </View>
                    <View style={styles.markRight}>
                      <Text style={[styles.markScore, { color }]}>
                        {mark.score}/{mark.max_score}
                      </Text>
                      <Text style={[styles.markPct, { color }]}>{pct}%</Text>
                    </View>
                  </View>
                );
              })}
            </View>
          </>
        )}
      </ScrollView>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { padding: 20, paddingBottom: 48 },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 24,
  },
  greeting: { fontSize: 22, fontWeight: '700', color: '#111827' },
  subGreeting: { fontSize: 13, color: '#6B7280', marginTop: 3 },

  errorBox: {
    backgroundColor: '#FEF2F2',
    borderRadius: 10,
    padding: 14,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#FECACA',
    alignItems: 'center',
  },
  errorText: { fontSize: 14, color: '#B91C1C', textAlign: 'center' },
  retryButton: {
    marginTop: 10,
    backgroundColor: '#EF4444',
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  retryText: { color: '#FFFFFF', fontWeight: '600', fontSize: 14 },

  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 12,
  },
  sectionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  seeAll: { fontSize: 13, color: '#1D4ED8', fontWeight: '500' },

  // Attendance card
  attendanceCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 3,
  },
  attendancePct: {
    fontSize: 72,
    fontWeight: '800',
    color: '#1D4ED8',
    lineHeight: 80,
  },
  attendanceLabel: {
    fontSize: 14,
    color: '#6B7280',
    marginTop: 4,
    marginBottom: 16,
  },
  attStatsRow: {
    flexDirection: 'row',
    width: '100%',
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    paddingVertical: 12,
    marginBottom: 16,
  },
  attStat: { flex: 1, alignItems: 'center' },
  attStatVal: { fontSize: 20, fontWeight: '700' },
  attStatLabel: { fontSize: 11, color: '#9CA3AF', marginTop: 2 },
  attStatDivider: { width: 1, backgroundColor: '#E5E7EB', marginVertical: 4 },
  todayRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    paddingTop: 14,
  },
  todayLabel: { fontSize: 14, fontWeight: '600', color: '#374151' },

  // Quick cards
  quickRow: { flexDirection: 'row', gap: 12 },
  quickCard: {
    flex: 1,
    borderRadius: 14,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 5,
    elevation: 2,
  },
  quickCardBlue: { backgroundColor: '#EFF6FF' },
  quickCardAmber: { backgroundColor: '#FFFBEB' },
  quickIcon: { fontSize: 24, marginBottom: 8 },
  quickValue: {
    fontSize: 36,
    fontWeight: '800',
    color: '#1D4ED8',
    lineHeight: 42,
  },
  quickLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1E3A8A',
    marginTop: 4,
  },
  quickSub: { fontSize: 11, color: '#3B82F6', marginTop: 2 },
  quickArrow: {
    fontSize: 12,
    color: '#1D4ED8',
    fontWeight: '500',
    marginTop: 12,
  },

  // Recent marks
  markRow: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  markLeft: { flex: 1 },
  markSubject: { fontSize: 15, fontWeight: '600', color: '#111827' },
  markMeta: { fontSize: 12, color: '#9CA3AF', marginTop: 2, textTransform: 'capitalize' },
  markRight: { alignItems: 'flex-end' },
  markScore: { fontSize: 16, fontWeight: '700' },
  markPct: { fontSize: 12, fontWeight: '500', marginTop: 2 },
});
