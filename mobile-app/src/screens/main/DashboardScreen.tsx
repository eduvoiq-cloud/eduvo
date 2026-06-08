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
import { useNavigation, CommonActions } from '@react-navigation/native';
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
  recentMark: RecentMark | null;
  announcements: Announcement[];
}

type MainNavProp = BottomTabNavigationProp<MainTabParamList>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
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

  /**
   * Navigate into a screen inside the More stack while always resetting
   * the stack history to [MoreHome → target]. This prevents the back
   * button from landing on a stale screen (e.g. Timetable) when the
   * user previously visited a different More screen.
   */
  const navigateToMore = useCallback((screen: string) => {
    // Dispatch a reset on the root navigator, keeping all tabs intact but
    // replacing the More tab's nested stack state with a clean [MoreHome, target].
    navigation.dispatch((state) => {
      const moreRouteIndex = state.routes.findIndex((r) => r.name === 'More');
      if (moreRouteIndex === -1) {
        // Fallback: just navigate normally
        return CommonActions.navigate('More', { screen, initial: false } as any);
      }
      const newRoutes = state.routes.map((route, idx) => {
        if (idx !== moreRouteIndex) return route;
        return {
          ...route,
          state: {
            index: 1,
            routes: [{ name: 'MoreHome' }, { name: screen }],
          },
        };
      });
      return CommonActions.reset({
        ...state,
        index: moreRouteIndex,
        routes: newRoutes,
      });
    });
  }, [navigation]);

  const fetchAll = useCallback(async () => {
    try {
      const today = todayISO();
      const yearStart = `${new Date().getFullYear()}-01-01`;
      const yearEnd = `${new Date().getFullYear()}-12-31`;

      const [attHistRes, attTodayRes, hwRes, marksRes, annRes, notifCountRes] =
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
          apiClient.get('/api/announcements/student'),
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

      // Announcements for this student's class
      let announcements: Announcement[] = [];
      if (annRes.status === 'fulfilled') {
        announcements = annRes.value.data.data ?? [];
      }

      // Notification badge count
      if (notifCountRes.status === 'fulfilled') {
        const notifs: any[] = notifCountRes.value.data.data ?? [];
        if (notifs.length > 0) {
          setNotifCount(notifCountRes.value.data.meta?.total ?? notifs.length);
        }
      }

      setData({ attendance, homework, recentMark, announcements });
    } catch (err) {
      console.warn('[Dashboard] fetchAll error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeStudent?.id]);

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

  const annCount = data?.announcements.length ?? 0;
  const annValue = loading ? '—' : String(annCount);
  const annSub = annCount === 0 ? 'No new announcements' : `${annCount} new announcement${annCount !== 1 ? 's' : ''}`;

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
        onPress={() => navigateToMore('Notifications')}
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
                onPress={() => navigateToMore('Homework')}
              />
            </View>
            <View style={[styles.cardsRow, { marginTop: 12 }]}>
              <DashCard
                icon="📢"
                title="Announcements"
                value={annValue}
                sub={annSub}
                color="#1D4ED8"
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
                onPress={() => navigation.navigate('Tests')}
              />
              <DashCard
                icon="🗓️"
                title="Timetable"
                value="View"
                sub="Weekly class schedule"
                color="#1D4ED8"
                onPress={() => navigateToMore('Timetable')}
              />
            </View>
          </>
        )}

        {/* Announcements section — always shown below the cards */}
        {!loading && (
          <View style={styles.annSection}>
            <Text style={styles.annSectionTitle}>📢 Announcements</Text>
            {data?.announcements && data.announcements.length > 0 ? (
              data.announcements.slice(0, 5).map((ann) => (
                <View key={ann.id} style={styles.announcementCard}>
                  <View style={styles.annCardHeader}>
                    <Text style={styles.announcementTitle} numberOfLines={2}>
                      {ann.title}
                    </Text>
                    <Text style={styles.announcementTime}>
                      {timeAgo(ann.created_at)}
                    </Text>
                  </View>
                  <Text style={styles.announcementBody}>
                    {ann.message}
                  </Text>
                </View>
              ))
            ) : (
              <View style={styles.annEmpty}>
                <Text style={styles.annEmptyText}>No announcements for your class</Text>
              </View>
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
  annSection: {
    marginTop: 24,
  },
  annSectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 12,
  },
  announcementCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    borderLeftWidth: 4,
    borderLeftColor: '#1D4ED8',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  annCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  announcementTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1E3A8A',
    flex: 1,
    marginRight: 8,
  },
  announcementBody: {
    fontSize: 13,
    color: '#374151',
    lineHeight: 19,
  },
  announcementTime: {
    fontSize: 11,
    color: '#93C5FD',
    flexShrink: 0,
  },
  annEmpty: {
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderStyle: 'dashed',
  },
  annEmptyText: {
    fontSize: 13,
    color: '#9CA3AF',
  },
});
