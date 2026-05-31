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
  Alert,
} from 'react-native';
import apiClient from '../../api/client';

// ── Types ─────────────────────────────────────────────────────────────────────

interface HomeworkItem {
  id: string;
  title: string;
  description: string;
  subject: string;
  due_date: string;
  is_acknowledged: boolean;
  created_at: string;
}

type TabFilter = 'Pending' | 'Completed' | 'All';

// ── Helpers ───────────────────────────────────────────────────────────────────

const SUBJECT_COLORS: Record<string, string> = {};
const PALETTE = [
  { bg: '#DBEAFE', text: '#1D4ED8' },
  { bg: '#DCFCE7', text: '#15803D' },
  { bg: '#FEF3C7', text: '#92400E' },
  { bg: '#FCE7F3', text: '#9D174D' },
  { bg: '#EDE9FE', text: '#5B21B6' },
  { bg: '#FFEDD5', text: '#C2410C' },
];

function subjectPalette(subject: string): { bg: string; text: string } {
  if (!SUBJECT_COLORS[subject]) {
    const idx = Object.keys(SUBJECT_COLORS).length % PALETTE.length;
    SUBJECT_COLORS[subject] = String(idx);
  }
  return PALETTE[Number(SUBJECT_COLORS[subject]) % PALETTE.length];
}

function dueDateColor(dueDate: string): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  const diff = Math.floor((due.getTime() - today.getTime()) / 86400000);
  if (diff <= 0) return '#EF4444'; // today or overdue
  if (diff === 1) return '#F59E0B'; // tomorrow
  return '#9CA3AF'; // later
}

function dueDateLabel(dueDate: string): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  const diff = Math.floor((due.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return `Overdue by ${Math.abs(diff)} day${Math.abs(diff) !== 1 ? 's' : ''}`;
  if (diff === 0) return 'Due today';
  if (diff === 1) return 'Due tomorrow';
  return `Due ${due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

// ── Homework card ─────────────────────────────────────────────────────────────

function HomeworkCard({
  item,
  onAcknowledge,
}: {
  item: HomeworkItem;
  onAcknowledge: (id: string) => void;
}) {
  const palette = subjectPalette(item.subject);
  const dateColor = dueDateColor(item.due_date);
  const dateLabel = dueDateLabel(item.due_date);

  return (
    <View style={cardStyles.card}>
      {/* Subject badge */}
      <View style={[cardStyles.subjectBadge, { backgroundColor: palette.bg }]}>
        <Text style={[cardStyles.subjectText, { color: palette.text }]}>{item.subject}</Text>
      </View>

      {/* Title */}
      <Text style={cardStyles.title}>{item.title}</Text>

      {/* Description preview */}
      {item.description ? (
        <Text style={cardStyles.description} numberOfLines={2}>
          {item.description}
        </Text>
      ) : null}

      {/* Footer row */}
      <View style={cardStyles.footer}>
        <Text style={[cardStyles.dueDate, { color: dateColor }]}>{dateLabel}</Text>
        {item.is_acknowledged ? (
          <View style={cardStyles.doneRow}>
            <Text style={cardStyles.doneCheck}>✓</Text>
            <Text style={cardStyles.doneText}>Done</Text>
          </View>
        ) : (
          <TouchableOpacity
            style={cardStyles.doneButton}
            onPress={() => onAcknowledge(item.id)}
            accessibilityRole="button"
            accessibilityLabel={`Mark ${item.title} as done`}
          >
            <Text style={cardStyles.doneButtonText}>Mark Done</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 5,
    elevation: 2,
  },
  subjectBadge: {
    alignSelf: 'flex-start',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginBottom: 8,
  },
  subjectText: { fontSize: 11, fontWeight: '700' },
  title: { fontSize: 16, fontWeight: '700', color: '#111827', marginBottom: 4 },
  description: { fontSize: 13, color: '#6B7280', lineHeight: 19, marginBottom: 10 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  dueDate: { fontSize: 12, fontWeight: '600' },
  doneRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  doneCheck: { fontSize: 16, color: '#22C55E', fontWeight: '700' },
  doneText: { fontSize: 13, color: '#22C55E', fontWeight: '600' },
  doneButton: {
    backgroundColor: '#1D4ED8',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  doneButtonText: { fontSize: 13, color: '#FFFFFF', fontWeight: '600' },
});

// ── Main component ────────────────────────────────────────────────────────────

export default function HomeworkScreen() {
  const [homework, setHomework] = useState<HomeworkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<TabFilter>('Pending');
  const [acknowledging, setAcknowledging] = useState<string | null>(null);

  const fetchHomework = useCallback(async () => {
    try {
      const response = await apiClient.get('/api/homework');
      setHomework(response.data.data ?? []);
    } catch (err) {
      console.warn('[Homework] fetch error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchHomework(); }, [fetchHomework]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchHomework();
  }, [fetchHomework]);

  const handleAcknowledge = async (id: string) => {
    setAcknowledging(id);
    try {
      await apiClient.post(`/api/homework/${id}/acknowledge`);
      setHomework((prev) =>
        prev.map((h) => (h.id === id ? { ...h, is_acknowledged: true } : h))
      );
    } catch (err: any) {
      Alert.alert('Error', err.response?.data?.message ?? 'Failed to mark as done.');
    } finally {
      setAcknowledging(null);
    }
  };

  // Filter by tab
  const filtered = homework.filter((h) => {
    if (activeTab === 'Pending') return !h.is_acknowledged;
    if (activeTab === 'Completed') return h.is_acknowledged;
    return true;
  });

  // Sort by due date ascending
  const sorted = [...filtered].sort(
    (a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime()
  );

  const tabs: TabFilter[] = ['Pending', 'Completed', 'All'];

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <View style={styles.container}>
        {/* Tab bar */}
        <View style={styles.tabBar}>
          {tabs.map((tab) => (
            <TouchableOpacity
              key={tab}
              style={[styles.tab, activeTab === tab && styles.tabActive]}
              onPress={() => setActiveTab(tab)}
              accessibilityRole="tab"
              accessibilityState={{ selected: activeTab === tab }}
            >
              <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                {tab}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color="#1D4ED8" />
          </View>
        ) : (
          <FlatList
            style={styles.list}
            contentContainerStyle={styles.listContent}
            data={sorted}
            keyExtractor={(item) => item.id}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1D4ED8" />
            }
            renderItem={({ item }) => (
              <HomeworkCard
                item={item}
                onAcknowledge={acknowledging === item.id ? () => {} : handleAcknowledge}
              />
            )}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Text style={styles.emptyIcon}>
                  {activeTab === 'Pending' ? '🎉' : activeTab === 'Completed' ? '📚' : '📝'}
                </Text>
                <Text style={styles.emptyText}>
                  {activeTab === 'Pending'
                    ? 'No pending homework!'
                    : activeTab === 'Completed'
                    ? 'No completed homework yet.'
                    : 'No homework assigned yet.'}
                </Text>
              </View>
            }
          />
        )}
      </View>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: { borderBottomColor: '#1D4ED8' },
  tabText: { fontSize: 14, fontWeight: '500', color: '#9CA3AF' },
  tabTextActive: { color: '#1D4ED8', fontWeight: '700' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  list: { flex: 1 },
  listContent: { padding: 20, paddingBottom: 48 },
  emptyState: { alignItems: 'center', marginTop: 60 },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyText: { fontSize: 15, color: '#9CA3AF', textAlign: 'center' },
});
