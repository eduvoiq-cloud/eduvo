import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  StatusBar,
  TouchableOpacity,
} from 'react-native';
import { Calendar, DateData } from 'react-native-calendars';
import { useAuthStore } from '../../store/authStore';
import { useChildStore } from '../../store/childStore';
import apiClient from '../../api/client';

// ── Types ─────────────────────────────────────────────────────────────────────

type AttendanceStatus = 'present' | 'absent' | 'late' | 'excused';

interface AttendanceRecord {
  date: string;
  status: AttendanceStatus;
  created_at: string;
}

interface AttendanceSummary {
  present: number;
  absent: number;
  late: number;
  total: number;
  percentage: number;
}

interface MarkedDates {
  [date: string]: {
    marked?: boolean;
    dotColor?: string;
    selected?: boolean;
    selectedColor?: string;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusColor(status: AttendanceStatus): string {
  switch (status) {
    case 'present': return '#22C55E';
    case 'late':    return '#F59E0B';
    case 'absent':  return '#EF4444';
    case 'excused': return '#8B5CF6';
    default:        return '#9CA3AF';
  }
}

function statusLabel(status: AttendanceStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatDate(iso: string): string {
  const d = (iso && !iso.endsWith('Z') && !iso.includes('+') && !/\d{2}:\d{2}$/.test(iso))
    ? new Date(iso + 'Z') : new Date(iso);
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

// ── Month filter ──────────────────────────────────────────────────────────────

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// ── Main component ────────────────────────────────────────────────────────────

export default function AttendanceScreen() {
  const student = useAuthStore((s) => s.student);
  const { linkedChildren, activeChildIndex } = useChildStore();
  const activeStudent = linkedChildren.length > 0 ? linkedChildren[activeChildIndex] : student;

  const now = new Date();
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth()); // 0-indexed
  const [selectedYear] = useState(now.getFullYear());
  // allRecords holds the full-year data; records holds the filtered monthly slice
  const [allRecords, setAllRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  // Fetch the entire year in one call — monthly filtering happens client-side
  const fetchAttendance = useCallback(async () => {
    if (!activeStudent?.id) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      const res = await apiClient.get('/api/attendance/history', {
        params: {
          student_id: activeStudent.id,
          start_date: `${selectedYear}-01-01`,
          end_date:   `${selectedYear}-12-31`,
        },
      });
      const data = res.data?.data;
      const fetched: AttendanceRecord[] = data?.records ?? data?.attendance ?? [];
      setAllRecords(fetched);
    } catch (err) {
      console.warn('[Attendance] fetch error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeStudent?.id, selectedYear]);

  useEffect(() => {
    setLoading(true);
    setAllRecords([]);
    fetchAttendance();
  }, [fetchAttendance]);

  // Derive monthly records for the calendar
  const records = allRecords.filter((r) => {
    const [y, m] = r.date.split('-').map(Number);
    return y === selectedYear && m === selectedMonth + 1;
  });

  // Derive yearly summary directly from allRecords — no separate API call needed
  const summary: AttendanceSummary | null = allRecords.length > 0 ? (() => {
    const present = allRecords.filter((r) => r.status === 'present' || r.status === 'late' || r.status === 'excused').length;
    const absent  = allRecords.filter((r) => r.status === 'absent').length;
    const late    = allRecords.filter((r) => r.status === 'late').length;
    const total   = allRecords.length;
    return {
      present,
      absent,
      late,
      total,
      percentage: total > 0 ? Math.round((present / total) * 100) : 0,
    };
  })() : null;

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchAttendance();
  }, [fetchAttendance]);

  // Build marked dates for calendar
  const markedDates: MarkedDates = {};
  for (const rec of allRecords) {
    const color = statusColor(rec.status);
    markedDates[rec.date] = {
      marked: true,
      dotColor: color,
      ...(selectedDate === rec.date && { selected: true, selectedColor: color }),
    };
  }
  if (selectedDate && !markedDates[selectedDate]) {
    markedDates[selectedDate] = { selected: true, selectedColor: '#9CA3AF' };
  }

  const selectedRecord = allRecords.find((r) => r.date === selectedDate);

  const calendarMonth = `${selectedYear}-${String(selectedMonth + 1).padStart(2, '0')}-01`;

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
        {/* Child name header */}
        {activeStudent && (
          <Text style={styles.childName}>{activeStudent.name}</Text>
        )}

        {/* Stats row */}
        {loading ? (
          <ActivityIndicator size="large" color="#1D4ED8" style={{ marginVertical: 24 }} />
        ) : (
          <View style={styles.statsRow}>
            <View style={styles.statBox}>
              <Text style={[styles.statValue, { color: '#22C55E' }]}>
                {summary?.present ?? 0}
              </Text>
              <Text style={styles.statLabel}>Present</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statBox}>
              <Text style={[styles.statValue, { color: '#EF4444' }]}>
                {summary?.absent ?? 0}
              </Text>
              <Text style={styles.statLabel}>Absent</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statBox}>
              <Text style={[styles.statValue, { color: '#1D4ED8' }]}>
                {summary?.percentage ?? 0}%
              </Text>
              <Text style={styles.statLabel}>Percentage</Text>
            </View>
          </View>
        )}

        {/* Month filter */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.monthScroll}
          contentContainerStyle={styles.monthContent}
        >
          {MONTHS.map((m, idx) => (
            <TouchableOpacity
              key={m}
              style={[styles.monthChip, selectedMonth === idx && styles.monthChipActive]}
              onPress={() => { setSelectedMonth(idx); setSelectedDate(null); }}
              accessibilityRole="button"
              accessibilityLabel={m}
              accessibilityState={{ selected: selectedMonth === idx }}
            >
              <Text style={[styles.monthChipText, selectedMonth === idx && styles.monthChipTextActive]}>
                {m.slice(0, 3)}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Calendar */}
        <View style={styles.calendarWrapper}>
          <Calendar
            key={calendarMonth}
            current={calendarMonth}
            markedDates={markedDates}
            onDayPress={(day: DateData) => {
              setSelectedDate((prev) => (prev === day.dateString ? null : day.dateString));
            }}
            hideArrows
            disableMonthChange
            theme={{
              backgroundColor: '#FFFFFF',
              calendarBackground: '#FFFFFF',
              todayTextColor: '#1D4ED8',
              selectedDayBackgroundColor: '#1D4ED8',
              selectedDayTextColor: '#FFFFFF',
              dayTextColor: '#111827',
              textDisabledColor: '#D1D5DB',
              dotColor: '#1D4ED8',
              arrowColor: '#1D4ED8',
              monthTextColor: '#111827',
              textMonthFontWeight: '700',
              textDayFontSize: 14,
              textMonthFontSize: 16,
            }}
          />
        </View>

        {/* Legend */}
        <View style={styles.legend}>
          {(['present', 'absent', 'late', 'excused'] as AttendanceStatus[]).map((s) => (
            <View key={s} style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: statusColor(s) }]} />
              <Text style={styles.legendText}>{statusLabel(s)}</Text>
            </View>
          ))}
        </View>

        {/* Selected date detail */}
        {selectedDate && (
          <View style={styles.detailCard}>
            <Text style={styles.detailDate}>{formatDate(selectedDate)}</Text>
            {selectedRecord ? (
              <View style={[styles.statusBadge, { backgroundColor: statusColor(selectedRecord.status) + '20' }]}>
                <Text style={[styles.statusBadgeText, { color: statusColor(selectedRecord.status) }]}>
                  {statusLabel(selectedRecord.status)}
                </Text>
              </View>
            ) : (
              <Text style={styles.noRecord}>No attendance record for this date.</Text>
            )}
          </View>
        )}
      </ScrollView>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { padding: 20, paddingBottom: 48 },
  childName: { fontSize: 18, fontWeight: '700', color: '#111827', marginBottom: 16 },
  statsRow: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    paddingVertical: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 5,
    elevation: 2,
  },
  statBox: { flex: 1, alignItems: 'center' },
  statValue: { fontSize: 24, fontWeight: '800' },
  statLabel: { fontSize: 11, color: '#9CA3AF', marginTop: 3 },
  statDivider: { width: 1, backgroundColor: '#E5E7EB', marginVertical: 4 },
  monthScroll: { maxHeight: 44, marginBottom: 12 },
  monthContent: { paddingRight: 8, gap: 8, flexDirection: 'row' },
  monthChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#F3F4F6',
  },
  monthChipActive: { backgroundColor: '#DBEAFE' },
  monthChipText: { fontSize: 13, fontWeight: '500', color: '#6B7280' },
  monthChipTextActive: { color: '#1D4ED8', fontWeight: '700' },
  calendarWrapper: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 5,
    elevation: 2,
    marginBottom: 12,
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 16,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: 12, color: '#6B7280' },
  detailCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 5,
    elevation: 2,
  },
  detailDate: { fontSize: 15, fontWeight: '600', color: '#111827', marginBottom: 10 },
  statusBadge: {
    alignSelf: 'flex-start',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  statusBadgeText: { fontSize: 14, fontWeight: '700' },
  noRecord: { fontSize: 14, color: '#9CA3AF' },
});
