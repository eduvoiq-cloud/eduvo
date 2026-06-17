import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
  Alert,
} from 'react-native';
import apiClient from '../../api/client';

// Notification types returned by the backend
// Keep this permissive so new backend notification types (e.g. 'test') don't
// break the parent UI.
type NotificationType =
  | 'announcement'
  | 'alert'
  | 'reminder'
  | 'grade'
  | 'attendance'
  | 'test'
  | 'homework'
  | 'marks'
  | 'fee_reminder'
  | 'complaint';

interface Notification {
  id: string;
  title: string;
  body: string;
  type: NotificationType;
  is_read: boolean;
  created_at: string;
}

// ── Icon map: type → emoji ────────────────────────────────────────────────────
const TYPE_ICON: Record<NotificationType, string> = {
  attendance: '🏫',
  grade: '✏️',
  announcement: '📢',
  alert: '⚠️',
  reminder: '🔔',
  test: '📝',
  homework: '📚',
  marks: '📊',
  fee_reminder: '💰',
  complaint: '📋',
};

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

// ── Time-ago helper ───────────────────────────────────────────────────────────
function timeAgo(iso: string): string {
  const diffMs = Date.now() - parseUtcDate(iso).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
  return parseUtcDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ParentNotificationsScreen() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);

  useEffect(() => {
    fetchNotifications();
  }, []);

  const fetchNotifications = async () => {
    try {
      const response = await apiClient.get('/api/notifications');
      setNotifications(response.data.data?.data ?? []);
    } catch (error: any) {
      console.warn('[ParentNotifications] Failed to fetch:', error.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchNotifications();
  }, []);

  // Mark a single notification as read
  const markAsRead = async (id: string) => {
    try {
      await apiClient.patch(`/api/notifications/${id}/read`);
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, is_read: true } : n))
      );
    } catch (error: any) {
      console.warn('[ParentNotifications] Failed to mark as read:', error.message);
    }
  };

  // Mark all unread notifications as read
  const markAllRead = async () => {
    const unread = notifications.filter((n) => !n.is_read);
    if (unread.length === 0) return;

    setMarkingAll(true);
    try {
      await Promise.all(
        unread.map((n) => apiClient.patch(`/api/notifications/${n.id}/read`))
      );
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
    } catch (error: any) {
      Alert.alert('Error', 'Could not mark all notifications as read. Please try again.');
      console.warn('[ParentNotifications] Failed to mark all as read:', error.message);
    } finally {
      setMarkingAll(false);
    }
  };

  const renderItem = ({ item }: { item: Notification }) => {
    const icon = TYPE_ICON[item.type] ?? '🔔';
    return (
      <TouchableOpacity
        style={[styles.card, item.is_read ? styles.cardRead : styles.cardUnread]}
        onPress={() => !item.is_read && markAsRead(item.id)}
        activeOpacity={item.is_read ? 1 : 0.7}
        accessibilityRole="button"
        accessibilityLabel={`${item.is_read ? 'Read' : 'Unread'} notification: ${item.title}`}
        accessibilityState={{ selected: !item.is_read }}
      >
        <View style={styles.cardRow}>
          {/* Type icon */}
          <Text style={styles.icon} accessibilityElementsHidden>{icon}</Text>

          {/* Content */}
          <View style={styles.cardContent}>
            <Text style={[styles.cardTitle, !item.is_read && styles.cardTitleUnread]}>
              {item.title}
            </Text>
            <Text style={styles.cardBody}>{item.body}</Text>
            <Text style={styles.cardTime}>{timeAgo(item.created_at)}</Text>
          </View>

          {/* Unread indicator dot */}
          {!item.is_read && <View style={styles.unreadDot} accessibilityElementsHidden />}
        </View>
      </TouchableOpacity>
    );
  };

  // ── Header: title + "Mark all read" button ────────────────────────────────
  const ListHeader = () => {
    const hasUnread = notifications.some((n) => !n.is_read);
    return (
      <View style={styles.header}>
        <Text style={styles.title}>Notifications</Text>
        {hasUnread && (
          <TouchableOpacity
            onPress={markAllRead}
            disabled={markingAll}
            accessibilityRole="button"
            accessibilityLabel="Mark all notifications as read"
          >
            <Text style={[styles.markAllText, markingAll && styles.markAllDisabled]}>
              {markingAll ? 'Marking…' : 'Mark all read'}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1D4ED8" />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.content}
      data={notifications}
      keyExtractor={(item) => item.id}
      renderItem={renderItem}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1D4ED8" />
      }
      ListHeaderComponent={<ListHeader />}
      ListEmptyComponent={
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>🔔</Text>
          <Text style={styles.emptyText}>No notifications yet</Text>
        </View>
      }
    />
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F3F4F6',
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F3F4F6',
  },
  // ── Header ──────────────────────────────────────────────────────────────────
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111827',
  },
  markAllText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1D4ED8',
  },
  markAllDisabled: {
    color: '#9CA3AF',
  },
  // ── Notification card ────────────────────────────────────────────────────────
  card: {
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  cardUnread: {
    backgroundColor: '#FFFFFF',
    borderLeftWidth: 3,
    borderLeftColor: '#1D4ED8',
  },
  cardRead: {
    backgroundColor: '#F9FAFB',
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  icon: {
    fontSize: 22,
    marginRight: 12,
    marginTop: 1,
  },
  cardContent: {
    flex: 1,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '400',
    color: '#6B7280',
    marginBottom: 3,
  },
  cardTitleUnread: {
    fontWeight: '700',
    color: '#111827',
  },
  cardBody: {
    fontSize: 13,
    color: '#4B5563',
    lineHeight: 19,
  },
  cardTime: {
    fontSize: 12,
    color: '#9CA3AF',
    marginTop: 6,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#1D4ED8',
    marginTop: 4,
    marginLeft: 8,
  },
  // ── Empty state ──────────────────────────────────────────────────────────────
  emptyState: {
    alignItems: 'center',
    marginTop: 80,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyText: {
    fontSize: 15,
    color: '#9CA3AF',
  },
});
