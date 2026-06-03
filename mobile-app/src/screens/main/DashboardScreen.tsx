import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  StatusBar,
  Modal,
  ActivityIndicator,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useAuthStore } from '../../store/authStore';
import { useChildStore } from '../../store/childStore';
import apiClient from '../../api/client';
import { MainTabParamList } from '../../navigation/AppNavigator';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AttendanceSummary {
  percentage: number;
  present: number;
  absent: number;
  total: number;
  todayStatus: 'present' | 'absent' | 'late' | 'excused' | null;
}

interface HomeworkSummary {
  pendingCount: number;
}

interface NextPeriod {
  subject: string;
  teacher: string;
  time: string;
}

interface RecentMark {
  subject: string;
  score: number;
  max_score: number;
}

interface Announcement {
  id: string;
  title: string;
  message: string;
  created_at: string;
}

interface DashboardData {
  attendance: AttendanceSummary | null;
  homework: HomeworkSummary;
  nextPeriod: NextPeriod | null;
  recentMark: RecentMark | null;
  announcement: Announcement | null;
}

type MainNavProp = BottomTabNavigationProp<MainTabParamList>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function todayDayName(): string {
  return new Date().toLocaleDateString('en-US', { weekday: 'long' });
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Child switcher dropdown ───────────────────────────────────────────────────

function ChildSwitcher() {
  const { linkedChildren, activeChildIndex, switchChild } = useChildStore();
  const [open, setOpen] = useState(false);

  if (linkedChildren.length < 2) return null;

  const active = linkedChildren[activeChildIndex];

  return (
    <View style={switcherStyles.wrapper}>
      <TouchableOpacity
        style={switcherStyles.trigger}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Viewing ${active?.name}. Tap to switch child.`}
      >
        <Text style={switcherStyles.label}>Viewing: </Text>
        <Text style={switcherStyles.name}>{active?.name ?? '—'}</Text>
        <Text style={switcherStyles.arrow}> ▼</Text>
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity
          style={switcherStyles.overlay}
          activeOpacity={1}
          onPress={() => setOpen(false)}
        >
          <View style={switcherStyles.dropdown}>
            <Text style={switcherStyles.dropdownTitle}>Switch Child</Text>
            {linkedChildren.map((child, idx) => (
              <TouchableOpacity
                key={child.phone}
                style={[
                  switcherStyles.dropdownItem,
                  idx === activeChildIndex && switcherStyles.dropdownItemActive,
                ]}
                onPress={() => { switchChild(idx); setOpen(false); }}
                accessibilityRole="button"
                accessibilityLabel={`Switch to ${child.name}`}
              >
                <Text style={switcherStyles.dropdownName}>{child.name}</Text>
                <Text style={switcherStyles.dropdownMeta}>
                  Class {child.class} {child.section}
                </Text>
                {idx === activeChildIndex && (
                  <Text style={switcherStyles.activeCheck}>✓</Text>
                )}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const switcherStyles = StyleSheet.create({
  wrapper: { marginBottom: 16 },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#EFF6FF',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignSelf: 'flex-start',
  },
  label: { fontSize: 13, color: '#6B7280' },
  name: { fontSize: 13, fontWeight: '700', color: '#1D4ED8' },
  arrow: { fontSize: 11, color: '#1D4ED8' },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  dropdown: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  dropdownTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 12,
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  dropdownItemActive: { backgroundColor: '#F0F9FF', borderRadius: 8, paddingHorizontal: 8 },
  dropdownName: { fontSize: 15, fontWeight: '600', color: '#111827', flex: 1 },
  dropdownMeta: { fontSize: 12, color: '#9CA3AF', marginRight: 8 },
  activeCheck: { fontSize: 16, color: '#1D4ED8', fontWeight: '700' },
});

// ── Dashboard card ────────────────────────────────────────────────────────────

function DashCard({
  icon,
  title,
  value,
  sub,
  color,
  onPress,
}: {
  icon: string;
  title: string;
  value: string;
  sub: string;
  color: string;
  onPress?: () => void;
}) {
  return (
    <TouchableOpacity
      style={[cardStyles.card, { borderTopColor: color }]}
      onPress={onPress}
      activeOpacity={onPress ? 0.8 : 1}
      accessibilityRole={onPress ? 'button' : 'none'}
      accessibilityLabel={`${title}: ${value}`}
    >
      <Text style={cardStyles.icon}>{icon}</Text>
      <Text style={cardStyles.title}>{title}</Text>
      <Text style={[cardStyles.value, { color }]}>{value}</Text>
      <Text style={cardStyles.sub} numberOfLines={2}>{sub}</Text>
    </TouchableOpacity>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 14,
    borderTopWidth: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 5,
    elevation: 2,
    minWidth: '45%',
  },
  icon: { fontSize: 22, marginBottom: 6 },
  title: { fontSize: 11, color: '#9CA3AF', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 },
  value: { fontSize: 22, fontWeight: '800', marginBottom: 2 },
  sub: { fontSize: 11, color: '#6B7280', lineHeight: 16 },
});

// ── Main component ────────────────────────────────────────────────────────────

export default function DashboardScreen() {
  const student = useAuthStore((s) => s.student);
  const { linkedChildren, activeChildIndex } = useChildStore();
  const navigation = useNavigation<MainNavProp>();

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notifCount, setNotifCount] = useState(0);

  // Active student: if linked children exist, use active child; else use logged-in student
  const activeStudent =
    linkedChildren.length > 0 ? linkedChildren[activeChildIndex] : student;

  const fetchAll = useCallback(async () => {
    try {
      const today = todayISO();
      const yearStart = `${new Date().getFullYear()}-01-01`;
      const yearEnd = `${new Date().getFullYear()}-12-31`;

      const [attHistRes, attTodayRes, hwRes, marksRes, timetableRes, notifRes] =
        await Promise.allSettled([
          apiClient.get('/api/attendance/history', {
            params: { student_id: activeStudent?.id, start_date: yearStart, end_date: yearEnd },
          }),
          apiClient.get('/api/attendance', {
            params: { student_id: activeStudent?.id, date: today },
          }),
          // Homework pending count — use the dedicated student endpoint
          apiClient.get('/api/homework/pending-count'),
          apiClient.get('/api/marks'),
          apiClient.get('/api/timetable/class', {
            params: { class: activeStudent?.class, section: activeStudent?.section },
          }),
          apiClient.get('/api/notifications', { params: { unread: true, limit: 1 } }),
        ]);

      // Attendance summary
      let attendance: AttendanceSummary | null = null;
      if (attHistRes.status === 'fulfilled') {
        const s = attHistRes.value.data.data?.summary;
        if (s) {
          let todayStatus: AttendanceSummary['todayStatus'] = null;
          if (attTodayRes.status === 'fulfilled') {
            const records = attTodayRes.value.data.data ?? [];
            if (records.length > 0) todayStatus = records[0].status;
          }
          attendance = {
            percentage: s.percentage ?? 0,
            present: s.present_count ?? s.present ?? 0,
            absent: s.absent_count ?? s.absent ?? 0,
            total: s.total_days ?? s.total ?? 0,
            todayStatus,
          };
        }
      }

      // Homework pending count — pending-count returns { count: N }
      const pendingCount: number =
        hwRes.status === 'fulfilled' ? (hwRes.value.data.data?.count ?? 0) : 0;
      const homework: HomeworkSummary = { pendingCount };

      // Next period
      let nextPeriod: NextPeriod | null = null;
      if (timetableRes.status === 'fulfilled') {
        // API returns a day-keyed object: { monday: [...], tuesday: [...], ... }
        // Extract today's periods array from the object
        const timetableData = timetableRes.value.data.data;
        const todayKey = todayDayName().toLowerCase();
        const periods: any[] = Array.isArray(timetableData)
          ? timetableData
          : (timetableData?.[todayKey] ?? []);
        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const upcoming = periods.find((p: any) => {
          if (!p.start_time) return false;
          const [h, m] = p.start_time.split(':').map(Number);
          return h * 60 + m > currentMinutes;
        });
        if (upcoming) {
          nextPeriod = {
            subject: upcoming.subject_name ?? upcoming.subject ?? 'Class',
            teacher: upcoming.teacher_name ?? '',
            time: upcoming.start_time ?? '',
          };
        }
      }

      // Recent mark
      let recentMark: RecentMark | null = null;
      if (marksRes.status === 'fulfilled') {
        const marks: any[] = marksRes.value.data.data ?? [];
        if (marks.length > 0) {
          const latest = marks[0];
          recentMark = {
            subject: latest.subject,
            score: latest.score,
            max_score: latest.max_score,
          };
        }
      }

      // Announcement (use notifications as announcements)
      let announcement: Announcement | null = null;
      if (notifRes.status === 'fulfilled') {
        const notifs: any[] = notifRes.value.data.data ?? [];
        if (notifs.length > 0) {
          announcement = {
            id: notifs[0].id,
            title: notifs[0].title ?? 'Notification',
            message: notifs[0].message ?? notifs[0].body ?? '',
            created_at: notifs[0].created_at,
          };
          // Count unread
          setNotifCount(notifRes.value.data.meta?.total ?? notifs.length);
        }
      }

      setData({ attendance, homework, nextPeriod, recentMark, announcement });
    } catch (err) {
      console.warn('[Dashboard] fetchAll error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeStudent?.id, activeStudent?.class, activeStudent?.section]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchAll();
  }, [fetchAll]);

  const firstName = activeStudent?.name?.split(' ')[0] ?? 'there';

  const attendanceValue = data?.attendance
    ? `${data.attendance.percentage}%`
    : '—';
  const attendanceSub = data?.attendance
    ? `Today: ${data.attendance.todayStatus ?? 'Not marked'}`
    : 'No data';

  const hwValue = loading ? '—' : String(data?.homework.pendingCount ?? 0);
  const hwSub = 'Pending homework';

  const nextValue = data?.nextPeriod ? data.nextPeriod.time : '—';
  const nextSub = data?.nextPeriod
    ? `${data.nextPeriod.subject}${data.nextPeriod.teacher ? ` · ${data.nextPeriod.teacher}` : ''}`
    : 'No more classes today';

  const markValue = data?.recentMark
    ? `${Math.round((data.recentMark.score / data.recentMark.max_score) * 100)}%`
    : '—';
  const markSub = data?.recentMark ? data.recentMark.subject : 'No marks yet';

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
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.greeting}>Hello, {firstName} 👋</Text>
            <Text style={styles.subGreeting}>
              {activeStudent?.class ? `Class ${activeStudent.class} ${activeStudent.section}` : ''}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.bellWrapper}
            onPress={() => navigation.navigate('More', { screen: 'Notifications' } as any)}
            accessibilityRole="button"
            accessibilityLabel={`Notifications${notifCount > 0 ? `, ${notifCount} unread` : ''}`}
          >
            <Text style={styles.bell}>🔔</Text>
            {notifCount > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{notifCount > 9 ? '9+' : notifCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>

        {/* Child switcher */}
        <ChildSwitcher />

        {/* Cards grid */}
        {loading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color="#1D4ED8" />
          </View>
        ) : (
          <>
            <View style={styles.cardsRow}>
              <DashCard
                icon="📅"
                title="Attendance"
                value={attendanceValue}
                sub={attendanceSub}
                color={
                  (data?.attendance?.percentage ?? 0) >= 75 ? '#22C55E' : '#EF4444'
                }
                onPress={() => navigation.navigate('Attendance')}
              />
              <DashCard
                icon="📚"
                title="Homework"
                value={hwValue}
                sub={hwSub}
                color="#F59E0B"
                onPress={() => navigation.navigate('More', { screen: 'Homework' } as any)}
              />
            </View>
            <View style={[styles.cardsRow, { marginTop: 12 }]}>
              <DashCard
                icon="⏰"
                title="Next Class"
                value={nextValue}
                sub={nextSub}
                color="#8B5CF6"
                onPress={() => navigation.navigate('More', { screen: 'Timetable' } as any)}
              />
              <DashCard
                icon="📊"
                title="Recent Mark"
                value={markValue}
                sub={markSub}
                color="#1D4ED8"
                onPress={() => navigation.navigate('Marks')}
              />
            </View>
            <View style={[styles.cardsRow, { marginTop: 12 }]}>
              <DashCard
                icon="📝"
                title="Tests"
                value="View"
                sub="Upcoming & past tests"
                color="#8B5CF6"
                onPress={() => navigation.navigate('More', { screen: 'Tests' } as any)}
              />
              <DashCard
                icon="🗓️"
                title="Timetable"
                value="View"
                sub="Weekly class schedule"
                color="#1D4ED8"
                onPress={() => navigation.navigate('More', { screen: 'Timetable' } as any)}
              />
            </View>
          </>
        )}

        {/* Announcement banner */}
        {data?.announcement && (
          <View style={styles.announcementCard}>
            <Text style={styles.announcementLabel}>📢 Latest Update</Text>
            <Text style={styles.announcementTitle} numberOfLines={1}>
              {data.announcement.title}
            </Text>
            <Text style={styles.announcementBody} numberOfLines={2}>
              {data.announcement.message}
            </Text>
            <Text style={styles.announcementTime}>
              {timeAgo(data.announcement.created_at)}
            </Text>
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
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 20,
  },
  greeting: { fontSize: 22, fontWeight: '700', color: '#111827' },
  subGreeting: { fontSize: 13, color: '#6B7280', marginTop: 3 },
  bellWrapper: { position: 'relative', padding: 4 },
  bell: { fontSize: 24 },
  badge: {
    position: 'absolute',
    top: 0,
    right: 0,
    backgroundColor: '#EF4444',
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 3,
  },
  badgeText: { fontSize: 10, color: '#FFFFFF', fontWeight: '700' },
  loadingBox: { height: 200, justifyContent: 'center', alignItems: 'center' },
  cardsRow: { flexDirection: 'row', gap: 12 },
  announcementCard: {
    backgroundColor: '#EFF6FF',
    borderRadius: 14,
    padding: 16,
    marginTop: 20,
    borderLeftWidth: 4,
    borderLeftColor: '#1D4ED8',
  },
  announcementLabel: { fontSize: 11, color: '#1D4ED8', fontWeight: '700', marginBottom: 4 },
  announcementTitle: { fontSize: 15, fontWeight: '700', color: '#1E3A8A', marginBottom: 4 },
  announcementBody: { fontSize: 13, color: '#374151', lineHeight: 19 },
  announcementTime: { fontSize: 11, color: '#93C5FD', marginTop: 6 },
});
