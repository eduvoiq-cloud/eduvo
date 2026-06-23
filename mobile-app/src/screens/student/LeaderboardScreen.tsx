/**
 * LeaderboardScreen.tsx
 *
 * Class-level monthly leaderboard. Shows top 5 students + the viewing
 * student's own rank (always visible even if they're rank 34, etc.).
 *
 * Score breakdown (max 100 pts):
 *   Marks 40 · Tests 20 · Streak 20 · Homework 10 · Attendance 10
 *
 * Monthly refresh: fully automatic — the backend only counts current-month
 * data so scores start from 0 on the 1st of every month with no cron needed.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  StatusBar,
  Animated,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import apiClient from '../../api/client';
import { useAuthStore } from '../../store/authStore';
import { useChildStore } from '../../store/childStore';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Breakdown {
  marks: number;
  tests: number;
  streak: number;
  homework: number;
  attendance: number;
}

interface RawValues {
  marks_avg_pct: number;
  test_avg_pct: number;
  streak_days: number;
  homework_count: number;
  attendance_pct: number;
}

interface LeaderboardEntry {
  rank: number;
  student_id: string;
  student_name: string;
  total_score: number;
  breakdown: Breakdown;
  raw: RawValues;
  is_current_student: boolean;
}

interface LeaderboardData {
  leaderboard: LeaderboardEntry[];
  days_until_reset: number;
  month_start: string;
  total_students: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rankMedal(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

function currentMonthLabel(): string {
  return new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

function scoreColor(score: number): string {
  if (score >= 75) return '#22C55E';
  if (score >= 50) return '#F59E0B';
  return '#EF4444';
}

// ── Score bar ─────────────────────────────────────────────────────────────────

function ScoreBar({
  label,
  score,
  max,
  color,
}: {
  label: string;
  score: number;
  max: number;
  color: string;
}) {
  const pct = max > 0 ? Math.min((score / max) * 100, 100) : 0;
  return (
    <View style={barStyles.row}>
      <Text style={barStyles.label}>{label}</Text>
      <View style={barStyles.track}>
        <View style={[barStyles.fill, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
      <Text style={barStyles.value}>
        {score}/{max}
      </Text>
    </View>
  );
}

const barStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 5 },
  label: { fontSize: 11, color: '#6B7280', width: 80 },
  track: {
    flex: 1,
    height: 6,
    backgroundColor: '#F3F4F6',
    borderRadius: 3,
    overflow: 'hidden',
    marginHorizontal: 6,
  },
  fill: { height: 6, borderRadius: 3 },
  value: { fontSize: 11, color: '#374151', fontWeight: '600', width: 32, textAlign: 'right' },
});

// ── Breakdown panel ───────────────────────────────────────────────────────────

function BreakdownPanel({ entry }: { entry: LeaderboardEntry }) {
  return (
    <View style={bpStyles.container}>
      <ScoreBar label="📊 Marks"      score={entry.breakdown.marks}      max={40} color="#1D4ED8" />
      <ScoreBar label="📝 Tests"      score={entry.breakdown.tests}      max={20} color="#7C3AED" />
      <ScoreBar label="🔥 Streak"     score={entry.breakdown.streak}     max={20} color="#EA580C" />
      <ScoreBar label="📚 Homework"   score={entry.breakdown.homework}   max={10} color="#F59E0B" />
      <ScoreBar label="📅 Attendance" score={entry.breakdown.attendance} max={10} color="#22C55E" />
      <View style={bpStyles.rawRow}>
        <Text style={bpStyles.rawText}>Marks avg: {entry.raw.marks_avg_pct}%</Text>
        <Text style={bpStyles.rawText}>Streak: {entry.raw.streak_days}d</Text>
        <Text style={bpStyles.rawText}>HW submitted: {entry.raw.homework_count}</Text>
        <Text style={bpStyles.rawText}>Attendance: {entry.raw.attendance_pct}%</Text>
      </View>
    </View>
  );
}

const bpStyles = StyleSheet.create({
  container: {
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    marginTop: 10,
  },
  rawRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  rawText: { fontSize: 10, color: '#9CA3AF' },
});

// ── Podium card (rank 1 / 2 / 3) ─────────────────────────────────────────────

const PODIUM_COLORS: Record<number, string> = {
  1: '#F59E0B',
  2: '#9CA3AF',
  3: '#CD7F32',
};

function PodiumCard({
  entry,
  podiumHeight,
}: {
  entry: LeaderboardEntry;
  podiumHeight: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const color = PODIUM_COLORS[entry.rank] ?? '#6B7280';
  const isMe  = entry.is_current_student;
  // First name only so it fits the narrow column
  const displayName = entry.student_name.split(' ')[0];

  return (
    <TouchableOpacity
      style={podStyles.wrapper}
      onPress={() => setExpanded((v) => !v)}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={`${entry.student_name}, rank ${entry.rank}, ${entry.total_score} points`}
    >
      <Text style={podStyles.medal}>{rankMedal(entry.rank)}</Text>
      <View
        style={[
          podStyles.podium,
          { height: podiumHeight, borderTopColor: color },
          isMe && podStyles.podiumMe,
        ]}
      >
        <Text style={[podStyles.name, isMe && podStyles.nameMe]} numberOfLines={2}>
          {displayName}
          {isMe ? '\n(You)' : ''}
        </Text>
        <Text style={[podStyles.score, { color }]}>{entry.total_score}</Text>
        <Text style={podStyles.pts}>pts</Text>
      </View>
      {expanded && (
        <View style={podStyles.breakdown}>
          <BreakdownPanel entry={entry} />
        </View>
      )}
    </TouchableOpacity>
  );
}

const podStyles = StyleSheet.create({
  wrapper: {
    flex: 1,
    alignItems: 'center',
    marginHorizontal: 4,
  },
  medal: { fontSize: 26, marginBottom: 4 },
  podium: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderTopWidth: 4,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 3,
  },
  podiumMe: {
    borderWidth: 2,
    borderColor: '#1D4ED8',
  },
  name: {
    fontSize: 12,
    fontWeight: '700',
    color: '#111827',
    textAlign: 'center',
    marginBottom: 6,
  },
  nameMe: { color: '#1D4ED8' },
  score: { fontSize: 22, fontWeight: '900' },
  pts: { fontSize: 10, color: '#9CA3AF' },
  breakdown: { width: '100%', marginTop: 8 },
});

// ── Rank 4 / 5 list row ───────────────────────────────────────────────────────

function RankRow({ entry }: { entry: LeaderboardEntry }) {
  const [expanded, setExpanded] = useState(false);
  const color = scoreColor(entry.total_score);
  const isMe  = entry.is_current_student;

  return (
    <TouchableOpacity
      style={[rowStyles.row, isMe && rowStyles.rowMe]}
      onPress={() => setExpanded((v) => !v)}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={`${entry.student_name}, rank ${entry.rank}, ${entry.total_score} points`}
    >
      {/* Rank */}
      <View style={rowStyles.rankBox}>
        <Text style={[rowStyles.rank, isMe && rowStyles.rankMe]}>#{entry.rank}</Text>
      </View>

      {/* Name + sub */}
      <View style={rowStyles.info}>
        <Text style={[rowStyles.name, isMe && rowStyles.nameMe]} numberOfLines={1}>
          {entry.student_name}
          {isMe ? ' (You)' : ''}
        </Text>
        <Text style={rowStyles.sub}>
          Marks {entry.raw.marks_avg_pct}% · Streak {entry.raw.streak_days}d · Attend {entry.raw.attendance_pct}%
        </Text>
      </View>

      {/* Score */}
      <Text style={[rowStyles.score, { color }]}>{entry.total_score}</Text>
      <Text style={rowStyles.chevron}>{expanded ? '▲' : '▼'}</Text>

      {/* Breakdown (expandable) */}
      {expanded && (
        <View style={rowStyles.breakdownWrapper}>
          <BreakdownPanel entry={entry} />
        </View>
      )}
    </TouchableOpacity>
  );
}

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
    flexWrap: 'wrap',
  },
  rowMe: {
    backgroundColor: '#EFF6FF',
    borderWidth: 1.5,
    borderColor: '#1D4ED8',
  },
  rankBox: { width: 38, alignItems: 'center' },
  rank: { fontSize: 14, fontWeight: '700', color: '#9CA3AF' },
  rankMe: { color: '#1D4ED8' },
  info: { flex: 1, marginLeft: 8 },
  name: { fontSize: 14, fontWeight: '600', color: '#111827' },
  nameMe: { color: '#1D4ED8' },
  sub: { fontSize: 11, color: '#9CA3AF', marginTop: 2 },
  score: { fontSize: 18, fontWeight: '800', marginRight: 4 },
  chevron: { fontSize: 11, color: '#D1D5DB' },
  breakdownWrapper: { width: '100%', marginTop: 4 },
});

