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
import apiClient from '../../api/client';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MarkEntry {
  subject: string;
  score: number;
  max_score: number;
  percentage: number;
}

interface ReportCard {
  id: string;
  class_name: string;
  section: string;
  term: string;
  exam_type: string;
  marks: MarkEntry[];
  grand_total: number;
  grand_max: number;
  percentage: number;
  grade: string;
  session_year: string;
  generated_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = iso && !iso.endsWith('Z') && !iso.includes('+') && !/\d{2}:\d{2}$/.test(iso)
    ? new Date(iso + 'Z')
    : new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function gradeColor(grade: string): string {
  switch (grade) {
    case 'A+': return '#16A34A';
    case 'A':  return '#22C55E';
    case 'B':  return '#3B82F6';
    case 'C':  return '#F59E0B';
    case 'D':  return '#F97316';
    default:   return '#EF4444'; // F
  }
}

function pctColor(pct: number): string {
  if (pct >= 75) return '#22C55E';
  if (pct >= 50) return '#F59E0B';
  return '#EF4444';
}

function humanExamType(et: string): string {
  return et.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function humanTerm(t: string): string {
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Subject row ───────────────────────────────────────────────────────────────

function SubjectRow({ entry }: { entry: MarkEntry }) {
  const color = pctColor(entry.percentage);
  return (
    <View style={rowStyles.row} accessibilityRole="text">
      <Text style={rowStyles.subject} numberOfLines={1}>{entry.subject}</Text>
      <Text style={rowStyles.score}>
        {entry.score}/{entry.max_score}
      </Text>
      <Text style={[rowStyles.pct, { color }]}>{entry.percentage.toFixed(1)}%</Text>
    </View>
  );
}

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  subject: { flex: 1, fontSize: 13, color: '#374151', fontWeight: '500' },
  score:   { width: 72, fontSize: 13, color: '#6B7280', textAlign: 'right' },
  pct:     { width: 56, fontSize: 13, fontWeight: '700', textAlign: 'right' },
});

// ── Report card card ──────────────────────────────────────────────────────────

function ReportCardItem({ card }: { card: ReportCard }) {
  const [expanded, setExpanded] = useState(false);
  const gColor = gradeColor(card.grade);
  const pColor = pctColor(card.percentage);

  return (
    <View style={cardStyles.card}>
      {/* Header */}
      <TouchableOpacity
        style={cardStyles.header}
        onPress={() => setExpanded((v) => !v)}
        activeOpacity={0.75}
        accessibilityRole="button"
        accessibilityLabel={`${humanTerm(card.term)} ${humanExamType(card.exam_type)} report card. Tap to ${expanded ? 'collapse' : 'expand'}`}
      >
        <View style={cardStyles.headerLeft}>
          <Text style={cardStyles.termText}>
            {humanTerm(card.term)} · {humanExamType(card.exam_type)}
          </Text>
          <Text style={cardStyles.classText}>
            Class {card.class_name}-{card.section} · {card.session_year}
          </Text>
          <Text style={cardStyles.dateText}>Generated {formatDate(card.generated_at)}</Text>
        </View>
        <View style={cardStyles.headerRight}>
          <View style={[cardStyles.gradeBadge, { backgroundColor: `${gColor}22` }]}>
            <Text style={[cardStyles.gradeText, { color: gColor }]}>{card.grade}</Text>
          </View>
          <Text style={[cardStyles.pctText, { color: pColor }]}>
            {card.percentage.toFixed(1)}%
          </Text>
          <Text style={cardStyles.chevron}>{expanded ? '▲' : '▼'}</Text>
        </View>
      </TouchableOpacity>

      {/* Summary bar */}
      {!expanded && (
        <View style={cardStyles.summaryBar}>
          <View style={cardStyles.summaryTrack}>
            <View
              style={[
                cardStyles.summaryFill,
                { width: `${Math.min(card.percentage, 100)}%` as `${number}%`, backgroundColor: pColor },
              ]}
            />
          </View>
        </View>
      )}

      {/* Expanded subject table */}
      {expanded && (
        <View style={cardStyles.tableWrap}>
          <View style={cardStyles.tableHeader}>
            <Text style={[cardStyles.colHead, { flex: 1 }]}>Subject</Text>
            <Text style={[cardStyles.colHead, { width: 72, textAlign: 'right' }]}>Score</Text>
            <Text style={[cardStyles.colHead, { width: 56, textAlign: 'right' }]}>%</Text>
          </View>

          {card.marks.length === 0 ? (
            <Text style={cardStyles.emptyMarks}>No marks recorded.</Text>
          ) : (
            card.marks.map((entry, i) => (
              <SubjectRow key={i} entry={entry} />
            ))
          )}

          {/* Totals row */}
          <View style={cardStyles.totalsRow}>
            <Text style={cardStyles.totalsLabel}>Grand Total</Text>
            <Text style={cardStyles.totalsScore}>
              {card.grand_total}/{card.grand_max}
            </Text>
            <Text style={[cardStyles.totalsPct, { color: pColor }]}>
              {card.percentage.toFixed(1)}%
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#E5E7EB',
    marginBottom: 14,
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
  },
  headerLeft: { flex: 1, marginRight: 12 },
  headerRight: { alignItems: 'flex-end', gap: 4 },
  termText: { fontSize: 16, fontWeight: '700', color: '#111827', marginBottom: 2 },
  classText: { fontSize: 12, color: '#6B7280', marginBottom: 2 },
  dateText: { fontSize: 11, color: '#9CA3AF' },
  gradeBadge: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginBottom: 4,
  },
  gradeText: { fontSize: 18, fontWeight: '800' },
  pctText: { fontSize: 13, fontWeight: '600' },
  chevron: { fontSize: 11, color: '#9CA3AF', marginTop: 4 },
  summaryBar: {
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  summaryTrack: {
    height: 6,
    backgroundColor: '#E5E7EB',
    borderRadius: 3,
    overflow: 'hidden',
  },
  summaryFill: { height: '100%', borderRadius: 3 },
  tableWrap: { paddingHorizontal: 16, paddingBottom: 14 },
  tableHeader: {
    flexDirection: 'row',
    borderBottomWidth: 2,
    borderBottomColor: '#1D4ED8',
    paddingBottom: 6,
    marginBottom: 2,
  },
  colHead: { fontSize: 11, fontWeight: '700', color: '#1D4ED8', textTransform: 'uppercase', letterSpacing: 0.5 },
  emptyMarks: { fontSize: 13, color: '#9CA3AF', paddingVertical: 12, textAlign: 'center' },
  totalsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 10,
    borderTopWidth: 1.5,
    borderTopColor: '#E5E7EB',
    marginTop: 4,
  },
  totalsLabel: { flex: 1, fontSize: 13, fontWeight: '700', color: '#111827' },
  totalsScore: { width: 72, fontSize: 13, fontWeight: '700', color: '#374151', textAlign: 'right' },
  totalsPct:   { width: 56, fontSize: 13, fontWeight: '700', textAlign: 'right' },
});

// ── Main screen ───────────────────────────────────────────────────────────────

export default function ReportCardsScreen() {
  const [cards, setCards] = useState<ReportCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCards = useCallback(async () => {
    setError(null);
    try {
      const res = await apiClient.get('/api/report-cards/my');
      const raw = res.data?.data;
      setCards(Array.isArray(raw) ? raw : []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load report cards';
      setError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchCards(); }, [fetchCards]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchCards();
  }, [fetchCards]);

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
      <FlatList
        style={styles.container}
        contentContainerStyle={styles.content}
        data={cards}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1D4ED8" />
        }
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <Text style={styles.title}>📄 My Report Cards</Text>
            <Text style={styles.subtitle}>Tap any card to see subject-wise marks</Text>
          </View>
        }
        renderItem={({ item }) => <ReportCardItem card={item} />}
        ListEmptyComponent={
          error ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>⚠️</Text>
              <Text style={styles.emptyText}>{error}</Text>
              <TouchableOpacity
                style={styles.retryBtn}
                onPress={() => { setLoading(true); fetchCards(); }}
                accessibilityRole="button"
              >
                <Text style={styles.retryText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>📄</Text>
              <Text style={styles.emptyText}>No report cards yet.</Text>
              <Text style={styles.emptyHint}>
                Your class teacher will generate report cards after exams.
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
  listHeader: { marginBottom: 20 },
  title: { fontSize: 22, fontWeight: '700', color: '#111827', marginBottom: 4 },
  subtitle: { fontSize: 13, color: '#6B7280' },
  emptyState: { alignItems: 'center', marginTop: 60 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyText: { fontSize: 15, color: '#9CA3AF', textAlign: 'center', fontWeight: '600' },
  emptyHint: { fontSize: 13, color: '#9CA3AF', textAlign: 'center', marginTop: 6, paddingHorizontal: 30 },
  retryBtn: {
    marginTop: 16,
    backgroundColor: '#1D4ED8',
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  retryText: { color: '#FFFFFF', fontWeight: '600', fontSize: 14 },
});
