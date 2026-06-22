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
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import apiClient from '../../api/client';
import { useAuthStore } from '../../store/authStore';
import type { HomeworkMeta } from '../../screens/student/HomeworkSubmitScreen';

// ── Navigation ─────────────────────────────────────────────────────────────────

type MoreStackParamList = {
  MoreHome: undefined;
  Homework: undefined;
  HomeworkSubmit: { homework: HomeworkMeta };
  Timetable: undefined;
  Notifications: undefined;
  Announcements: undefined;
  Complaints: undefined;
  FeeStatus: undefined;
  ChangePassword: undefined;
  LinkChild: undefined;
  Settings: undefined;
};

type MoreNavProp = StackNavigationProp<MoreStackParamList>;
type RootNavProp = StackNavigationProp<{
  HomeworkSubmit: { homework: HomeworkMeta };
}>;

// ── Types ─────────────────────────────────────────────────────────────────────

interface HomeworkItem {
  id: string;
  title: string;
  description: string | null;
  subject: string;
  due_date: string;
  acknowledged: boolean;
  created_at: string;
  /** Submission status from homework_submissions (student-only) */
  submission_status?: string | null;
  /** AI result when submission_status='checked' (student-only) */
  ai_result?: string | null;
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
  onPress,
}: {
  item: HomeworkItem;
  onPress: (item: HomeworkItem) => void;
}) {
  const palette = subjectPalette(item.subject);
  const dateColor = dueDateColor(item.due_date);
  const dateLabel = dueDateLabel(item.due_date);

  const status = item.submission_status ?? 'not_submitted';
  const ai = item.ai_result ?? null;

  const submissionStatusLabel: Record<string, { label: string; color: string }> = {
    not_submitted:      { label: 'Not attempted', color: '#EF4444' },
    submitted:          { label: 'Submitted', color: '#F59E0B' },
    processing:         { label: 'Checking…', color: '#3B82F6' },
    checked:            { label: 'Checked', color: '#22C55E' },
    flagged_for_review: { label: 'Under Review', color: '#F97316' },
  };

  const checkedOverrides: Record<string, { label: string; color: string }> = {
    partial: { label: 'Partial', color: '#F59E0B' },
    unclear: { label: 'Needs review', color: '#F97316' },
  };

  const subStatus =
    status === 'checked' && ai && checkedOverrides[ai]
      ? checkedOverrides[ai]
      : (submissionStatusLabel[status] ?? null);

  return (
    <TouchableOpacity
      style={cardStyles.card}
      onPress={() => onPress(item)}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={`Open homework: ${item.title}`}
    >
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
        <View style={cardStyles.footerRight}>
          {/* Submission status badge */}
          {subStatus && (
            <View style={[cardStyles.subStatusBadge, { backgroundColor: subStatus.color + '22' }]}>
              <Text style={[cardStyles.subStatusText, { color: subStatus.color }]}>
                {subStatus.label}
              </Text>
            </View>
          )}
          {/* Teacher read-receipt (acknowledgement) */}
          {item.acknowledged ? (
            <View style={cardStyles.doneRow}>
              <Text style={cardStyles.doneCheck}>✓</Text>
              <Text style={cardStyles.doneText}>Seen</Text>
            </View>
          ) : (
            <View style={cardStyles.newRow}>
              <View style={cardStyles.newDot} />
              <Text style={cardStyles.newText}>New</Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
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
  footerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dueDate: { fontSize: 12, fontWeight: '600' },
  doneRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  doneCheck: { fontSize: 16, color: '#22C55E', fontWeight: '700' },
  doneText: { fontSize: 13, color: '#22C55E', fontWeight: '600' },
  newRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  newDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#1D4ED8' },
  newText: { fontSize: 13, color: '#1D4ED8', fontWeight: '700' },
  subStatusBadge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  subStatusText: { fontSize: 11, fontWeight: '700' },
});

// ── Main component ────────────────────────────────────────────────────────────

export default function HomeworkScreen() {
  const student = useAuthStore((s) => s.student);
  const navigation = useNavigation<MoreNavProp>();
  const rootNavigation = useNavigation<RootNavProp>();
  const [homework, setHomework] = useState<HomeworkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<TabFilter>('Pending');

  const studentClass = student?.class ?? null;
  const studentSection = student?.section ?? null;

  const fetchHomework = useCallback(async () => {
    if (!studentClass || !studentSection) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      const response = await apiClient.get('/api/homework/class', {
        params: { class: studentClass, section: studentSection },
      });
      const raw: any[] = response.data.data ?? [];
      const normalised: HomeworkItem[] = raw.map((h) => ({
        id: h.id,
        title: h.title,
        description: h.description ?? null,
        subject: h.subject_name ?? h.subject ?? '',
        due_date: h.due_date,
        acknowledged: h.acknowledged ?? false,
        created_at: h.created_at,
        submission_status: h.submission_status ?? null,
        ai_result: h.ai_result ?? null,
      }));
      setHomework(normalised);
    } catch (err: unknown) {
      console.warn('[Homework] fetch error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [studentClass, studentSection]);

  useEffect(() => { fetchHomework(); }, [fetchHomework]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchHomework();
  }, [fetchHomework]);

  const acknowledgeSeen = async (id: string) => {
    try {
      await apiClient.post(`/api/homework/${id}/acknowledge`);
      setHomework((prev) =>
        prev.map((h) => (h.id === id ? { ...h, acknowledged: true } : h))
      );
    } catch {
      // Non-blocking — acknowledgement is only a "seen" receipt for teachers
    }
  };

  const handleOpenHomework = (item: HomeworkItem) => {
    // Mark as "seen" for teacher read receipt when the student opens it.
    if (!item.acknowledged) acknowledgeSeen(item.id);
    const params = {
      homework: {
        id: item.id,
        title: item.title,
        subject_name: item.subject ?? null,
        due_date: item.due_date,
        teacher_name: null,
      },
    };

    const tabParent = (navigation as any).getParent?.();
    const rootParent = tabParent?.getParent?.();
    if (rootParent?.navigate) {
      rootParent.navigate('HomeworkSubmit', params);
    } else if (tabParent?.navigate) {
      tabParent.navigate('HomeworkSubmit', params);
    } else {
      rootNavigation.navigate('HomeworkSubmit', params);
    }
  };

  // Filter by tab
  const needsAction = (h: HomeworkItem) => {
    const status = h.submission_status ?? 'not_submitted';
    const ai = h.ai_result ?? null;
    if (status === 'not_submitted') return true;
    if (status === 'checked' && (ai === 'partial' || ai === 'unclear')) return true;
    return false;
  };

  const filtered = homework.filter((h) => {
    if (activeTab === 'Pending') return needsAction(h);
    if (activeTab === 'Completed') return !needsAction(h);
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
                onPress={handleOpenHomework}
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