// ── "Your Rank" pinned card (shown when student is rank 6+) ──────────────────

function MyRankCard({ entry }: { entry: LeaderboardEntry }) {
  const [expanded, setExpanded] = useState(false);
  const color = scoreColor(entry.total_score);

  return (
    <View style={myStyles.container}>
      <TouchableOpacity
        style={myStyles.card}
        onPress={() => setExpanded((v) => !v)}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={`Your rank: ${entry.rank}, score ${entry.total_score}`}
      >
        <View style={myStyles.left}>
          <Text style={myStyles.rankLabel}>Your Rank</Text>
          <Text style={myStyles.rank}>#{entry.rank}</Text>
          <Text style={myStyles.outOf}>out of {''}</Text>
        </View>
        <View style={myStyles.mid}>
          <Text style={myStyles.name} numberOfLines={1}>{entry.student_name}</Text>
          <Text style={myStyles.sub}>
            Marks {entry.raw.marks_avg_pct}% · Streak {entry.raw.streak_days}d · Attend {entry.raw.attendance_pct}%
          </Text>
        </View>
        <View style={myStyles.right}>
          <Text style={[myStyles.score, { color }]}>{entry.total_score}</Text>
          <Text style={myStyles.pts}>pts</Text>
        </View>
        <Text style={myStyles.chevron}>{expanded ? '▲' : '▼'}</Text>

        {expanded && (
          <View style={myStyles.breakdown}>
            <BreakdownPanel entry={entry} />
          </View>
        )}
      </TouchableOpacity>
    </View>
  );
}

