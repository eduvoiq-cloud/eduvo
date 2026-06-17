import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  TextInput,
  ActivityIndicator,
  StatusBar,
  Alert,
} from 'react-native';
import apiClient from '../../api/client';
import { useAuthStore } from '../../store/authStore';
import StreakWidget from '../../components/StreakWidget';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Activity {
  instruction: string;
  type: 'verbal' | 'written' | 'physical';
}

interface Completion {
  activity_pack_id: string;
  parent_marked_complete: boolean;
  reading_minutes: number | null;
  completed_at: string | null;
}

interface ActivityPack {
  id: string;
  subject: string;
  topic: string;
  activity_date: string;
  class: string;
  section: string;
  activities: Activity[];
  completion: Completion | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TYPE_CONFIG: Record<Activity['type'], { icon: string; color: string; bg: string }> = {
  verbal:   { icon: '💬', color: '#1D4ED8', bg: '#EFF6FF' },
  written:  { icon: '✏️', color: '#7C3AED', bg: '#F5F3FF' },
  physical: { icon: '🤸', color: '#15803D', bg: '#F0FDF4' },
};

// ── Skeleton ──────────────────────────────────────────────────────────────────

function SkeletonBlock({ width, height, style }: { width: number | string; height: number; style?: object }) {
  return (
    <View style={[{ width, height, borderRadius: 6, backgroundColor: '#E5E7EB' }, style]} />
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ActivityPacksScreen() {
  const student = useAuthStore((s) => s.student);
  const token = useAuthStore((s) => s.token);

  const [packs, setPacks] = useState<ActivityPack[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notPremium, setNotPremium] = useState(false);

  // Per-pack state
  const [readingMinutes, setReadingMinutes] = useState<Record<string, string>>({});
  const [completing, setCompleting] = useState<Record<string, boolean>>({});

  // ── Fetch data ──────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setError(null);
    setNotPremium(false);
    try {
      const packsRes = await apiClient.get('/api/activity-packs/student/today').catch((err) => {
        throw err;
      });
      setPacks(packsRes.data.data ?? []);
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } }).response?.status;
      const msg = (err as { response?: { data?: { message?: string }; status?: number } }).response?.data?.message
        ?? (err instanceof Error ? err.message : 'Failed to load');
      // 403 means not premium — show "Ask School Admin" gate, not an error banner
      if (status === 403 || msg.toLowerCase().includes('premium')) {
        setNotPremium(true);
        setPacks([]);
      } else {
        setError(msg);
        setPacks([]);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchData();
  }, [fetchData]);

  // ── Mark complete ───────────────────────────────────────────────────────────

