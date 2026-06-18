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
import { useNavigation, CommonActions, useFocusEffect } from '@react-navigation/native';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useAuthStore } from '../../store/authStore';
import { useChildStore } from '../../store/childStore';
import * as Haptics from 'expo-haptics';
import apiClient from '../../api/client';
import { MainTabParamList } from '../../navigation/AppNavigator';
import StreakWidget from '../../components/StreakWidget';

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
  worstSubject: string | null;
}

type MainNavProp = BottomTabNavigationProp<MainTabParamList>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Parse an ISO timestamp as UTC. Supabase may return timestamptz values without
 * a timezone designator, which JavaScript would interpret as local time — causing
 * timestamps to appear shifted by the device UTC offset (e.g. +5:30h for IST).
 */
function parseUtcDate(iso: string): Date {
  if (iso && !iso.endsWith('Z') && !iso.includes('+') && !/\d{2}:\d{2}$/.test(iso)) {
    return new Date(iso + 'Z');
  }
  return new Date(iso);
}

function timeAgo(iso: string): string {
  const diff = Date.now() - parseUtcDate(iso).getTime();
  // Handle slight clock skew between device and server (treat up to -30s as "now")
  if (diff < 60000) return 'Just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Worst subject helper ──────────────────────────────────────────────────────

function deriveWorstSubject(marks: Array<{ subject: string; score: number; max_score: number }>): string | null {
  if (!marks || marks.length < 2) return null;
  const map = new Map<string, number[]>();
  for (const m of marks) {
    if (!map.has(m.subject)) map.set(m.subject, []);
    map.get(m.subject)!.push(Math.round((m.score / m.max_score) * 100));
  }
  if (map.size < 2) return null;
  let worstSubject = '';
  let worstAvg = 101;
  map.forEach((pcts, subject) => {
    const avg = Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
    if (avg < worstAvg) { worstAvg = avg; worstSubject = subject; }
  });
  return worstAvg < 65 ? worstSubject : null;
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
  const login = useAuthStore((s) => s.login);
  const token = useAuthStore((s) => s.token);
  const { linkedChildren, activeChildIndex } = useChildStore();
  const navigation = useNavigation<MainNavProp>();

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notifCount, setNotifCount] = useState(0);   // unread notifications

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

  /**
   * When the user opens the notification bell, we want the badge to drop to 0
   * immediately (UX expectation), while the actual "mark read" operation happens
   * in the background and is re-checked on focus.
   *
   * This is intentionally fire-and-forget so a network hiccup doesn't block navigation.
   */
  const openNotifications = useCallback(() => {
    // Optimistically clear badges
    setNotifCount(0);

    // Mark all unread notifications as read in the backend (no-op if none).
    apiClient.put('/api/notifications/read-all').catch(() => {});

    // Open as a normal stack screen (so Back returns to wherever the user came from,
    // e.g. Dashboard), instead of forcing the More tab.
    const parent = (navigation as any).getParent?.();
    if (parent?.navigate) {
      parent.navigate('NotificationsModal');
    } else {
      // Fallback (shouldn't happen): use More tab
      navigateToMore('Notifications');
    }
  }, [navigateToMore, navigation]);

  const fetchAll = useCallback(async () => {
    try {
      const today = todayISO();
      const yearStart = `${new Date().getFullYear()}-01-01`;
      const yearEnd = `${new Date().getFullYear()}-12-31`;

      // When a linked child is active we must use their student JWT for the
      // announcements endpoint — the global apiClient carries the parent token
      // which is rejected by authenticateStudent (it only accepts student JWTs).
      const activeChildToken =
        linkedChildren.length > 0
          ? linkedChildren[activeChildIndex]?.token
          : null;

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
          // Use child's student token so authenticateStudent accepts the request
          apiClient.get('/api/announcements/student', {
            headers: activeChildToken
              ? { Authorization: `Bearer ${activeChildToken}` }
              : undefined,
          }),
          apiClient.get('/api/notifications', { params: { unread_only: 'true' } }),
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

      // Recent mark + worst subject
      // API wraps response as { success, data: { data: [...], total, ... } }
      // so the array lives at .data.data.data
      let recentMark: RecentMark | null = null;
      let allMarksForWorst: Array<{ subject: string; score: number; max_score: number }> = [];
      if (marksRes.status === 'fulfilled') {
        const marksPayload = marksRes.value.data.data;
        const marks: any[] = Array.isArray(marksPayload)
          ? marksPayload
          : (marksPayload?.data ?? []);
        if (marks.length > 0) {
          const latest = marks[0];
          recentMark = {
            subject: latest.subject,
            score: latest.score,
            max_score: latest.max_score,
          };
        }
        allMarksForWorst = marks;
      }

      // Announcements for this student's class
      let announcements: Announcement[] = [];
      if (annRes.status === 'fulfilled') {
        announcements = annRes.value.data.data ?? [];
      }

      // Notification badge count — only truly unread notifications
      // API wraps as { success, data: { data: [...], total, unread_count } }
      if (notifCountRes.status === 'fulfilled') {
        const notifPayload = notifCountRes.value.data.data;
        // Prefer the server's unread_count; fall back to array length
        const unreadCount: number =
          notifPayload?.unread_count ??
          (Array.isArray(notifPayload) ? notifPayload.length : (notifPayload?.data?.length ?? 0));
        setNotifCount(unreadCount);
      }

      setData({ attendance, homework, recentMark, announcements, worstSubject: deriveWorstSubject(allMarksForWorst) });    } catch (err) {
      console.warn('[Dashboard] fetchAll error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeStudent?.id, linkedChildren, activeChildIndex]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Refresh the student's name from the server once on mount so it's always
  // up-to-date even if the persisted store has a stale/null name.
  useEffect(() => {
    if (linkedChildren.length > 0) return; // parent view — name comes from child store
    const refreshName = async () => {
      try {
        const res = await apiClient.get('/api/auth/me');
        const freshStudent = res.data?.data?.student;
        if (freshStudent?.name && student) {
          // Update store only if name actually changed (avoids unnecessary re-renders)
          if (freshStudent.name !== student.name) {
            login(
              {
                ...student,
                name: freshStudent.name,
              },
              token!
            );
          }
        }
      } catch {
        // Non-critical — greeting will fall back to whatever is in the store
      }
    };
    refreshName();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch counts whenever Home is focused so the bell reflects
  // reads/views done on the Notifications or Announcements screens.
  useFocusEffect(
    useCallback(() => {
      const fetchCounts = async () => {
        try {
          // Unread notifications
          const notifRes = await apiClient.get('/api/notifications', { params: { unread_only: 'true' } });
          const notifPayload = notifRes.data.data;
          const unreadCount: number =
            notifPayload?.unread_count ??
            (Array.isArray(notifPayload) ? notifPayload.length : (notifPayload?.data?.length ?? 0));
          setNotifCount(unreadCount);

        } catch {
          // Silently ignore
        }
      };
      fetchCounts();
    }, [])
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    fetchAll();
  }, [fetchAll]);

  const firstName = (activeStudent?.name ?? student?.name ?? '').trim();

  const attendanceValue = data?.attendance
    ? `${data.attendance.percentage}%`
    : '—';
  const attendanceSub = data?.attendance
    ? `Today: ${data.attendance.todayStatus ?? 'Not marked'}`
    : 'No data';

  const hwValue = loading ? '—' : String(data?.homework.pendingCount ?? 0);
  const hwSub = 'Pending homework';

  const annDisplayCount = data?.announcements.length ?? 0;
  const annValue = loading ? '—' : String(annDisplayCount);
  const annSub = annDisplayCount === 0 ? 'No new announcements' : `${annDisplayCount} new announcement${annDisplayCount !== 1 ? 's' : ''}`;

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
            <Text style={styles.greeting}>Hello{firstName ? `, ${firstName}` : ''} 👋</Text>
            <Text style={styles.subGreeting}>
              {activeStudent?.class ? `Class ${activeStudent.class} ${activeStudent.section}` : ''}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.bellWrapper, notifCount > 0 && styles.bellWrapperActive]}
            onPress={openNotifications}
            accessibilityRole="button"
            accessibilityLabel={`Notifications${notifCount > 0 ? `, ${notifCount} unread` : ''}`}
          >
            <Text style={styles.bell}>🔔</Text>
            {notifCount > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{notifCount > 99 ? '99+' : notifCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>

        {/* Child switcher */}
        <ChildSwitcher />

        {/* Streak widget — uses student token (own) or active child's token */}
        {activeStudent && (
          <StreakWidget
            studentId={activeStudent.id}
            studentToken={
              linkedChildren.length > 0
                ? (linkedChildren[activeChildIndex]?.token ?? token ?? '')
                : (token ?? '')
            }
          />
        )}

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
                onPress={() => {
                  const parent = (navigation as any).getParent?.();
                  if (parent?.navigate) {
                    parent.navigate('HomeworkModal');
                  } else {
                    navigateToMore('Homework');
                  }
                }}
              />
            </View>
            <View style={[styles.cardsRow, { marginTop: 12 }]}>
              <DashCard
                icon="📢"
                title="Announcements"
                value={annValue}
                sub={annSub}
                color="#1D4ED8"
                onPress={() => navigateToMore('Announcements')}
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

        {/* Focus Area banner — shown when a subject avg is below 65% */}
        {!loading && data?.worstSubject && (
          <TouchableOpacity
            style={styles.focusBanner}
            onPress={() => navigation.navigate('Marks')}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={`Focus area: ${data.worstSubject}. Tap to view performance.`}
          >
            <View style={styles.focusLeft}>
              <Text style={styles.focusEmoji}>🎯</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.focusTitle}>Focus Area</Text>
                <Text style={styles.focusSubject}>{data.worstSubject}</Text>
                <Text style={styles.focusHint}>Your lowest scoring subject · tap to review</Text>
              </View>
            </View>
            <Text style={styles.focusArrow}>→</Text>
          </TouchableOpacity>
        )}

        {/* Announcements section — always shown below the cards */}
        {!loading && (
          <View style={styles.annSection}>
            <View style={styles.annSectionHeader}>
              <Text style={styles.annSectionTitle}>📢 Announcements</Text>
              {data?.announcements && data.announcements.length > 0 && (
                <TouchableOpacity
                  onPress={() => navigateToMore('Announcements')}
                  accessibilityRole="link"
                  accessibilityLabel="See all announcements"
                >
                  <Text style={styles.annSeeAll}>See all →</Text>
                </TouchableOpacity>
              )}
            </View>
            {data?.announcements && data.announcements.length > 0 ? (
              data.announcements.slice(0, 3).map((ann) => (
                <TouchableOpacity
                  key={ann.id}
                  style={styles.announcementCard}
                  onPress={() => navigateToMore('Announcements')}
                  activeOpacity={0.75}
                  accessibilityRole="button"
                  accessibilityLabel={`Announcement: ${ann.title}`}
                >
                  <View style={styles.annCardHeader}>
                    <Text style={styles.announcementTitle} numberOfLines={2}>
                      {ann.title}
                    </Text>
                    <Text style={styles.announcementTime}>
                      {timeAgo(ann.created_at)}
                    </Text>
                  </View>
                  <Text style={styles.announcementBody} numberOfLines={2}>
                    {ann.message}
                  </Text>
                </TouchableOpacity>
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
  bellWrapperActive: {
    backgroundColor: '#FEF9C3',
    borderRadius: 20,
  },
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
  focusBanner: {
    backgroundColor: '#FFF7ED',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#FED7AA',
    padding: 14,
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  focusLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 12 },
  focusEmoji: { fontSize: 28 },
  focusTitle: { fontSize: 11, fontWeight: '700', color: '#92400E', textTransform: 'uppercase', letterSpacing: 0.5 },
  focusSubject: { fontSize: 16, fontWeight: '800', color: '#111827', marginTop: 1 },
  focusHint: { fontSize: 12, color: '#B45309', marginTop: 2 },
  focusArrow: { fontSize: 18, color: '#F59E0B', fontWeight: '700', marginLeft: 8 },
  annSection: {
    marginTop: 24,
  },
  annSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  annSectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
  },
  annSeeAll: {
    fontSize: 13,
    color: '#1D4ED8',
    fontWeight: '500',
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
