import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  StatusBar,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import apiClient from '../../api/client';

// ── Types ─────────────────────────────────────────────────────────────────────

interface NotificationItem {
  id: string;
  title: string;
  body: string;       // normalised by backend (was 'message' in DB)
  type: string;
  is_read: boolean;
  created_at: string;
  _kind: 'notification';
}

interface AnnouncementItem {
  id: string;
  title: string;
  message: string;
  created_at: string;
  _kind: 'announcement';
  is_seen: boolean;   // local state — true once user has opened this screen
}

type FeedItem = NotificationItem | AnnouncementItem;

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function notifIcon(type: string): string {
  switch (type) {
    case 'attendance':    return '📅';
    case 'marks':         return '📊';
    case 'homework':      return '📚';
    case 'test':          return '📝';
    case 'fee':
    case 'fee_reminder':  return '💰';
    case 'complaint':     return '📋';
    case 'announcement':  return '📢';
    default:              return '🔔';
  }
}

// ── Feed item row ─────────────────────────────────────────────────────────────

function FeedRow({
  item,
  onMarkRead,
}: {
  item: FeedItem;
  onMarkRead: (id: string) => void;
}) {
  const isUnread =
    item._kind === 'notification' ? !item.is_read : !item.is_seen;

  const icon =
    item._kind === 'announcement' ? '📢' : notifIcon(item.type);

  const body =
    item._kind === 'announcement' ? item.message : item.body;

  const handlePress = () => {
    if (item._kind === 'notification' && !item.is_read) {
      onMarkRead(item.id);
    }
    // Announcements are auto-marked seen when the screen opens; tap does nothing extra
  };

  return (
    <TouchableOpacity
      style={[styles.item, isUnread && styles.itemUnread]}
      onPress={handlePress}
      activeOpacity={isUnread ? 0.75 : 1}
      accessibilityRole="button"
      accessibilityLabel={`${item.title}. ${isUnread ? 'Unread' : 'Read'}`}
    >
      <View style={styles.iconWrapper}>
        <Text style={styles.icon}>{icon}</Text>
        {isUnread && <View style={styles.unreadDot} />}
      </View>
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text
            style={[styles.title, isUnread && styles.titleUnread]}
            numberOfLines={1}
          >
            {item.title}
          </Text>
          <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
        </View>
        <Text style={styles.message} numberOfLines={2}>
          {body}
        </Text>
        {item._kind === 'announcement' && (
          <View style={styles.annBadge}>
            <Text style={styles.annBadgeText}>Announcement</Text>
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function NotificationsScreen() {
  const navigation = useNavigation<any>();

  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);

  // Mark announcements as "seen" as soon as this screen opens (even if fetch fails).
  useEffect(() => {
    AsyncStorage.setItem('notifications_last_viewed_at', new Date().toISOString()).catch(() => {});
  }, []);

  // ── Fetch both feeds ────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    try {
      const [notifRes, annRes] = await Promise.allSettled([
        apiClient.get('/api/notifications'),
        apiClient.get('/api/announcements/student'),
      ]);

      if (notifRes.status === 'fulfilled') {
        const raw: any[] = notifRes.value.data.data?.data ?? [];
        setNotifications(
          raw.map((n) => ({
            id: n.id,
            title: n.title,
            body: n.body ?? n.message ?? '',
            type: n.type ?? 'reminder',
            is_read: n.is_read,
            created_at: n.created_at,
            _kind: 'notification',
          }))
        );
      }

      if (annRes.status === 'fulfilled') {
        const raw: any[] = annRes.value.data.data ?? [];
        const items: AnnouncementItem[] = raw.map((a) => ({
          id: a.id,
          title: a.title,
          message: a.message,
          created_at: a.created_at,
          _kind: 'announcement',
          is_seen: true, // all are considered seen once this screen is opened
        }));
        setAnnouncements(items);
      }
    } catch (err) {
      console.warn('[Notifications] fetchAll error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Auto-mark all unread notifications as read when screen opens
  useEffect(() => {
    if (loading) return; // wait until notifications are loaded
    const unread = notifications.filter((n) => !n.is_read);
    if (unread.length === 0) return;

    // Optimistically update UI
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));

    // Fire-and-forget to backend
    apiClient.put('/api/notifications/read-all').catch(() => {
      // If it fails, silently ignore — the badge will re-sync on next focus
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchAll();
  }, [fetchAll]);

  // ── Mark single notification read (kept for manual tap, though auto-read covers most cases) ──

  const handleMarkRead = useCallback(async (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, is_read: true } : n))
    );
    try {
      await apiClient.patch(`/api/notifications/${id}/read`);
    } catch {
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, is_read: false } : n))
      );
    }
  }, []);

  // ── Mark all notifications read ─────────────────────────────────────────────

  const handleMarkAllRead = useCallback(async () => {
    setMarkingAll(true);
    try {
      await apiClient.put('/api/notifications/read-all');
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
    } catch (err) {
      console.warn('[Notifications] mark all read error:', err);
    } finally {
      setMarkingAll(false);
    }
  }, []);

  // ── Build unified sections list ─────────────────────────────────────────────

  const unreadNotifCount = notifications.filter((n) => !n.is_read).length;
  const hasUnread = unreadNotifCount > 0;

  // Configure stack header (title + "Mark all read" action)
  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: 'Notifications',
      headerRight: hasUnread
        ? () => (
            <TouchableOpacity
              style={[styles.headerAction, markingAll && styles.headerActionDisabled]}
              onPress={handleMarkAllRead}
              disabled={markingAll}
              accessibilityRole="button"
              accessibilityLabel="Mark all notifications as read"
            >
              {markingAll ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={styles.headerActionText}>Mark all read</Text>
              )}
            </TouchableOpacity>
          )
        : undefined,
    });
  }, [navigation, hasUnread, markingAll, handleMarkAllRead]);

  // Sort each group newest first, then combine into sections
  const sortedNotifs = [...notifications].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  const sortedAnns = [...announcements].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  const sections: Array<{ title: string; data: FeedItem[] }> = [];
  if (sortedAnns.length > 0) {
    sections.push({ title: '📢 Announcements', data: sortedAnns });
  }
  if (sortedNotifs.length > 0) {
    sections.push({ title: '🔔 Notifications', data: sortedNotifs });
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <SectionList
        style={styles.container}
        contentContainerStyle={styles.content}
        sections={sections}
        keyExtractor={(item) => `${item._kind}-${item.id}`}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1D4ED8" />
        }
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
          </View>
        )}
        renderItem={({ item }) => (
          <FeedRow item={item} onMarkRead={handleMarkRead} />
        )}
        ListEmptyComponent={
          loading ? (
            <View style={styles.centered}>
              <ActivityIndicator size="large" color="#1D4ED8" />
            </View>
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>🔔</Text>
              <Text style={styles.emptyText}>Nothing here yet.</Text>
            </View>
          )
        }
        stickySectionHeadersEnabled={false}
      />
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { paddingBottom: 48 },

  headerAction: {
    marginRight: 10,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 40,
    alignItems: 'center',
  },
  headerActionDisabled: { opacity: 0.7 },
  headerActionText: { fontSize: 12, color: '#FFFFFF', fontWeight: '700' },

  sectionHeader: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 6,
    backgroundColor: '#F9FAFB',
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
    backgroundColor: '#FFFFFF',
  },
  itemUnread: { backgroundColor: '#F0F9FF' },

  iconWrapper: { position: 'relative', marginRight: 14, marginTop: 2 },
  icon: { fontSize: 22 },
  unreadDot: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#1D4ED8',
  },

  body: { flex: 1 },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 4,
  },
  title: { fontSize: 14, fontWeight: '500', color: '#374151', flex: 1, marginRight: 8 },
  titleUnread: { fontWeight: '700', color: '#111827' },
  time: { fontSize: 11, color: '#9CA3AF', flexShrink: 0 },
  message: { fontSize: 13, color: '#6B7280', lineHeight: 18 },

  annBadge: {
    alignSelf: 'flex-start',
    marginTop: 6,
    backgroundColor: '#DBEAFE',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  annBadgeText: { fontSize: 11, color: '#1D4ED8', fontWeight: '600' },

  centered: { paddingTop: 60, alignItems: 'center' },
  emptyState: { alignItems: 'center', paddingTop: 60 },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyText: { fontSize: 15, color: '#9CA3AF' },
});
