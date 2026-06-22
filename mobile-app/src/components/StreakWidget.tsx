/**
 * StreakWidget.tsx
 *
 * A self-contained streak card component used on both the student home screen
 * and the parent home screen.
 *
 * Features:
 *  - Large 🔥 flame with current_streak number
 *  - Longest streak + total active days
 *  - ❄️ streak freeze badge (if available)
 *  - 30-day calendar contribution grid (like GitHub but simpler)
 *  - Encouraging message when streak = 0
 *  - Celebratory badge animation when streak >= 7
 *
 * Usage:
 *   <StreakWidget studentId={student.id} studentToken={token} />
 *   <StreakWidget studentId={child.id} studentToken={child.token} />
 *
 * Props:
 *   studentId    — UUID of the student whose streak to show
 *   studentToken — JWT for the student (authenticateStudent middleware)
 *   style        — optional outer container style override
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
} from 'react-native';
import apiClient from '../api/client';
import { useFocusEffect } from '@react-navigation/native';

// ── Types ─────────────────────────────────────────────────────────────────────

interface StreakData {
  current_streak: number;
  longest_streak: number;
  total_active_days: number;
  last_activity_date: string | null;
}

interface LogEntry {
  activity_date: string; // YYYY-MM-DD
  activity_type: 'daily_test' | 'test' | 'activity_pack' | 'both';
}

interface Props {
  studentId: string;
  /** JWT that authenticates as this student (student token, not parent token) */
  studentToken: string;
  style?: object;
}

// ── Calendar helpers ──────────────────────────────────────────────────────────

/** Generate an array of the last `days` date strings in YYYY-MM-DD format (IST). */
function lastNDays(days: number): string[] {
  const result: string[] = [];
  const now = Date.now();
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now + IST_OFFSET_MS - i * 24 * 60 * 60 * 1000);
    result.push(d.toISOString().slice(0, 10));
  }
  return result;
}

/** Day-of-month label for a YYYY-MM-DD string. */
function dayNum(dateStr: string): number {
  return parseInt(dateStr.slice(8), 10);
}

// Activity type → dot colour
const DOT_COLORS: Record<string, string> = {
  daily_test:    '#1D4ED8', // blue (legacy)
  test:          '#1D4ED8', // blue
  activity_pack: '#15803D', // green
  both:          '#F97316', // orange (both done — max engagement)
};

// ── Record-breaking celebration overlay ───────────────────────────────────────

function RecordBrokenModal({
  streak,
  visible,
  onDismiss,
}: {
  streak: number;
  visible: boolean;
  onDismiss: () => void;
}) {
  const scaleAnim = useRef(new Animated.Value(0.4)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: 1,
          friction: 5,
          tension: 120,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      scaleAnim.setValue(0.4);
      opacityAnim.setValue(0);
    }
  }, [visible, scaleAnim, opacityAnim]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onDismiss}
      statusBarTranslucent
    >
      <TouchableOpacity
        style={recordStyles.backdrop}
        activeOpacity={1}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss streak record celebration"
      >
        <Animated.View
          style={[
            recordStyles.card,
            { transform: [{ scale: scaleAnim }], opacity: opacityAnim },
          ]}
        >
          <Text style={recordStyles.fireworks}>🎉🔥🎉</Text>
          <Text style={recordStyles.title}>New Record!</Text>
          <Text style={recordStyles.subtitle}>
            You just broke your longest streak record!
          </Text>
          <Text style={recordStyles.streakNum}>{streak} days 🔥</Text>
          <Text style={recordStyles.hint}>Keep going — don't break it!</Text>
          <TouchableOpacity
            style={recordStyles.dismissBtn}
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityLabel="Close celebration"
          >
            <Text style={recordStyles.dismissText}>Awesome! 🙌</Text>
          </TouchableOpacity>
        </Animated.View>
      </TouchableOpacity>
    </Modal>
  );
}

const recordStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 28,
    alignItems: 'center',
    width: '100%',
    maxWidth: 340,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 20,
    elevation: 12,
  },
  fireworks: { fontSize: 44, marginBottom: 8 },
  title: {
    fontSize: 26,
    fontWeight: '900',
    color: '#EA580C',
    marginBottom: 6,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    marginBottom: 16,
    lineHeight: 20,
  },
  streakNum: {
    fontSize: 42,
    fontWeight: '900',
    color: '#F97316',
    marginBottom: 8,
  },
  hint: {
    fontSize: 13,
    color: '#9CA3AF',
    fontStyle: 'italic',
    marginBottom: 24,
  },
  dismissBtn: {
    backgroundColor: '#EA580C',
    borderRadius: 12,
    paddingHorizontal: 32,
    paddingVertical: 12,
  },
  dismissText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 15,
  },
});

// ── Flame animation ───────────────────────────────────────────────────────────

