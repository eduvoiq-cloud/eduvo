import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  StatusBar,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useAuthStore } from '../../store/authStore';
import apiClient from '../../api/client';
import { ParentTabParamList } from '../../navigation/AppNavigator';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Child {
  id: string;
  full_name: string;
  class_name: string;
  section?: string;
  /** Attendance record for today, if any */
  today_attendance?: {
    status: 'present' | 'absent' | 'late' | 'excused';
    created_at: string; // ISO timestamp
  } | null;
}

interface Announcement {
  id: string;
  title: string;
  message: string;
  created_at: string;
}

interface Notification {
  id: string;
  title: string;
  body: string;
  is_read: boolean;
  created_at: string;
}

type ParentNavProp = BottomTabNavigationProp<ParentTabParamList>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatNotifDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function SkeletonBlock({ width, height, style }: { width: number | string; height: number; style?: object }) {
  return (
    <View
      style={[
        { width, height, borderRadius: 6, backgroundColor: '#E5E7EB' },
        style,
      ]}
    />
  );
}

function ChildCardSkeleton() {
  return (
    <View style={styles.card}>
      <SkeletonBlock width="60%" height={16} />
      <SkeletonBlock width="40%" height={12} style={{ marginTop: 6 }} />
      <SkeletonBlock width={90} height={26} style={{ marginTop: 12 }} />
    </View>
  );
}

function AnnouncementSkeleton() {
  return (
    <View style={styles.announcementBanner}>
      <SkeletonBlock width="70%" height={14} />
      <SkeletonBlock width="90%" height={12} style={{ marginTop: 8 }} />
    </View>
  );
}

function NotifSkeleton() {
  return (
    <View style={styles.notifCard}>
      <SkeletonBlock width="55%" height={13} />
      <SkeletonBlock width="80%" height={11} style={{ marginTop: 6 }} />
    </View>
  );
}

// ── Attendance badge ──────────────────────────────────────────────────────────

