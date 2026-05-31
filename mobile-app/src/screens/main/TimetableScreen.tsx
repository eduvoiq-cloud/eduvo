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
import { useAuthStore } from '../../store/authStore';
import { useChildStore } from '../../store/childStore';
import apiClient from '../../api/client';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Period {
  id: string;
  period_number: number;
  start_time: string;
  end_time: string;
  subject_name: string;
  teacher_name: string;
  day: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Assign a consistent color per subject (hash-based)
const SUBJECT_COLORS = [
  '#DBEAFE', '#DCFCE7', '#FEF3C7', '#FCE7F3', '#EDE9FE', '#FFEDD5',
  '#E0F2FE', '#F0FDF4', '#FFF7ED', '#F5F3FF',
];

function subjectColor(subject: string): string {
  let hash = 0;
  for (let i = 0; i < subject.length; i++) hash = subject.charCodeAt(i) + ((hash << 5) - hash);
  return SUBJECT_COLORS[Math.abs(hash) % SUBJECT_COLORS.length];
}

function subjectTextColor(subject: string): string {
  const colors = [
    '#1D4ED8', '#15803D', '#92400E', '#9D174D', '#5B21B6', '#C2410C',
    '#0369A1', '#166534', '#C2410C', '#4C1D95',
  ];
  let hash = 0;
  for (let i = 0; i < subject.length; i++) hash = subject.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function todayDayIndex(): number {
  const day = new Date().getDay(); // 0=Sun
  if (day === 0) return 0; // Sunday → show Monday
  return Math.min(day - 1, 5); // Mon=0 ... Sat=5
}

// ── Period card ───────────────────────────────────────────────────────────────

function PeriodCard({ period }: { period: Period }) {
  const bg = subjectColor(period.subject_name);
  const textColor = subjectTextColor(period.subject_name);

  return (
    <View style={[periodStyles.card, { backgroundColor: bg }]}>
      <View style={[periodStyles.colorBar, { backgroundColor: textColor }]} />
      <View style={periodStyles.body}>
        <View style={periodStyles.timeRow}>
          <Text style={[periodStyles.time, { color: textColor }]}>
            {period.start_time} – {period.end_time}
          </Text>
          <Text style={periodStyles.periodNum}>Period {period.period_number}</Text>
        </View>
        <Text style={[periodStyles.subject, { color: textColor }]}>{period.subject_name}</Text>
        {period.teacher_name ? (
          <Text style={periodStyles.teacher}>👤 {period.teacher_name}</Text>
        ) : null}
      </View>
    </View>
  );
}

const periodStyles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    borderRadius: 12,
    marginBottom: 10,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  colorBar: { width: 4 },
  body: { flex: 1, padding: 14 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  time: { fontSize: 12, fontWeight: '600' },
  periodNum: { fontSize: 11, color: '#9CA3AF' },
  subject: { fontSize: 16, fontWeight: '700', marginBottom: 4 },
  teacher: { fontSize: 12, color: '#6B7280' },
});

// ── Main component ────────────────────────────────────────────────────────────

export default function TimetableScreen() {
  const student = useAuthStore((s) => s.student);
  const { linkedChildren, activeChildIndex } = useChildStore();
  const activeStudent = linkedChildren.length > 0 ? linkedChildren[activeChildIndex] : student;

  const [selectedDay, setSelectedDay] = useState(todayDayIndex());
  const [timetable, setTimetable] = useState<Record<string, Period[]>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchTimetable = useCallback(async () => {
    try {
      const response = await apiClient.get('/api/timetable/class', {
        params: {
          class: activeStudent?.class,
          section: activeStudent?.section,
        },
      });
      const data: Period[] = response.data.data ?? [];

      // Group by day
      const grouped: Record<string, Period[]> = {};
      for (const period of data) {
        const day = period.day;
        if (!grouped[day]) grouped[day] = [];
        grouped[day].push(period);
      }
      // Sort each day's periods by period_number
      for (const day of Object.keys(grouped)) {
        grouped[day].sort((a, b) => a.period_number - b.period_number);
      }
      setTimetable(grouped);
    } catch (err) {
      console.warn('[Timetable] fetch error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeStudent?.class, activeStudent?.section]);

  useEffect(() => { fetchTimetable(); }, [fetchTimetable]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchTimetable();
  }, [fetchTimetable]);

  const currentDayName = DAYS[selectedDay];
  const periods = timetable[currentDayName] ?? [];

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <View style={styles.container}>
        {/* Day tabs */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.dayTabsScroll}
          contentContainerStyle={styles.dayTabsContent}
        >
          {DAYS.map((day, idx) => (
            <TouchableOpacity
              key={day}
              style={[styles.dayTab, selectedDay === idx && styles.dayTabActive]}
              onPress={() => setSelectedDay(idx)}
              accessibilityRole="tab"
              accessibilityLabel={day}
              accessibilityState={{ selected: selectedDay === idx }}
            >
              <Text style={[styles.dayTabText, selectedDay === idx && styles.dayTabTextActive]}>
                {DAY_SHORT[idx]}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Periods list */}
        <ScrollView
          style={styles.periodsScroll}
          contentContainerStyle={styles.periodsContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1D4ED8" />
          }
        >
          <Text style={styles.dayTitle}>{currentDayName}</Text>

          {loading ? (
            <ActivityIndicator size="large" color="#1D4ED8" style={{ marginTop: 40 }} />
          ) : periods.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>📅</Text>
              <Text style={styles.emptyText}>No classes scheduled for {currentDayName}.</Text>
            </View>
          ) : (
            periods.map((period) => (
              <PeriodCard key={period.id} period={period} />
            ))
          )}
        </ScrollView>
      </View>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  dayTabsScroll: {
    maxHeight: 52,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  dayTabsContent: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
    flexDirection: 'row',
  },
  dayTab: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#F3F4F6',
  },
  dayTabActive: { backgroundColor: '#1D4ED8' },
  dayTabText: { fontSize: 13, fontWeight: '600', color: '#6B7280' },
  dayTabTextActive: { color: '#FFFFFF' },
  periodsScroll: { flex: 1 },
  periodsContent: { padding: 20, paddingBottom: 48 },
  dayTitle: { fontSize: 20, fontWeight: '700', color: '#111827', marginBottom: 16 },
  emptyState: { alignItems: 'center', marginTop: 60 },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyText: { fontSize: 15, color: '#9CA3AF', textAlign: 'center' },
});