function FlameIcon({ streak }: { streak: number }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (streak >= 7) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(scaleAnim, { toValue: 1.15, duration: 500, useNativeDriver: true }),
          Animated.timing(scaleAnim, { toValue: 1.0,  duration: 500, useNativeDriver: true }),
        ])
      ).start();
    } else {
      scaleAnim.setValue(1);
    }
  }, [streak, scaleAnim]);

  return (
    <Animated.Text
      style={[streakStyles.flameEmoji, { transform: [{ scale: scaleAnim }] }]}
      accessibilityLabel={`${streak} day streak flame`}
    >
      🔥
    </Animated.Text>
  );
}

// ── Calendar grid ─────────────────────────────────────────────────────────────

function CalendarGrid({ logEntries }: { logEntries: LogEntry[] }) {
  const days = lastNDays(30);

  // Build a set of active dates for O(1) lookup
  const activeMap = new Map<string, string>(); // date → activity_type
  for (const entry of logEntries) {
    activeMap.set(entry.activity_date, entry.activity_type);
  }

  // Split into rows of 7
  const rows: string[][] = [];
  for (let i = 0; i < days.length; i += 7) {
    rows.push(days.slice(i, i + 7));
  }

  return (
    <View style={calStyles.container}>
      <Text style={calStyles.label}>Last 30 days</Text>
      {rows.map((row, rowIdx) => (
        <View key={rowIdx} style={calStyles.row}>
          {row.map((date) => {
            const actType = activeMap.get(date);
            const isActive = !!actType;
            const dotColor = actType ? DOT_COLORS[actType] ?? '#1D4ED8' : '#E5E7EB';
            return (
              <View
                key={date}
                style={[calStyles.dot, { backgroundColor: dotColor }]}
                accessibilityLabel={
                  isActive
                    ? `${date}: activity completed`
                    : `${date}: no activity`
                }
              >
                <Text style={[calStyles.dotText, isActive && calStyles.dotTextActive]}>
                  {dayNum(date)}
                </Text>
              </View>
            );
          })}
        </View>
      ))}
      {/* Legend */}
      <View style={calStyles.legend}>
        <View style={calStyles.legendItem}>
          <View style={[calStyles.legendDot, { backgroundColor: DOT_COLORS.test }]} />
          <Text style={calStyles.legendLabel}>Test</Text>
        </View>
        <View style={calStyles.legendItem}>
          <View style={[calStyles.legendDot, { backgroundColor: DOT_COLORS.activity_pack }]} />
          <Text style={calStyles.legendLabel}>Activity</Text>
        </View>
        <View style={calStyles.legendItem}>
          <View style={[calStyles.legendDot, { backgroundColor: DOT_COLORS.both }]} />
          <Text style={calStyles.legendLabel}>Both</Text>
        </View>
        <View style={calStyles.legendItem}>
          <View style={[calStyles.legendDot, { backgroundColor: '#E5E7EB' }]} />
          <Text style={calStyles.legendLabel}>None</Text>
        </View>
      </View>
    </View>
  );
}