function AttendanceBadge({ child }: { child: Child }) {
  const att = child.today_attendance;

  if (!att) {
    return (
      <View style={[styles.badge, styles.badgeGrey]}>
        <Text style={[styles.badgeText, styles.badgeTextGrey]}>Not marked yet</Text>
      </View>
    );
  }

  if (att.status === 'present' || att.status === 'late') {
    return (
      <View style={[styles.badge, styles.badgeGreen]}>
        <Text style={[styles.badgeText, styles.badgeTextGreen]}>
          Present · {formatTime(att.created_at)}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.badge, styles.badgeRed]}>
      <Text style={[styles.badgeText, styles.badgeTextRed]}>Absent</Text>
    </View>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ParentDashboardScreen() {
  const user = useAuthStore((state) => state.student);
  const navigation = useNavigation<ParentNavProp>();

  const [children, setChildren] = useState<Child[]>([]);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Data fetching ───────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    setError(null);
    try {
      const today = todayISO();

      // Fetch children + today's attendance in parallel
      const [childrenRes, notifsRes] = await Promise.all([
        apiClient.get('/api/students', { params: { parent_id: user?.id } }),
        apiClient.get('/api/notifications'),
      ]);

      const rawChildren: Child[] = childrenRes.data.data ?? [];

      // Enrich each child with today's attendance
      const enriched = await Promise.all(
        rawChildren.map(async (child) => {
          try {
            const attRes = await apiClient.get('/api/attendance', {
              params: { student_id: child.id, date: today },
            });
            const records: Array<{ status: string; created_at: string }> =
              attRes.data.data ?? [];
            const todayRecord = records[0] ?? null;
            return {
              ...child,
              today_attendance: todayRecord
                ? {
                    status: todayRecord.status as Child['today_attendance'] extends null | undefined ? never : NonNullable<Child['today_attendance']>['status'],
                    created_at: todayRecord.created_at,
                  }
                : null,
            };
          } catch {
            return { ...child, today_attendance: null };
          }
        })
      );

      setChildren(enriched);

      // Notifications
      const allNotifs: Notification[] = notifsRes.data.data ?? [];
      const unread = allNotifs.filter((n) => !n.is_read);
      setUnreadCount(unread.length);
      setNotifications(unread.slice(0, 3));

      // Announcements — endpoint may not exist yet; fail gracefully
      try {
        const annRes = await apiClient.get('/api/announcements', {
          params: { limit: 1 },
        });
        const items: Announcement[] = annRes.data.data ?? [];
        setAnnouncement(items[0] ?? null);
      } catch {
        setAnnouncement(null);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load dashboard';
      console.warn('[ParentDashboard] fetchAll error:', msg);
      setError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user?.id]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchAll();
  }, [fetchAll]);

  // ── Render ──────────────────────────────────────────────────────────────────

  const firstName = user?.name ?? 'there';

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
          <View style={styles.headerLeft}>
            <Text style={styles.greeting}>
              {getGreeting()}, {firstName} 👋
            </Text>
            <Text style={styles.subGreeting}>Here's your children's update</Text>
          </View>

          {/* Notification bell */}
          <TouchableOpacity
            style={styles.bellButton}
            onPress={() => navigation.navigate('Notifications')}
            accessibilityRole="button"
            accessibilityLabel={
              unreadCount > 0
                ? `Notifications, ${unreadCount} unread`
                : 'Notifications'
            }
          >
            <Text style={styles.bellIcon}>🔔</Text>
            {unreadCount > 0 && (
              <View style={styles.badge_notif}>
                <Text style={styles.badge_notif_text}>
                  {unreadCount > 99 ? '99+' : unreadCount}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        </View>

        {/* ── Error state ─────────────────────────────────────────────────── */}
        {error && !loading && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>⚠️ {error}</Text>
            <TouchableOpacity
              style={styles.retryButton}
              onPress={() => {
                setLoading(true);
                fetchAll();
              }}
              accessibilityRole="button"
              accessibilityLabel="Retry loading dashboard"
            >
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── My Children ─────────────────────────────────────────────────── */}
        <Text style={styles.sectionTitle}>My Children</Text>

        {loading ? (
          <>
            <ChildCardSkeleton />
            <ChildCardSkeleton />
          </>
        ) : children.length === 0 && !error ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No children linked to your account.</Text>
            <Text style={styles.emptySubtext}>Contact your school administrator.</Text>
          </View>
        ) : (
          children.map((child) => (
            <TouchableOpacity
              key={child.id}
              style={styles.card}
              onPress={() => navigation.navigate('Attendance')}
              accessibilityRole="button"
              accessibilityLabel={`View attendance for ${child.full_name}`}
              activeOpacity={0.75}
            >
              <View style={styles.cardRow}>
                <View style={styles.cardAvatar}>
                  <Text style={styles.cardAvatarText}>
                    {child.full_name.charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View style={styles.cardInfo}>
                  <Text style={styles.childName}>{child.full_name}</Text>
                  <Text style={styles.childClass}>
                    {child.class_name}
                    {child.section ? ` · ${child.section}` : ''}
                  </Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </View>
              <AttendanceBadge child={child} />
            </TouchableOpacity>
          ))
        )}

        {/* ── Latest Announcement ─────────────────────────────────────────── */}
        <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Latest Announcement</Text>

        {loading ? (
          <AnnouncementSkeleton />
        ) : announcement ? (
          <View style={styles.announcementBanner}>
            <View style={styles.announcementHeader}>
              <Text style={styles.announcementIcon}>📢</Text>
              <Text style={styles.announcementTitle} numberOfLines={1}>
                {announcement.title}
              </Text>
            </View>
            <Text style={styles.announcementBody}>
              {announcement.message.slice(0, 100)}
              {announcement.message.length > 100 ? '…' : ''}
            </Text>
            <TouchableOpacity
              onPress={() => navigation.navigate('Notifications')}
              accessibilityRole="link"
              accessibilityLabel="View all announcements"
            >
              <Text style={styles.viewAllLink}>View all →</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.announcementBanner}>
            <Text style={styles.emptySubtext}>No announcements at this time.</Text>
          </View>
        )}

        {/* ── Recent Notifications ─────────────────────────────────────────── */}
        <View style={styles.sectionRow}>
          <Text style={[styles.sectionTitle, { marginTop: 24, marginBottom: 0 }]}>
            Recent Notifications
          </Text>
          <TouchableOpacity
            onPress={() => navigation.navigate('Notifications')}
            accessibilityRole="link"
            accessibilityLabel="View all notifications"
          >
            <Text style={styles.seeAllLink}>See all</Text>
          </TouchableOpacity>
        </View>

        <View style={{ marginTop: 12 }}>
          {loading ? (
            <>
              <NotifSkeleton />
              <NotifSkeleton />
              <NotifSkeleton />
            </>
          ) : notifications.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptySubtext}>No unread notifications.</Text>
            </View>
          ) : (
            notifications.map((notif) => (
              <TouchableOpacity
                key={notif.id}
                style={styles.notifCard}
                onPress={() => navigation.navigate('Notifications')}
                accessibilityRole="button"
                accessibilityLabel={`Notification: ${notif.title}`}
                activeOpacity={0.75}
              >
                <View style={styles.notifDot} />
                <View style={styles.notifContent}>
                  <Text style={styles.notifTitle} numberOfLines={1}>
                    {notif.title}
                  </Text>
                  <Text style={styles.notifBody} numberOfLines={2}>
                    {notif.body}
                  </Text>
                  <Text style={styles.notifDate}>{formatNotifDate(notif.created_at)}</Text>
                </View>
              </TouchableOpacity>
            ))
          )}
        </View>
      </ScrollView>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  content: {
    padding: 20,
    paddingBottom: 48,
  },

  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 28,
  },
  headerLeft: {
    flex: 1,
    marginRight: 12,
  },
  greeting: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111827',
  },
  subGreeting: {
    fontSize: 13,
    color: '#6B7280',
    marginTop: 3,
  },
  bellButton: {
    position: 'relative',
    padding: 6,
  },
  bellIcon: {
    fontSize: 24,
  },
  badge_notif: {
    position: 'absolute',
    top: 2,
    right: 2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#EF4444',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 3,
  },
  badge_notif_text: {
    fontSize: 10,
    fontWeight: '700',
    color: '#FFFFFF',
  },

  // Error
  errorBox: {
    backgroundColor: '#FEF2F2',
    borderRadius: 10,
    padding: 14,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#FECACA',
    alignItems: 'center',
  },
  errorText: {
    fontSize: 14,
    color: '#B91C1C',
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 10,
    backgroundColor: '#EF4444',
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  retryText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },

  // Section titles
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
    marginTop: 24,
    marginBottom: 0,
  },
  seeAllLink: {
    fontSize: 13,
    color: '#1D4ED8',
    fontWeight: '500',
  },

  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingVertical: 20,
  },
  emptyText: {
    fontSize: 15,
    color: '#6B7280',
    textAlign: 'center',
  },
  emptySubtext: {
    fontSize: 13,
    color: '#9CA3AF',
    marginTop: 4,
    textAlign: 'center',
  },

  // Child card
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
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  cardAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#DBEAFE',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  cardAvatarText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1D4ED8',
  },
  cardInfo: {
    flex: 1,
  },
  childName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
  },
  childClass: {
    fontSize: 13,
    color: '#6B7280',
    marginTop: 2,
  },
  chevron: {
    fontSize: 22,
    color: '#9CA3AF',
    marginLeft: 8,
  },

  // Attendance badge
  badge: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    alignSelf: 'flex-start',
  },
  badgeGreen: {
    backgroundColor: '#DCFCE7',
  },
  badgeRed: {
    backgroundColor: '#FEE2E2',
  },
  badgeGrey: {
    backgroundColor: '#F3F4F6',
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  badgeTextGreen: {
    color: '#15803D',
  },
  badgeTextRed: {
    color: '#B91C1C',
  },
  badgeTextGrey: {
    color: '#6B7280',
  },

  // Announcement banner
  announcementBanner: {
    backgroundColor: '#EFF6FF',
    borderRadius: 12,
    padding: 16,
    borderLeftWidth: 4,
    borderLeftColor: '#1D4ED8',
  },
  announcementHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  announcementIcon: {
    fontSize: 16,
    marginRight: 6,
  },
  announcementTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1E3A8A',
    flex: 1,
  },
  announcementBody: {
    fontSize: 13,
    color: '#374151',
    lineHeight: 19,
    marginBottom: 10,
  },
  viewAllLink: {
    fontSize: 13,
    color: '#1D4ED8',
    fontWeight: '500',
  },

  // Notification cards
  notifCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'flex-start',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
    borderLeftWidth: 3,
    borderLeftColor: '#1D4ED8',
  },
  notifDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#1D4ED8',
    marginTop: 4,
    marginRight: 10,
    flexShrink: 0,
  },
  notifContent: {
    flex: 1,
  },
  notifTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 3,
  },
  notifBody: {
    fontSize: 13,
    color: '#4B5563',
    lineHeight: 18,
  },
  notifDate: {
    fontSize: 11,
    color: '#9CA3AF',
    marginTop: 6,
  },
});