const myStyles = StyleSheet.create({
  container: {
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#DBEAFE',
    paddingTop: 16,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#EFF6FF',
    borderRadius: 14,
    padding: 16,
    borderWidth: 2,
    borderColor: '#1D4ED8',
    flexWrap: 'wrap',
    shadowColor: '#1D4ED8',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 3,
  },
  left: { alignItems: 'center', marginRight: 14 },
  rankLabel: { fontSize: 9, color: '#1D4ED8', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  rank: { fontSize: 28, fontWeight: '900', color: '#1D4ED8', lineHeight: 32 },
  outOf: { fontSize: 9, color: '#93C5FD' },
  mid: { flex: 1 },
  name: { fontSize: 14, fontWeight: '700', color: '#1D4ED8', marginBottom: 3 },
  sub: { fontSize: 11, color: '#3B82F6', lineHeight: 16 },
  right: { alignItems: 'center', marginLeft: 8 },
  score: { fontSize: 22, fontWeight: '900' },
  pts: { fontSize: 10, color: '#9CA3AF' },
  chevron: { fontSize: 11, color: '#93C5FD', marginLeft: 6 },
  breakdown: { width: '100%', marginTop: 4 },
});

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <View style={emptyStyles.container}>
      <Text style={emptyStyles.emoji}>📊</Text>
      <Text style={emptyStyles.title}>No scores yet this month</Text>
      <Text style={emptyStyles.sub}>
        Complete tests, submit homework, and maintain your streak to climb the leaderboard!
      </Text>
    </View>
  );
}

