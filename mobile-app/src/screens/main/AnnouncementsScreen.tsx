import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  StatusBar,
  Modal,
  ScrollView,
} from 'react-native';
import { useAuthStore } from '../../store/authStore';
import { useChildStore } from '../../store/childStore';
import apiClient from '../../api/client';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Announcement {
  id: string;
  title: string;
  message: string;
  created_at: string;
  target_classes?: Array<{ class: string; section: string }>;
}

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
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ── Announcement detail modal ─────────────────────────────────────────────────

function AnnouncementModal({
  item,
  visible,
  onClose,
}: {
  item: Announcement | null;
  visible: boolean;
  onClose: () => void;
}) {
  if (!item) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <TouchableOpacity
        style={modal.overlay}
        activeOpacity={1}
        onPress={onClose}
      >
        <TouchableOpacity activeOpacity={1} style={modal.sheet}>
          {/* Handle bar */}
          <View style={modal.handle} />

          <ScrollView showsVerticalScrollIndicator={false}>
            {/* Icon + title */}
            <View style={modal.titleRow}>
              <Text style={modal.icon}>📢</Text>
              <Text style={modal.title}>{item.title}</Text>
            </View>

            {/* Time */}
            <Text style={modal.time}>{timeAgo(item.created_at)}</Text>

            {/* Divider */}
            <View style={modal.divider} />

            {/* Full message */}
            <Text style={modal.body}>{item.message}</Text>
          </ScrollView>

          {/* Close button */}
          <TouchableOpacity
            style={modal.closeBtn}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close announcement"
          >
            <Text style={modal.closeBtnText}>Close</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const modal = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    maxHeight: '80%',
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#D1D5DB',
    alignSelf: 'center',
    marginBottom: 20,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  icon: { fontSize: 22, marginRight: 10, marginTop: 2 },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
    flex: 1,
    lineHeight: 26,
  },
  time: {
    fontSize: 12,
    color: '#9CA3AF',
    marginBottom: 16,
    marginLeft: 32,
  },
  divider: {
    height: 1,
    backgroundColor: '#F3F4F6',
    marginBottom: 16,
  },
  body: {
    fontSize: 15,
    color: '#374151',
    lineHeight: 24,
  },
  closeBtn: {
    marginTop: 24,
    backgroundColor: '#1D4ED8',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  closeBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
});

// ── Announcement list item ────────────────────────────────────────────────────

function AnnouncementItem({
  item,
  onPress,
}: {
  item: Announcement;
  onPress: (item: Announcement) => void;
}) {
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => onPress(item)}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={`Announcement: ${item.title}`}
    >
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {item.title}
        </Text>
        <Text style={styles.cardTime}>{timeAgo(item.created_at)}</Text>
      </View>
      <Text style={styles.cardBody} numberOfLines={3}>
        {item.message}
      </Text>
      <Text style={styles.readMore}>Tap to read more →</Text>
    </TouchableOpacity>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function AnnouncementsScreen() {
  const student = useAuthStore((s) => s.student);
  const { linkedChildren, activeChildIndex } = useChildStore();

  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Announcement | null>(null);

  // Use the active child's token when browsing as a linked child
  const activeChildToken =
    linkedChildren.length > 0
      ? linkedChildren[activeChildIndex]?.token
      : null;

  const fetchAnnouncements = useCallback(async () => {
    try {
      const response = await apiClient.get('/api/announcements/student', {
        headers: activeChildToken
          ? { Authorization: `Bearer ${activeChildToken}` }
          : undefined,
      });
      setAnnouncements(response.data.data ?? []);
    } catch (err) {
      console.warn('[Announcements] fetch error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeChildToken]);

  useEffect(() => {
    fetchAnnouncements();
  }, [fetchAnnouncements]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchAnnouncements();
  }, [fetchAnnouncements]);

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      <FlatList
        style={styles.container}
        contentContainerStyle={styles.content}
        data={announcements}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#1D4ED8"
          />
        }
        ListHeaderComponent={
          <View style={styles.headerBox}>
            <Text style={styles.headerCount}>
              {loading ? '…' : `${announcements.length} announcement${announcements.length !== 1 ? 's' : ''}`}
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <AnnouncementItem item={item} onPress={setSelected} />
        )}
        ListEmptyComponent={
          loading ? (
            <View style={styles.centered}>
              <ActivityIndicator size="large" color="#1D4ED8" />
            </View>
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>📢</Text>
              <Text style={styles.emptyTitle}>No announcements yet</Text>
              <Text style={styles.emptySubtitle}>
                Your school announcements will appear here.
              </Text>
            </View>
          )
        }
      />

      <AnnouncementModal
        item={selected}
        visible={selected !== null}
        onClose={() => setSelected(null)}
      />
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { paddingHorizontal: 16, paddingBottom: 48 },

  headerBox: {
    paddingTop: 16,
    paddingBottom: 8,
  },
  headerCount: {
    fontSize: 13,
    color: '#9CA3AF',
    fontWeight: '500',
  },

  // Card
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderLeftWidth: 4,
    borderLeftColor: '#1D4ED8',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1E3A8A',
    flex: 1,
    marginRight: 8,
    lineHeight: 21,
  },
  cardTime: {
    fontSize: 11,
    color: '#93C5FD',
    flexShrink: 0,
    marginTop: 2,
  },
  cardBody: {
    fontSize: 13,
    color: '#374151',
    lineHeight: 20,
  },
  readMore: {
    fontSize: 12,
    color: '#3B82F6',
    fontWeight: '500',
    marginTop: 10,
  },

  // States
  centered: {
    paddingTop: 80,
    alignItems: 'center',
  },
  emptyState: {
    alignItems: 'center',
    paddingTop: 80,
    paddingHorizontal: 32,
  },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#9CA3AF',
    textAlign: 'center',
    lineHeight: 20,
  },
});
