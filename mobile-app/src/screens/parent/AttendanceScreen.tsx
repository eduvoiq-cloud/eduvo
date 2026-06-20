import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Calendar, DateData } from 'react-native-calendars';
import { useNavigation } from '@react-navigation/native';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import apiClient from '../../api/client';
import { useAuthStore } from '../../store/authStore';
import { ParentTabParamList } from '../../navigation/AppNavigator';
import { formatTime } from '../../utils/dateUtils';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Child {
  id: string;
  full_name: string;
  class_name: string;
  section?: string;
}

interface AttendanceRecord {
  id: string;
  date: string;        // YYYY-MM-DD
  status: 'present' | 'absent' | 'late' | 'excused';
  source: string;
  created_at: string;  // ISO timestamp — used for "marked at HH:MM"
}

interface AttendanceSummary {
  total: number;
  present: number;
  absent: number;
  late: number;
  excused: number;
  percentage: number;
}

type MarkedDates = Record<string, {
  dots?: Array<{ key: string; color: string }>;
  selected?: boolean;
  selectedColor?: string;
}>;

type ParentNavProp = BottomTabNavigationProp<ParentTabParamList>;

// ── Constants ─────────────────────────────────────────────────────────────────

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const STATUS_COLOR: Record<string, string> = {
  present: '#22C55E',
  absent:  '#EF4444',
  late:    '#F59E0B',
  excused: '#6366F1',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDisplayDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({
  label, value, color,
}: { label: string; value: string | number; color: string }) {
  return (
    <View style={[statStyles.card, { borderTopColor: color }]}>
      <Text style={[statStyles.value, { color }]}>{value}</Text>
      <Text style={statStyles.label}>{label}</Text>
    </View>
  );
}

const statStyles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    borderTopWidth: 3,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems: 'center',
    marginHorizontal: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
  },
  value: {
    fontSize: 20,
    fontWeight: '700',
  },
  label: {
    fontSize: 11,
    color: '#6B7280',
    marginTop: 3,
    textAlign: 'center',
  },
});

// ── Main component ────────────────────────────────────────────────────────────