const calStyles = StyleSheet.create({
  container: { marginTop: 14 },
  label: { fontSize: 11, color: '#9CA3AF', fontWeight: '600', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.4 },
  row: { flexDirection: 'row', gap: 4, marginBottom: 4 },
  dot: {
    width: 36,
    height: 28,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  dotText: { fontSize: 10, color: '#9CA3AF', fontWeight: '500' },
  dotTextActive: { color: '#FFFFFF', fontWeight: '700' },
  legend: { flexDirection: 'row', gap: 12, marginTop: 8 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 10, height: 10, borderRadius: 3 },
  legendLabel: { fontSize: 10, color: '#9CA3AF' },
});

// ── Main component ────────────────────────────────────────────────────────────

export default function StreakWidget({ studentId, studentToken, style }: Props) {
  const [streakData, setStreakData] = useState<StreakData | null>(null);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [showRecordModal, setShowRecordModal] = useState(false);

  // Track the previous longest streak so we can detect when a new record is set
  const prevLongestRef = useRef<number | null>(null);

  const fetchStreak = useCallback(async () => {
    if (!studentId || !studentToken) return;

    try {
      const headers = { Authorization: `Bearer ${studentToken}` };

      const [streakRes, logRes] = await Promise.allSettled([
        apiClient.get('/api/student-progress/streak', { headers }),
        apiClient.get('/api/student-progress/streak/log', { headers, params: { days: 30 } }),
      ]);

      if (streakRes.status === 'fulfilled') {
        const incoming = streakRes.value.data.data ?? null;
        if (incoming) {
          const newCurrent: number = incoming.current_streak ?? 0;
          const newLongest: number = incoming.longest_streak ?? 0;

          // Show record-broken modal if:
          //  - we had a previous longest on record (not the very first load)
          //  - current streak has now exceeded that previous longest
          //  - new longest is > 0 (not a freshly reset streak)
          if (
            prevLongestRef.current !== null &&
            newCurrent > 0 &&
            newLongest > prevLongestRef.current &&
            newLongest === newCurrent
          ) {
            setShowRecordModal(true);
          }
          prevLongestRef.current = newLongest;
        }
        setStreakData(incoming);
      }
      if (logRes.status === 'fulfilled') {
        setLogEntries(logRes.value.data.data ?? []);
      }
    } catch {
      // Non-critical — widget can be silently empty
    } finally {
      setLoading(false);
    }
  }, [studentId, studentToken]);

  useEffect(() => { fetchStreak(); }, [fetchStreak]);

  // Re-fetch whenever the parent screen comes back into focus
  // (e.g. after student completes a test or submits homework)
  useFocusEffect(
    useCallback(() => {
      fetchStreak();
    }, [fetchStreak])
  );

  // Don't render if no data and not loading (no streaks yet)
  if (!loading && !streakData) return null;

  if (loading) {
    return (
      <View style={[widgetStyles.card, style]}>
        <ActivityIndicator size="small" color="#F97316" />
      </View>
    );
  }

  const streak = streakData!;
  const currentStreak = streak.current_streak;
  const isCelebrating = currentStreak >= 7;
  const hasActivity = streak.total_active_days > 0;

  return (
    <View style={[widgetStyles.card, style]}>
      {/* ── Record-broken celebration modal ── */}
      <RecordBrokenModal
        streak={streak.current_streak}
        visible={showRecordModal}
        onDismiss={() => setShowRecordModal(false)}
      />
      {/* ── Main streak row ── */}
      <View style={widgetStyles.mainRow}>
        {/* Flame + number */}
        <View style={widgetStyles.flameBlock}>
          <FlameIcon streak={currentStreak} />
          <Text style={widgetStyles.streakNum}>{currentStreak}</Text>
        </View>

        {/* Info */}
        <View style={widgetStyles.infoBlock}>
          <Text style={widgetStyles.streakLabel}>
            day streak{currentStreak !== 1 ? '' : ''}
          </Text>
          <Text style={widgetStyles.streakSub}>
            Longest: {streak.longest_streak} days
          </Text>
          <Text style={widgetStyles.streakSub}>
            Total active: {streak.total_active_days} days
          </Text>
        </View>
      </View>

      {/* ── Encouraging message ── */}
      {currentStreak === 0 && hasActivity && (
        <Text style={widgetStyles.encourageMsg}>
          Start a new streak today! Complete today's activity 💪
        </Text>
      )}

      {currentStreak === 0 && !hasActivity && (
        <Text style={widgetStyles.encourageMsg}>
          Complete a test or activity to start your streak! 🚀
        </Text>
      )}

      {/* ── Celebration badge for >= 7 days ── */}
      {isCelebrating && (
        <View style={widgetStyles.celebBadge} accessibilityLabel={`${currentStreak} day streak — great work!`}>
          <Text style={widgetStyles.celebText}>
            🎉 {currentStreak >= 100 ? 'Legendary!' : currentStreak >= 50 ? 'Incredible!' : currentStreak >= 30 ? 'Amazing!' : currentStreak >= 14 ? 'On fire!' : 'Great streak!'}
          </Text>
        </View>
      )}

      {/* ── Expand/collapse toggle for calendar ── */}
      <TouchableOpacity
        style={widgetStyles.toggleBtn}
        onPress={() => setExpanded((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Hide activity calendar' : 'Show activity calendar'}
      >
        <Text style={widgetStyles.toggleText}>
          {expanded ? '▲ Hide calendar' : '▼ Show 30-day calendar'}
        </Text>
      </TouchableOpacity>

      {/* ── Calendar grid (expandable) ── */}
      {expanded && <CalendarGrid logEntries={logEntries} />}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const streakStyles = StyleSheet.create({
  flameEmoji: { fontSize: 36 },
});

const widgetStyles = StyleSheet.create({
  card: {
    backgroundColor: '#FFF7ED',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#FED7AA',
    marginBottom: 16,
  },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  flameBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  streakNum: {
    fontSize: 36,
    fontWeight: '900',
    color: '#EA580C',
    lineHeight: 40,
  },
  infoBlock: {
    flex: 1,
  },
  streakLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: '#92400E',
  },
  streakSub: {
    fontSize: 12,
    color: '#B45309',
    marginTop: 1,
  },
  encourageMsg: {
    marginTop: 10,
    fontSize: 13,
    color: '#92400E',
    fontStyle: 'italic',
    lineHeight: 18,
  },
  celebBadge: {
    marginTop: 10,
    backgroundColor: '#FEF3C7',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  celebText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#92400E',
  },
  toggleBtn: {
    marginTop: 12,
    alignSelf: 'flex-start',
  },
  toggleText: {
    fontSize: 12,
    color: '#B45309',
    fontWeight: '600',
  },
});
