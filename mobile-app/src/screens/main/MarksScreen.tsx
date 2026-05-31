import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  StatusBar,
  ScrollView,
} from 'react-native';
import apiClient from '../../api/client';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MarkRecord {
  id: string;
  subject: string;
  score: number;
  max_score: number;
  term: string;
  exam_type: string;
  notes?: string | null;
  created_at: string;
}

type TermFilter = 'All' | 'term_1' | 'term_2' | 'term_3';

interface SubjectSummary {
  subject: string;
  latestScore: number;
  latestMaxScore: number;
  average: number;
  previousScore: number | null;
  trend: 'up' | 'down' | 'flat';
  records: MarkRecord[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(score: number, max: number): number {
  if (max === 0) return 0;
  return Math.round((score / max) * 100);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function buildSubjectSummaries(marks: MarkRecord[]): SubjectSummary[] {
  const map = new Map<string, MarkRecord[]>();
  for (const m of marks) {
    if (!map.has(m.subject)) map.set(m.subject, []);
    map.get(m.subject)!.push(m);
  }

  const summaries: SubjectSummary[] = [];
  map.forEach((records, subject) => {
    const sorted = [...records].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    const latest = sorted[0];
    const latestPct = pct(latest.score, latest.max_score);
    const previous = sorted[1] ?? null;
    const previousPct = previous ? pct(previous.score, previous.max_score) : null;
    let trend: SubjectSummary['trend'] = 'flat';
    if (previousPct !== null) {
      if (latestPct > previousPct) trend = 'up';
      else if (latestPct < previousPct) trend = 'down';
    }
    const avgPct = Math.round(
      sorted.reduce((sum, m) => sum + pct(m.score, m.max_score), 0) / sorted.length
    );
    summaries.push({
      subject,
      latestScore: latest.score,
      latestMaxScore: latest.max_score,
      average: avgPct,
      previousScore: previousPct,
      trend,
      records: sorted,
    });
  });
  return summaries;
}

// ── Trend arrow ───────────────────────────────────────────────────────────────

function TrendArrow({ trend }: { trend: SubjectSummary['trend'] }) {
  if (trend === 'up') return <Text style={trendStyles.up}>↑</Text>;
  if (trend === 'down') return <Text style={trendStyles.down}>↓</Text>;
  return <Text style={trendStyles.flat}>→</Text>;
}

const trendStyles = StyleSheet.create({
  up: { fontSize: 18, fontWeight: '700', color: '#22C55E' },
  down: { fontSize: 18, fontWeight: '700', color: '#EF4444' },
  flat: { fontSize: 18, fontWeight: '700', color: '#9CA3AF' },
});

// ── Term filter bar ───────────────────────────────────────────────────────────

const TERM_OPTIONS: TermFilter[] = ['All', 'term_1', 'term_2', 'term_3'];
const TERM_LABELS: Record<TermFilter, string> = {
  All: 'All',
  term_1: 'Term 1',
  term_2: 'Term 2',
  term_3: 'Term 3',
};

function TermFilterBar({
  selected,
  onChange,
}: {
  selected: TermFilter;
  onChange: (t: TermFilter) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={filterStyles.scroll}
      contentContainerStyle={filterStyles.content}
    >
      {TERM_OPTIONS.map((t) => (
        <TouchableOpacity
          key={t}
          style={[filterStyles.chip, selected === t && filterStyles.chipActive]}
          onPress={() => onChange(t)}
          accessibilityRole="button"
          accessibilityLabel={`Filter by ${TERM_LABELS[t]}`}
          accessibilityState={{ selected: selected === t }}
        >
          <Text style={[filterStyles.chipText, selected === t && filterStyles.chipTextActive]}>
            {TERM_LABELS[t]}
          </Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const filterStyles = StyleSheet.create({
  scroll: { maxHeight: 48 },
  content: { paddingHorizontal: 20, paddingVertical: 8, gap: 8, flexDirection: 'row' },
  chip: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#F3F4F6',
  },
  chipActive: { backgroundColor: '#DBEAFE' },
  chipText: { fontSize: 13, fontWeight: '500', color: '#6B7280' },
  chipTextActive: { color: '#1D4ED8', fontWeight: '600' },
});

// ── Subject card ──────────────────────────────────────────────────────────────

function SubjectCard({
  summary,
  isBest,
  isWorst,
  isExpanded,
  onPress,
}: {
  summary: SubjectSummary;
  isBest: boolean;
  isWorst: boolean;
  isExpanded: boolean;
  onPress: () => void;
}) {
  const latestPct = pct(summary.latestScore, summary.latestMaxScore);
  const scoreColor = latestPct >= 75 ? '#22C55E' : latestPct >= 50 ? '#F59E0B' : '#EF4444';

  let borderColor = '#E5E7EB';
  let headerBg = '#FFFFFF';
  let labelEl: React.ReactNode = null;

  if (isBest) {
    borderColor = '#F59E0B';
    headerBg = '#FFFBEB';
    labelEl = (
      <View style={cardStyles.labelBadge}>
        <Text style={cardStyles.labelBestText}>🏆 Best Subject</Text>
      </View>
    );
  } else if (isWorst) {
    borderColor = '#EF4444';
    headerBg = '#FEF2F2';
    labelEl = (
      <View style={[cardStyles.labelBadge, cardStyles.labelBadgeRed]}>
        <Text style={cardStyles.labelWorstText}>⚠️ Needs Improvement</Text>
      </View>
    );
  }

  return (
    <TouchableOpacity
      style={[cardStyles.card, { borderColor }]}
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={`${summary.subject} subject card. Tap to ${isExpanded ? 'collapse' : 'expand'}`}
    >
      <View style={[cardStyles.header, { backgroundColor: headerBg }]}>
        <View style={cardStyles.headerLeft}>
          <Text style={cardStyles.subjectName}>{summary.subject}</Text>
          {labelEl}
        </View>
        <View style={cardStyles.headerRight}>
          <TrendArrow trend={summary.trend} />
          <Text style={[cardStyles.latestScore, { color: scoreColor }]}>
            {summary.latestScore}/{summary.latestMaxScore}
          </Text>
          <Text style={[cardStyles.latestPct, { color: scoreColor }]}>{latestPct}%</Text>
        </View>
      </View>

      <View style={cardStyles.statsRow}>
        <View style={cardStyles.stat}>
          <Text style={cardStyles.statLabel}>Latest</Text>
          <Text style={[cardStyles.statValue, { color: scoreColor }]}>{latestPct}%</Text>
        </View>
        <View style={cardStyles.statDivider} />
        <View style={cardStyles.stat}>
          <Text style={cardStyles.statLabel}>Average</Text>
          <Text style={cardStyles.statValue}>{summary.average}%</Text>
        </View>
        <View style={cardStyles.statDivider} />
        <View style={cardStyles.stat}>
          <Text style={cardStyles.statLabel}>Tests</Text>
          <Text style={cardStyles.statValue}>{summary.records.length}</Text>
        </View>
        <View style={cardStyles.statDivider} />
        <View style={cardStyles.stat}>
          <Text style={cardStyles.statLabel}>Trend</Text>
          <TrendArrow trend={summary.trend} />
        </View>
      </View>

      <View style={cardStyles.expandRow}>
        <Text style={cardStyles.expandText}>
          {isExpanded ? 'Hide tests ▲' : 'Show all tests ▼'}
        </Text>
      </View>

      {isExpanded && (
        <View style={cardStyles.testList}>
          {summary.records.map((rec) => {
            const p = pct(rec.score, rec.max_score);
            const c = p >= 75 ? '#22C55E' : p >= 50 ? '#F59E0B' : '#EF4444';
            return (
              <View key={rec.id} style={cardStyles.testRow}>
                <View style={cardStyles.testLeft}>
                  <Text style={cardStyles.testName} numberOfLines={1}>
                    {rec.exam_type.charAt(0).toUpperCase() + rec.exam_type.slice(1)}
                  </Text>
                  <Text style={cardStyles.testMeta}>
                    {rec.term.replace('_', ' ')} · {formatDate(rec.created_at)}
                  </Text>
                </View>
                <View style={cardStyles.testRight}>
                  <Text style={[cardStyles.testScore, { color: c }]}>
                    {rec.score}/{rec.max_score}
                  </Text>
                  <Text style={[cardStyles.testPct, { color: c }]}>{p}%</Text>
                </View>
              </View>
            );
          })}
        </View>
      )}
    </TouchableOpacity>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    borderWidth: 1.5,
    marginBottom: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 5,
    elevation: 2,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: 16,
    paddingBottom: 12,
  },
  headerLeft: { flex: 1, marginRight: 12 },
  headerRight: { alignItems: 'flex-end' },
  subjectName: { fontSize: 17, fontWeight: '700', color: '#111827' },
  labelBadge: {
    marginTop: 6,
    alignSelf: 'flex-start',
    backgroundColor: '#FEF3C7',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  labelBadgeRed: { backgroundColor: '#FEE2E2' },
  labelBestText: { fontSize: 11, fontWeight: '600', color: '#92400E' },
  labelWorstText: { fontSize: 11, fontWeight: '600', color: '#B91C1C' },
  latestScore: { fontSize: 18, fontWeight: '700', marginTop: 2 },
  latestPct: { fontSize: 12, fontWeight: '500', marginTop: 1 },
  statsRow: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  stat: { flex: 1, alignItems: 'center' },
  statLabel: { fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: 0.4 },
  statValue: { fontSize: 15, fontWeight: '700', color: '#111827', marginTop: 2 },
  statDivider: { width: 1, backgroundColor: '#F3F4F6', marginVertical: 2 },
  expandRow: {
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    paddingVertical: 8,
    alignItems: 'center',
  },
  expandText: { fontSize: 12, color: '#1D4ED8', fontWeight: '500' },
  testList: {
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  testRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F9FAFB',
  },
  testLeft: { flex: 1, marginRight: 12 },
  testName: { fontSize: 14, fontWeight: '600', color: '#374151' },
  testMeta: { fontSize: 12, color: '#9CA3AF', marginTop: 2, textTransform: 'capitalize' },
  testRight: { alignItems: 'flex-end' },
  testScore: { fontSize: 15, fontWeight: '700' },
  testPct: { fontSize: 11, fontWeight: '500', marginTop: 1 },
});

// ── Main component ────────────────────────────────────────────────────────────

export default function MarksScreen() {
  const [marks, setMarks] = useState<MarkRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [termFilter, setTermFilter] = useState<TermFilter>('All');
  const [expandedSubject, setExpandedSubject] = useState<string | null>(null);

  const fetchMarks = useCallback(async () => {
    setError(null);
    try {
      const response = await apiClient.get('/api/marks');
      setMarks(response.data.data ?? []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load marks';
      setError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchMarks(); }, [fetchMarks]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchMarks();
  }, [fetchMarks]);

  const filteredMarks = useMemo(() => {
    if (termFilter === 'All') return marks;
    return marks.filter((m) => m.term === termFilter);
  }, [marks, termFilter]);

  const summaries = useMemo(() => buildSubjectSummaries(filteredMarks), [filteredMarks]);
  const sortedSummaries = useMemo(
    () => [...summaries].sort((a, b) => b.average - a.average),
    [summaries]
  );

  const bestSubject = sortedSummaries.length > 0 ? sortedSummaries[0].subject : null;
  const worstSubject = useMemo(() => {
    if (sortedSummaries.length < 2) return null;
    const worst = sortedSummaries[sortedSummaries.length - 1];
    return worst.average < 60 ? worst.subject : null;
  }, [sortedSummaries]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1D4ED8" />
      </View>
    );
  }

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <View style={styles.filterWrapper}>
        <TermFilterBar selected={termFilter} onChange={setTermFilter} />
      </View>
      <FlatList
        style={styles.container}
        contentContainerStyle={styles.content}
        data={sortedSummaries}
        keyExtractor={(item) => item.subject}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1D4ED8" />
        }
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <Text style={styles.title}>My Performance</Text>
            {sortedSummaries.length > 0 && (
              <>
                {bestSubject && (
                  <Text style={styles.bestText}>🏆 Best: {bestSubject}</Text>
                )}
                {worstSubject && (
                  <Text style={styles.worstText}>⚠️ Needs improvement: {worstSubject}</Text>
                )}
              </>
            )}
          </View>
        }
        renderItem={({ item }) => (
          <SubjectCard
            summary={item}
            isBest={item.subject === bestSubject}
            isWorst={item.subject === worstSubject}
            isExpanded={expandedSubject === item.subject}
            onPress={() => setExpandedSubject((p) => (p === item.subject ? null : item.subject))}
          />
        )}
        ListEmptyComponent={
          error ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>⚠️ {error}</Text>
              <TouchableOpacity
                style={styles.retryButton}
                onPress={() => { setLoading(true); fetchMarks(); }}
                accessibilityRole="button"
              >
                <Text style={styles.retryText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>📊</Text>
              <Text style={styles.emptyText}>
                {termFilter === 'All' ? 'No marks recorded yet.' : `No marks for ${TERM_LABELS[termFilter]}.`}
              </Text>
            </View>
          )
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { padding: 20, paddingBottom: 48 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F9FAFB' },
  filterWrapper: { backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  listHeader: { marginBottom: 16 },
  title: { fontSize: 22, fontWeight: '700', color: '#111827', marginBottom: 6 },
  bestText: { fontSize: 13, color: '#92400E', fontWeight: '600', marginBottom: 2 },
  worstText: { fontSize: 13, color: '#B91C1C', fontWeight: '600' },
  emptyState: { alignItems: 'center', marginTop: 60 },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyText: { fontSize: 15, color: '#9CA3AF', textAlign: 'center' },
  retryButton: {
    marginTop: 16,
    backgroundColor: '#1D4ED8',
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  retryText: { color: '#FFFFFF', fontWeight: '600', fontSize: 14 },
});