export default function ParentAttendanceScreen() {
  const navigation = useNavigation<ParentNavProp>();
  const user = useAuthStore((s) => s.student);

  // ── State ───────────────────────────────────────────────────────────────────
  const [children, setChildren] = useState<Child[]>([]);
  const [selectedChild, setSelectedChild] = useState<Child | null>(null);

  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [summary, setSummary] = useState<AttendanceSummary | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  // Monthly summary state
  const now = new Date();
  const [summaryYear, setSummaryYear] = useState(now.getFullYear());
  const [summaryMonth, setSummaryMonth] = useState(now.getMonth() + 1); // 1-based

  // ── Fetch children ──────────────────────────────────────────────────────────
  const fetchChildren = useCallback(async () => {
    try {
      const res = await apiClient.get('/api/students', {
        params: { parent_id: user?.id },
      });
      const list: Child[] = res.data.data ?? [];
      setChildren(list);
      if (list.length > 0 && !selectedChild) {
        setSelectedChild(list[0]);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load children';
      setError(msg);
    }
  }, [user?.id, selectedChild]);

  // ── Fetch attendance history (full year for calendar) ───────────────────────
  const fetchHistory = useCallback(async (child: Child) => {
    setError(null);
    try {
      // Fetch the full current year so the calendar has all data
      const year = now.getFullYear();
      const startDate = `${year}-01-01`;
      const endDate   = `${year}-12-31`;

      const res = await apiClient.get('/api/attendance/history', {
        params: { student_id: child.id, start_date: startDate, end_date: endDate },
      });

      const payload = res.data.data ?? {};
      setRecords(payload.records ?? []);

      // Normalise summary: backend returns present_count/absent_count/total_days
      // but the AttendanceSummary interface uses present/absent/total
      const raw = payload.summary ?? null;
      if (raw) {
        setSummary({
          total:      raw.total      ?? raw.total_days     ?? 0,
          present:    raw.present    ?? raw.present_count  ?? 0,
          absent:     raw.absent     ?? raw.absent_count   ?? 0,
          late:       raw.late       ?? raw.late_count     ?? 0,
          excused:    raw.excused    ?? raw.excused_count  ?? 0,
          percentage: raw.percentage ?? 0,
        });
      } else {
        setSummary(null);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load attendance';
      setError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Initial load ────────────────────────────────────────────────────────────
  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await fetchChildren();
    };
    void init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // When selected child changes, reload history
  useEffect(() => {
    if (selectedChild) {
      setLoading(true);
      setRecords([]);
      setSummary(null);
      setSelectedDate(null);
      void fetchHistory(selectedChild);
    }
  }, [selectedChild, fetchHistory]);

  // ── Pull-to-refresh ─────────────────────────────────────────────────────────
  const onRefresh = useCallback(() => {
    if (!selectedChild) return;
    setRefreshing(true);
    void fetchHistory(selectedChild);
  }, [selectedChild, fetchHistory]);

  // ── Build calendar marked dates ─────────────────────────────────────────────
  const markedDates = useMemo<MarkedDates>(() => {
    const marks: MarkedDates = {};

    records.forEach((r) => {
      const color = STATUS_COLOR[r.status] ?? '#9CA3AF';
      marks[r.date] = {
        dots: [{ key: r.status, color }],
      };
    });

    // Highlight selected date
    if (selectedDate) {
      marks[selectedDate] = {
        ...marks[selectedDate],
        selected: true,
        selectedColor: '#1D4ED8',
      };
    }

    return marks;
  }, [records, selectedDate]);

  // ── Selected date detail ────────────────────────────────────────────────────
  const selectedRecord = useMemo<AttendanceRecord | null>(() => {
    if (!selectedDate) return null;
    return records.find((r) => r.date === selectedDate) ?? null;
  }, [records, selectedDate]);

  // ── Monthly summary data ────────────────────────────────────────────────────
  const monthlyData = useMemo(() => {
    const monthRecords = records.filter((r) => {
      const [y, m] = r.date.split('-').map(Number);
      return y === summaryYear && m === summaryMonth;
    });

    const total   = monthRecords.length;
    const present = monthRecords.filter((r) => r.status === 'present').length;
    const absent  = monthRecords.filter((r) => r.status === 'absent').length;
    const late    = monthRecords.filter((r) => r.status === 'late').length;
    const pct     = total > 0 ? Math.round((present / total) * 100) : 0;

    const absentDates = monthRecords
      .filter((r) => r.status === 'absent')
      .map((r) => r.date)
      .sort();

    return { total, present, absent, late, pct, absentDates };
  }, [records, summaryYear, summaryMonth]);

  // ── Month picker helpers ────────────────────────────────────────────────────
  const prevMonth = () => {
    if (summaryMonth === 1) { setSummaryMonth(12); setSummaryYear((y) => y - 1); }
    else { setSummaryMonth((m) => m - 1); }
  };
  const nextMonth = () => {
    const currentYear  = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    if (summaryYear > currentYear || (summaryYear === currentYear && summaryMonth >= currentMonth)) return;
    if (summaryMonth === 12) { setSummaryMonth(1); setSummaryYear((y) => y + 1); }
    else { setSummaryMonth((m) => m + 1); }
  };
  const isNextDisabled =
    summaryYear > now.getFullYear() ||
    (summaryYear === now.getFullYear() && summaryMonth >= now.getMonth() + 1);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      {/* ── Custom header ──────────────────────────────────────────────────── */}
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
            {selectedChild ? selectedChild.full_name : 'Attendance'}
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
              accessibilityLabel={`View attendance for ${child.full_name}`}
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

        {/* ── Loading state ─────────────────────────────────────────────────── */}
        {loading ? (
          <ActivityIndicator size="large" color="#1D4ED8" style={styles.loader} />
        ) : error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>⚠️ {error}</Text>
            <TouchableOpacity
              style={styles.retryBtn}
              onPress={() => { if (selectedChild) { setLoading(true); void fetchHistory(selectedChild); } }}
              accessibilityRole="button"
              accessibilityLabel="Retry loading attendance"
            >
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {/* ── Top stats row ──────────────────────────────────────────────── */}
            {summary && (
              <View style={styles.statsRow}>
                <StatCard
                  label="Attendance %"
                  value={`${summary.percentage}%`}
                  color="#1D4ED8"
                />
                <StatCard
                  label="Present"
                  value={summary.present}
                  color="#22C55E"
                />
                <StatCard
                  label="Absent"
                  value={summary.absent}
                  color="#EF4444"
                />
                <StatCard
                  label="Total Days"
                  value={summary.total}
                  color="#6B7280"
                />
              </View>
            )}

            {/* ── Calendar ───────────────────────────────────────────────────── */}
            <View style={styles.calendarCard}>
              <Calendar
                markingType="multi-dot"
                markedDates={markedDates}
                onDayPress={(day: DateData) => {
                  setSelectedDate((prev) =>
                    prev === day.dateString ? null : day.dateString
                  );
                }}
                theme={{
                  todayTextColor: '#1D4ED8',
                  arrowColor: '#1D4ED8',
                  selectedDayBackgroundColor: '#1D4ED8',
                  dotColor: '#1D4ED8',
                  textDayFontSize: 14,
                  textMonthFontSize: 15,
                  textMonthFontWeight: '600',
                  calendarBackground: '#FFFFFF',
                }}
              />

              {/* ── Legend ─────────────────────────────────────────────────── */}
              <View style={styles.legend}>
                {Object.entries(STATUS_COLOR).map(([status, color]) => (
                  <View key={status} style={styles.legendItem}>
                    <View style={[styles.legendDot, { backgroundColor: color }]} />
                    <Text style={styles.legendLabel}>
                      {status.charAt(0).toUpperCase() + status.slice(1)}
                    </Text>
                  </View>
                ))}
              </View>
            </View>

            {/* ── Date detail panel ──────────────────────────────────────────── */}
            {selectedDate && (
              <View style={styles.detailCard}>
                <Text style={styles.detailDateLabel}>
                  {formatDisplayDate(selectedDate)}
                </Text>

                {selectedRecord ? (
                  <View style={styles.detailRow}>
                    <View
                      style={[
                        styles.statusPill,
                        { backgroundColor: (STATUS_COLOR[selectedRecord.status] ?? '#9CA3AF') + '20' },
                      ]}
                    >
                      <View
                        style={[
                          styles.statusDot,
                          { backgroundColor: STATUS_COLOR[selectedRecord.status] ?? '#9CA3AF' },
                        ]}
                      />
                      <Text
                        style={[
                          styles.statusPillText,
                          { color: STATUS_COLOR[selectedRecord.status] ?? '#9CA3AF' },
                        ]}
                      >
                        {selectedRecord.status.charAt(0).toUpperCase() + selectedRecord.status.slice(1)}
                      </Text>
                    </View>

                    {selectedRecord.status === 'present' || selectedRecord.status === 'late' ? (
                      <Text style={styles.detailTime}>
                        Marked at {formatTime(selectedRecord.created_at)}
                      </Text>
                    ) : (
                      <Text style={styles.detailTime}>No arrival recorded</Text>
                    )}
                  </View>
                ) : (
                  <Text style={styles.noRecordText}>
                    No school record for this day
                  </Text>
                )}
              </View>
            )}

            {/* ── Monthly summary ────────────────────────────────────────────── */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Monthly Summary</Text>
            </View>

            {/* Month picker */}
            <View style={styles.monthPicker}>
              <TouchableOpacity
                onPress={prevMonth}
                style={styles.monthArrowBtn}
                accessibilityRole="button"
                accessibilityLabel="Previous month"
              >
                <Text style={styles.monthArrow}>‹</Text>
              </TouchableOpacity>

              <Text style={styles.monthLabel}>
                {MONTHS[summaryMonth - 1]} {summaryYear}
              </Text>

              <TouchableOpacity
                onPress={nextMonth}
                style={[styles.monthArrowBtn, isNextDisabled && styles.monthArrowDisabled]}
                disabled={isNextDisabled}
                accessibilityRole="button"
                accessibilityLabel="Next month"
              >
                <Text style={[styles.monthArrow, isNextDisabled && { color: '#D1D5DB' }]}>›</Text>
              </TouchableOpacity>
            </View>

            {/* Monthly stats */}
            <View style={styles.monthStatsRow}>
              <View style={styles.monthStatItem}>
                <Text style={[styles.monthStatValue, { color: '#22C55E' }]}>
                  {monthlyData.present}
                </Text>
                <Text style={styles.monthStatLabel}>Present</Text>
              </View>
              <View style={styles.monthStatDivider} />
              <View style={styles.monthStatItem}>
                <Text style={[styles.monthStatValue, { color: '#EF4444' }]}>
                  {monthlyData.absent}
                </Text>
                <Text style={styles.monthStatLabel}>Absent</Text>
              </View>
              <View style={styles.monthStatDivider} />
              <View style={styles.monthStatItem}>
                <Text style={[styles.monthStatValue, { color: '#F59E0B' }]}>
                  {monthlyData.late}
                </Text>
                <Text style={styles.monthStatLabel}>Late</Text>
              </View>
              <View style={styles.monthStatDivider} />
              <View style={styles.monthStatItem}>
                <Text style={[styles.monthStatValue, { color: '#1D4ED8' }]}>
                  {monthlyData.pct}%
                </Text>
                <Text style={styles.monthStatLabel}>Rate</Text>
              </View>
            </View>

            {/* Absent dates list */}
            {monthlyData.absentDates.length > 0 ? (
              <View style={styles.absentList}>
                <Text style={styles.absentListTitle}>Absent Dates</Text>
                {monthlyData.absentDates.map((date) => (
                  <TouchableOpacity
                    key={date}
                    style={styles.absentDateRow}
                    onPress={() => setSelectedDate(date)}
                    accessibilityRole="button"
                    accessibilityLabel={`View details for ${formatDisplayDate(date)}`}
                  >
                    <View style={styles.absentDot} />
                    <Text style={styles.absentDateText}>
                      {formatDisplayDate(date)}
                    </Text>
                    <Text style={styles.absentChevron}>›</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : (
              <View style={styles.noAbsentBox}>
                <Text style={styles.noAbsentText}>
                  {monthlyData.total === 0
                    ? 'No attendance records for this month.'
                    : '🎉 No absences this month!'}
                </Text>
              </View>
            )}
          </>
        )}
      </ScrollView>
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

  // Scroll content
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  content: {
    padding: 16,
    paddingBottom: 48,
  },

  // Loading / error
  loader: {
    marginTop: 60,
  },
  errorBox: {
    backgroundColor: '#FEF2F2',
    borderRadius: 12,
    padding: 16,
    marginTop: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  errorText: {
    fontSize: 14,
    color: '#B91C1C',
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: 12,
    backgroundColor: '#EF4444',
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 8,
  },
  retryText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },

  // Stats row
  statsRow: {
    flexDirection: 'row',
    marginBottom: 16,
    marginHorizontal: -4,
  },

  // Calendar card
  calendarCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    overflow: 'hidden',
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  legendDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  legendLabel: {
    fontSize: 12,
    color: '#6B7280',
  },

  // Date detail
  detailCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
  },
  detailDateLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 12,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 5,
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusPillText: {
    fontSize: 13,
    fontWeight: '600',
  },
  detailTime: {
    fontSize: 13,
    color: '#6B7280',
  },
  noRecordText: {
    fontSize: 13,
    color: '#9CA3AF',
    fontStyle: 'italic',
  },

  // Monthly summary
  sectionHeader: {
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#374151',
  },
  monthPicker: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  monthArrowBtn: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  monthArrowDisabled: {
    opacity: 0.3,
  },
  monthArrow: {
    fontSize: 26,
    color: '#1D4ED8',
    lineHeight: 30,
    fontWeight: '300',
  },
  monthLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  monthStatsRow: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    paddingVertical: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  monthStatItem: {
    flex: 1,
    alignItems: 'center',
  },
  monthStatValue: {
    fontSize: 22,
    fontWeight: '700',
  },
  monthStatLabel: {
    fontSize: 11,
    color: '#6B7280',
    marginTop: 3,
  },
  monthStatDivider: {
    width: 1,
    backgroundColor: '#F3F4F6',
    marginVertical: 4,
  },
  absentList: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  absentListTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 10,
  },
  absentDateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#F9FAFB',
  },
  absentDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#EF4444',
    marginRight: 10,
  },
  absentDateText: {
    flex: 1,
    fontSize: 13,
    color: '#374151',
  },
  absentChevron: {
    fontSize: 18,
    color: '#9CA3AF',
  },
  noAbsentBox: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  noAbsentText: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
  },
});