  async function handleMarkComplete(packId: string, hasWrittenActivity: boolean) {
    setCompleting((prev) => ({ ...prev, [packId]: true }));
    try {
      const mins = readingMinutes[packId];
      const body: Record<string, unknown> = {};
      if (hasWrittenActivity && mins) {
        const n = parseInt(mins, 10);
        if (!isNaN(n) && n > 0) body.reading_minutes = n;
      }

      const res = await apiClient.post(`/api/activity-packs/${packId}/complete`, body);
      const newStreak = res.data.data?.streak as number | undefined;

      // Update local completion state
      setPacks((prev) =>
        prev.map((p) =>
          p.id === packId
            ? {
                ...p,
                completion: {
                  activity_pack_id: packId,
                  parent_marked_complete: true,
                  reading_minutes: body.reading_minutes as number | null ?? null,
                  completed_at: new Date().toISOString(),
                },
              }
            : p
        )
      );

      // Show celebration — StreakWidget auto-refreshes on next mount/focus
      if (typeof newStreak === 'number' && newStreak > 0) {
        Alert.alert(
          '🌟 Great job!',
          `Activity completed! Streak is now ${newStreak} day${newStreak !== 1 ? 's' : ''}!`,
          [{ text: 'Awesome!' }]
        );
      }
    } catch (err: unknown) {
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { message?: string } } }).response?.data?.message ?? 'Failed to mark complete'
          : 'Failed to mark complete';
      Alert.alert('Oops!', msg);
    } finally {
      setCompleting((prev) => ({ ...prev, [packId]: false }));
    }
  }

  // ── Render helpers ──────────────────────────────────────────────────────────

  const greeting = student?.name
    ? `Hi, ${(student.name as string).split(' ')[0]}!`
    : "Today's Activities";

  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  if (loading) {
    return (
      <View style={styles.container}>
        <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
        <ScrollView contentContainerStyle={styles.content}>
          <SkeletonBlock width="50%" height={22} style={{ marginBottom: 8 }} />
          <SkeletonBlock width="70%" height={14} style={{ marginBottom: 24 }} />
          <SkeletonBlock width="100%" height={80} style={{ marginBottom: 16 }} />
          <SkeletonBlock width="100%" height={200} style={{ marginBottom: 12 }} />
        </ScrollView>
      </View>
    );
  }

  // ── Main render ─────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1D4ED8" />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>{greeting}</Text>
          <Text style={styles.headerDate}>{today}</Text>
        </View>

        {/* Streak widget — replaces the old basic streak card */}
        {student && token && (
          <StreakWidget
            studentId={student.id}
            studentToken={token}
            style={{ marginBottom: 12 }}
          />
        )}

        {/* Error */}
        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={fetchData} style={styles.retryBtn}>
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Premium gate — not subscribed */}
        {!error && notPremium && (
          <View style={styles.premiumGate}>
            <Text style={styles.premiumGateIcon}>🔒</Text>
            <Text style={styles.premiumGateTitle}>Premium Required</Text>
            <Text style={styles.premiumGateText}>
              Ask your school admin to activate the Premium Junior plan to unlock home activity packs.
            </Text>
          </View>
        )}

        {/* Empty state */}
        {!error && !notPremium && packs.length === 0 && (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyIcon}>📭</Text>
            <Text style={styles.emptyTitle}>No activities today</Text>
            <Text style={styles.emptyText}>
              Your teacher hasn't sent any home activities yet. Check back after school!
            </Text>
          </View>
        )}

        {/* Activity packs */}
        {packs.map((pack) => {
          const isCompleted = pack.completion?.parent_marked_complete === true;
          const hasWritten = pack.activities.some((a) => a.type === 'written');

          return (
            <View key={pack.id} style={[styles.packCard, isCompleted && styles.packCardDone]}>
              {/* Pack header */}
              <View style={styles.packHeader}>
                <View style={styles.packMeta}>
                  <Text style={styles.packSubject}>{pack.subject}</Text>
                  <Text style={styles.packTopic}>"{pack.topic}"</Text>
                </View>
                {isCompleted && (
                  <View style={styles.completedBadge}>
                    <Text style={styles.completedBadgeText}>✓ Done</Text>
                  </View>
                )}
              </View>

              {/* Activities list */}
              <View style={styles.activitiesList}>
                {pack.activities.map((activity, idx) => {
                  const cfg = TYPE_CONFIG[activity.type] ?? TYPE_CONFIG.verbal;
                  return (
                    <View key={idx} style={[styles.activityRow, { backgroundColor: cfg.bg }]}>
                      <View style={styles.activityNumber}>
                        <Text style={styles.activityNumberText}>{idx + 1}</Text>
                      </View>
                      <View style={styles.activityContent}>
                        <View style={styles.activityTypeRow}>
                          <Text style={styles.activityTypeIcon}>{cfg.icon}</Text>
                          <Text style={[styles.activityTypeLabel, { color: cfg.color }]}>
                            {activity.type.charAt(0).toUpperCase() + activity.type.slice(1)}
                          </Text>
                        </View>
                        <Text style={styles.activityInstruction}>{activity.instruction}</Text>
                      </View>
                    </View>
                  );
                })}
              </View>

              {/* Reading minutes input (only if there are written activities) */}
              {!isCompleted && hasWritten && (
                <View style={styles.readingRow}>
                  <Text style={styles.readingLabel}>✏️ Minutes spent on written activity:</Text>
                  <TextInput
                    style={styles.readingInput}
                    keyboardType="number-pad"
                    placeholder="e.g. 5"
                    value={readingMinutes[pack.id] ?? ''}
                    onChangeText={(t) =>
                      setReadingMinutes((prev) => ({ ...prev, [pack.id]: t }))
                    }
                    maxLength={3}
                    accessible
                    accessibilityLabel="Minutes spent on written activity"
                  />
                </View>
              )}

              {/* Mark complete button */}
              {!isCompleted ? (
                <TouchableOpacity
                  style={[styles.markBtn, completing[pack.id] && styles.markBtnDisabled]}
                  onPress={() => handleMarkComplete(pack.id, hasWritten)}
                  disabled={completing[pack.id]}
                  accessible
                  accessibilityLabel="Mark day complete"
                  accessibilityRole="button"
                >
                  {completing[pack.id] ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <Text style={styles.markBtnText}>✓ Mark Day Complete</Text>
                  )}
                </TouchableOpacity>
              ) : (
                <View style={styles.completedRow}>
                  <Text style={styles.completedText}>
                    🌟 Completed at{' '}
                    {pack.completion?.completed_at
                      ? ((pack.completion.completed_at && !pack.completion.completed_at.endsWith('Z') && !pack.completion.completed_at.includes('+') && !/\d{2}:\d{2}$/.test(pack.completion.completed_at))
                          ? new Date(pack.completion.completed_at + 'Z')
                          : new Date(pack.completion.completed_at)
                        ).toLocaleTimeString('en-IN', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : 'today'}
                  </Text>
                  {pack.completion?.reading_minutes != null && (
                    <Text style={styles.completedSub}>
                      ✏️ {pack.completion.reading_minutes} min written activity
                    </Text>
                  )}
                </View>
              )}
            </View>
          );
        })}

        {/* Bottom tip */}
        {packs.length > 0 && (
          <View style={styles.tip}>
            <Text style={styles.tipText}>
              💡 Tip: These activities are designed to take 10–15 minutes total. Do them together with your child for the best experience!
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 16,
    paddingBottom: 32,
  },
  header: {
    marginBottom: 20,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111827',
  },
  headerDate: {
    fontSize: 13,
    color: '#6B7280',
    marginTop: 2,
  },
  errorBox: {
    backgroundColor: '#FEF2F2',
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#FECACA',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    color: '#B91C1C',
  },
  retryBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#EF4444',
    borderRadius: 6,
  },
  retryText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  emptyBox: {
    alignItems: 'center',
    paddingVertical: 48,
    paddingHorizontal: 24,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 8,
    textAlign: 'center',
  },
  emptyText: {
    fontSize: 13,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 20,
  },
  packCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  packCardDone: {
    borderColor: '#A7F3D0',
    backgroundColor: '#F0FDF4',
  },
  packHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 14,
    gap: 8,
  },
  packMeta: {
    flex: 1,
  },
  packSubject: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1D4ED8',
    marginBottom: 2,
  },
  packTopic: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
  },
  completedBadge: {
    backgroundColor: '#D1FAE5',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  completedBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#065F46',
  },
  activitiesList: {
    gap: 8,
    marginBottom: 14,
  },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderRadius: 10,
    padding: 10,
    gap: 10,
  },
  activityNumber: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
    flexShrink: 0,
  },
  activityNumberText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#374151',
  },
  activityContent: {
    flex: 1,
  },
  activityTypeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
  },
  activityTypeIcon: {
    fontSize: 12,
  },
  activityTypeLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  activityInstruction: {
    fontSize: 13,
    color: '#374151',
    lineHeight: 20,
  },
  readingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
    backgroundColor: '#F5F3FF',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  readingLabel: {
    flex: 1,
    fontSize: 12,
    color: '#5B21B6',
    fontWeight: '500',
  },
  readingInput: {
    width: 60,
    height: 36,
    borderWidth: 1,
    borderColor: '#C4B5FD',
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 14,
    color: '#111827',
    backgroundColor: '#FFFFFF',
    textAlign: 'center',
  },
  markBtn: {
    backgroundColor: '#059669',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  markBtnDisabled: {
    backgroundColor: '#6EE7B7',
  },
  markBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  completedRow: {
    backgroundColor: '#D1FAE5',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  completedText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#065F46',
  },
  completedSub: {
    fontSize: 12,
    color: '#047857',
    marginTop: 3,
  },
  tip: {
    backgroundColor: '#EFF6FF',
    borderRadius: 10,
    padding: 14,
    marginTop: 4,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  tipText: {
    fontSize: 12,
    color: '#1E40AF',
    lineHeight: 18,
  },
  premiumGate: {
    alignItems: 'center',
    backgroundColor: '#F0F9FF',
    borderRadius: 14,
    padding: 28,
    borderWidth: 1,
    borderColor: '#BAE6FD',
    marginTop: 8,
  },
  premiumGateIcon: {
    fontSize: 44,
    marginBottom: 12,
  },
  premiumGateTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0C4A6E',
    marginBottom: 8,
    textAlign: 'center',
  },
  premiumGateText: {
    fontSize: 14,
    color: '#0369A1',
    textAlign: 'center',
    lineHeight: 22,
  },
});