const emptyStyles = StyleSheet.create({
  container: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 32 },
  emoji: { fontSize: 48, marginBottom: 12 },
  title: { fontSize: 17, fontWeight: '700', color: '#111827', marginBottom: 8, textAlign: 'center' },
  sub: { fontSize: 13, color: '#9CA3AF', textAlign: 'center', lineHeight: 20 },
});

// ── Main component ────────────────────────────────────────────────────────────

export default function LeaderboardScreen() {
  const student = useAuthStore((s) => s.student);
  const token   = useAuthStore((s) => s.token);
  const { linkedChildren, activeChildIndex } = useChildStore();

  const activeStudent =
    linkedChildren.length > 0 ? linkedChildren[activeChildIndex] : student;
  const activeToken =
    linkedChildren.length > 0
      ? (linkedChildren[activeChildIndex]?.token ?? token ?? '')
      : (token ?? '');

  const [data, setData]           = useState<LeaderboardData | null>(null);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]         = useState<string | null>(null);

  const fadeAnim = useRef(new Animated.Value(0)).current;

  const fetchLeaderboard = useCallback(async () => {
    if (!activeStudent?.class || !activeStudent?.section) {
      setError('Class or section information is missing from your profile.');
      setLoading(false);
      setRefreshing(false);
      return;
    }

    try {
      setError(null);
      const res = await apiClient.get('/api/leaderboard/class', {
        headers: { Authorization: `Bearer ${activeToken}` },
        params: {
          class_name: activeStudent.class,
          section:    activeStudent.section,
        },
      });
      setData(res.data.data ?? null);
      Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }).start();
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? 'Failed to load leaderboard.';
      setError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeStudent?.class, activeStudent?.section, activeToken, fadeAnim]);

  useEffect(() => { fetchLeaderboard(); }, [fetchLeaderboard]);

  useFocusEffect(
    useCallback(() => { fetchLeaderboard(); }, [fetchLeaderboard])
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchLeaderboard();
  }, [fetchLeaderboard]);

  // ── Derive display data ───────────────────────────────────────────────────

  const allEntries  = data?.leaderboard ?? [];

  // Top 5 entries only (ranks 1–5)
  const top5 = allEntries.filter((e) => e.rank <= 5);

  // Split top 5 into podium (1–3) and list (4–5)
  const podiumEntries = top5.filter((e) => e.rank <= 3);
  const rank4and5     = top5.filter((e) => e.rank >= 4);

  // The viewing student's entry
  const myEntry = allEntries.find((e) => e.is_current_student);

  // Show the pinned "Your Rank" card only when the student is outside the top 5
  const isInTop5  = myEntry ? myEntry.rank <= 5 : false;
  const showMyCard = myEntry && !isInTop5;

  // ── Loading ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1D4ED8" />
        <Text style={styles.loadingText}>Loading leaderboard…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorEmoji}>⚠️</Text>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={fetchLeaderboard} accessibilityRole="button">
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const hasData = allEntries.length > 0;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F0F9FF" />
      <Animated.ScrollView
        style={[styles.container, { opacity: fadeAnim }]}
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
        {/* ── Header card ── */}
        <View style={styles.headerCard}>
          <Text style={styles.headerTitle}>🏆 Class Leaderboard</Text>
          <Text style={styles.headerSub}>
            {currentMonthLabel()} · Class {activeStudent?.class} {activeStudent?.section}
          </Text>

          {data && (
            <View style={styles.resetBadge}>
              <Text style={styles.resetText}>
                🔄 Resets in {data.days_until_reset} day{data.days_until_reset !== 1 ? 's' : ''}
              </Text>
            </View>
          )}

          {/* Score formula legend */}
          <View style={styles.legend}>
            <Text style={styles.legendItem}>📊 Marks 40</Text>
            <Text style={styles.legendItem}>📝 Tests 20</Text>
            <Text style={styles.legendItem}>🔥 Streak 20</Text>
            <Text style={styles.legendItem}>📚 HW 10</Text>
            <Text style={styles.legendItem}>📅 Attend 10</Text>
          </View>
        </View>

        {!hasData ? (
          <EmptyState />
        ) : (
          <>
            {/* ── Top 3 podium ── */}
            {podiumEntries.length > 0 && (
              <View style={styles.podiumSection}>
                <Text style={styles.sectionLabel}>Top of the class</Text>
                <View style={styles.podiumRow}>
                  {/* Layout: 2nd | 1st | 3rd for the classic podium look */}
                  {podiumEntries.find((e) => e.rank === 2)
                    ? <PodiumCard entry={podiumEntries.find((e) => e.rank === 2)!} podiumHeight={90} />
                    : <View style={{ flex: 1 }} />}

                  {podiumEntries.find((e) => e.rank === 1)
                    ? <PodiumCard entry={podiumEntries.find((e) => e.rank === 1)!} podiumHeight={110} />
                    : <View style={{ flex: 1 }} />}

                  {podiumEntries.find((e) => e.rank === 3)
                    ? <PodiumCard entry={podiumEntries.find((e) => e.rank === 3)!} podiumHeight={80} />
                    : <View style={{ flex: 1 }} />}
                </View>
              </View>
            )}

            {/* ── Rank 4 & 5 ── */}
            {rank4and5.length > 0 && (
              <View style={styles.listSection}>
                {rank4and5.map((entry) => (
                  <RankRow key={entry.student_id} entry={entry} />
                ))}
              </View>
            )}

            {/* ── Separator + "Your Rank" (only when student is rank 6+) ── */}
            {showMyCard && myEntry && (
              <MyRankCard entry={myEntry} />
            )}

            {/* ── Hint text ── */}
            <Text style={styles.hint}>
              {data?.total_students
                ? `${data.total_students} students in this class`
                : ''}
              {' · '}Tap any card for score breakdown
            </Text>
          </>
        )}
      </Animated.ScrollView>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F0F9FF' },
  content: { padding: 16, paddingBottom: 48 },

  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    backgroundColor: '#F0F9FF',
  },
  loadingText: { marginTop: 12, fontSize: 14, color: '#6B7280' },
  errorEmoji:  { fontSize: 40, marginBottom: 12 },
  errorText:   { fontSize: 14, color: '#6B7280', textAlign: 'center', marginBottom: 20, lineHeight: 22 },
  retryBtn:    { backgroundColor: '#1D4ED8', paddingHorizontal: 28, paddingVertical: 12, borderRadius: 10 },
  retryText:   { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },

  headerCard: {
    backgroundColor: '#1D4ED8',
    borderRadius: 16,
    padding: 20,
    marginBottom: 20,
  },
  headerTitle: { fontSize: 20, fontWeight: '900', color: '#FFFFFF', marginBottom: 4 },
  headerSub:   { fontSize: 13, color: '#BFDBFE', marginBottom: 12 },
  resetBadge: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: 'flex-start',
    marginBottom: 12,
  },
  resetText: { fontSize: 12, color: '#FFFFFF', fontWeight: '600' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  legendItem: {
    fontSize: 10,
    color: '#BFDBFE',
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },

  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#9CA3AF',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 12,
    marginLeft: 4,
  },
  podiumSection: { marginBottom: 16 },
  podiumRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 4,
  },
  listSection: { marginBottom: 4 },

  hint: {
    textAlign: 'center',
    fontSize: 11,
    color: '#9CA3AF',
    marginTop: 20,
    marginBottom: 8,
  },
});
