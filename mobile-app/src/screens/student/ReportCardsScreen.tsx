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
  ScrollView,
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
  board?: string | null;
}

// ── Grading helpers ───────────────────────────────────────────────────────────

function cbseGrade(pct: number): { letter: string; gp: number } {
  if (pct >= 91) return { letter: 'A1', gp: 10 };
  if (pct >= 81) return { letter: 'A2', gp: 9 };
  if (pct >= 71) return { letter: 'B1', gp: 8 };
  if (pct >= 61) return { letter: 'B2', gp: 7 };
  if (pct >= 51) return { letter: 'C1', gp: 6 };
  if (pct >= 41) return { letter: 'C2', gp: 5 };
  if (pct >= 33) return { letter: 'D',  gp: 4 };
  return { letter: 'E', gp: 0 };
}

function gsebGrade(pct: number): string {
  if (pct >= 80) return 'AA';
  if (pct >= 70) return 'A';
  if (pct >= 60) return 'B';
  if (pct >= 50) return 'C';
  if (pct >= 35) return 'D';
  return 'E';
}

function genericGrade(pct: number): string {
  if (pct >= 90) return 'A+';
  if (pct >= 75) return 'A';
  if (pct >= 60) return 'B';
  if (pct >= 45) return 'C';
  if (pct >= 33) return 'D';
  return 'F';
}

function getSubjectGrade(pct: number, board: string): string {
  const b = board.toUpperCase();
  if (b === 'CBSE' || b === 'ICSE') return cbseGrade(pct).letter;
  if (b === 'GSEB') return gsebGrade(pct);
  return genericGrade(pct);
}

function getPassMark(board: string): number {
  const b = board.toUpperCase();
  if (b === 'GSEB') return 35;
  return 33; // CBSE and generic
}

function gradeColorForPct(pct: number, board: string): string {
  const pass = getPassMark(board);
  if (pct >= 75) return '#15803D';
  if (pct >= 50) return '#B45309';
  if (pct >= pass) return '#C2410C';
  return '#DC2626';
}

function boardAccentColor(board: string): string {
  const b = board.toUpperCase();
  if (b === 'CBSE' || b === 'ICSE') return '#1A56DB';
  if (b === 'GSEB') return '#047857';
  return '#4F46E5';
}

// ── Format helpers ────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = iso && !iso.endsWith('Z') && !iso.includes('+') && !/\d{2}:\d{2}$/.test(iso)
    ? new Date(iso + 'Z')
    : new Date(iso);
  return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });
}

function humanExamType(et: string): string {
  return et.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function humanTerm(t: string): string {
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Grade chip ────────────────────────────────────────────────────────────────

function GradeChip({ grade, pct, board }: { grade: string; pct: number; board: string }) {
  const pass = getPassMark(board);
  const bg   = pct >= 75 ? '#D1FAE5' : pct >= 50 ? '#FEF3C7' : pct >= pass ? '#FED7AA' : '#FEE2E2';
  const fg   = pct >= 75 ? '#065F46' : pct >= 50 ? '#92400E' : pct >= pass ? '#9A3412' : '#991B1B';
  return (
    <View style={[chipStyles.chip, { backgroundColor: bg }]}>
      <Text style={[chipStyles.text, { color: fg }]}>{grade}</Text>
    </View>
  );
}

const chipStyles = StyleSheet.create({
  chip: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' },
  text: { fontSize: 12, fontWeight: '700' },
});

// ── Subject row ───────────────────────────────────────────────────────────────

function SubjectRow({ entry, board, showGP }: { entry: MarkEntry; board: string; showGP: boolean }) {
  const pct   = entry.percentage;
  const grade = getSubjectGrade(pct, board);
  const color = gradeColorForPct(pct, board);
  const pass  = pct >= getPassMark(board);

  return (
    <View style={rowStyles.row} accessibilityRole="text">
      <Text style={rowStyles.subject} numberOfLines={1}>{entry.subject}</Text>
      <Text style={rowStyles.score}>{entry.score}/{entry.max_score}</Text>
      <Text style={[rowStyles.pct, { color }]}>{pct.toFixed(1)}%</Text>
      <View style={rowStyles.gradeCell}>
        <GradeChip grade={grade} pct={pct} board={board} />
      </View>
      {board.toUpperCase() === 'CBSE' && showGP && (
        <Text style={[rowStyles.gp, { color }]}>{cbseGrade(pct).gp}</Text>
      )}
      {board.toUpperCase() === 'GSEB' && (
        <Text style={[rowStyles.result, { color: pass ? '#065F46' : '#DC2626' }]}>
          {pass ? 'P' : 'F'}
        </Text>
      )}
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
    gap: 6,
  },
  subject: { flex: 1, fontSize: 12.5, color: '#374151', fontWeight: '500' },
  score:   { width: 68, fontSize: 12, color: '#6B7280', textAlign: 'right' },
  pct:     { width: 46, fontSize: 12, fontWeight: '700', textAlign: 'right' },
  gradeCell: { width: 36, alignItems: 'center' },
  gp:      { width: 26, fontSize: 11, fontWeight: '600', textAlign: 'center', color: '#6B7280' },
  result:  { width: 20, fontSize: 12, fontWeight: '800', textAlign: 'center' },
});

// ── CBSE grading legend ───────────────────────────────────────────────────────

function CbseLegend() {
  const items = [
    { grade: 'A1', gp: 10, range: '91–100' },
    { grade: 'A2', gp: 9,  range: '81–90' },
    { grade: 'B1', gp: 8,  range: '71–80' },
    { grade: 'B2', gp: 7,  range: '61–70' },
    { grade: 'C1', gp: 6,  range: '51–60' },
    { grade: 'C2', gp: 5,  range: '41–50' },
    { grade: 'D',  gp: 4,  range: '33–40' },
    { grade: 'E',  gp: 0,  range: '<33' },
  ];
  return (
    <View style={legendStyles.wrap}>
      <Text style={legendStyles.title}>CBSE GRADING SCALE</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={legendStyles.row}>
          {items.map((item) => {
            const bg = item.gp >= 8 ? '#D1FAE5' : item.gp >= 6 ? '#DBEAFE' : item.gp >= 4 ? '#FEF3C7' : '#FEE2E2';
            const fg = item.gp >= 8 ? '#065F46' : item.gp >= 6 ? '#1E3A8A' : item.gp >= 4 ? '#92400E' : '#991B1B';
            return (
              <View key={item.grade} style={[legendStyles.cell, { backgroundColor: bg }]}>
                <Text style={[legendStyles.cellGrade, { color: fg }]}>{item.grade}</Text>
                <Text style={legendStyles.cellGP}>GP: {item.gp}</Text>
                <Text style={legendStyles.cellRange}>{item.range}%</Text>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

// ── GSEB grading legend ───────────────────────────────────────────────────────

function GsebLegend() {
  const items = [
    { grade: 'AA', label: 'Distinction', range: '80–100' },
    { grade: 'A',  label: 'First Class', range: '70–79' },
    { grade: 'B',  label: 'Second Class',range: '60–69' },
    { grade: 'C',  label: 'Pass Class',  range: '50–59' },
    { grade: 'D',  label: 'Pass',        range: '35–49' },
    { grade: 'E',  label: 'FAIL',        range: '<35' },
  ];
  const colors = ['#D1FAE5','#A7F3D0','#DBEAFE','#FEF3C7','#FED7AA','#FEE2E2'];
  const fgs    = ['#065F46','#065F46','#1E3A8A','#92400E','#9A3412','#991B1B'];
  return (
    <View style={legendStyles.wrap}>
      <Text style={legendStyles.title}>GSEB GRADING SCALE</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={legendStyles.row}>
          {items.map((item, i) => (
            <View key={item.grade} style={[legendStyles.cell, { backgroundColor: colors[i] }]}>
              <Text style={[legendStyles.cellGrade, { color: fgs[i] }]}>{item.grade}</Text>
              <Text style={legendStyles.cellGP}>{item.label}</Text>
              <Text style={legendStyles.cellRange}>{item.range}%</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const legendStyles = StyleSheet.create({
  wrap:      { marginTop: 12, marginBottom: 4 },
  title:     { fontSize: 10, fontWeight: '700', color: '#6B7280', letterSpacing: 0.5, marginBottom: 6, textTransform: 'uppercase' },
  row:       { flexDirection: 'row', gap: 4 },
  cell:      { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, minWidth: 62, alignItems: 'center' },
  cellGrade: { fontSize: 13, fontWeight: '800' },
  cellGP:    { fontSize: 9, color: '#374151', marginTop: 1 },
  cellRange: { fontSize: 8, color: '#9CA3AF', marginTop: 1 },
});

// ── Table column headers ──────────────────────────────────────────────────────

function TableHeader({ board }: { board: string }) {
  const b = board.toUpperCase();
  const accent = boardAccentColor(board);
  return (
    <View style={[thStyles.row, { borderBottomColor: accent }]}>
      <Text style={[thStyles.col, { flex: 1, color: accent }]}>SUBJECT</Text>
      <Text style={[thStyles.col, { width: 68, textAlign: 'right', color: accent }]}>MARKS</Text>
      <Text style={[thStyles.col, { width: 46, textAlign: 'right', color: accent }]}>%</Text>
      <Text style={[thStyles.col, { width: 36, textAlign: 'center', color: accent }]}>GRADE</Text>
      {b === 'CBSE' && <Text style={[thStyles.col, { width: 26, textAlign: 'center', color: accent }]}>GP</Text>}
      {b === 'GSEB' && <Text style={[thStyles.col, { width: 20, textAlign: 'center', color: accent }]}>RES</Text>}
    </View>
  );
}

const thStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 2, paddingBottom: 6, marginBottom: 2, gap: 6 },
  col: { fontSize: 10, fontWeight: '700', letterSpacing: 0.4 },
});

// ── Report card card ──────────────────────────────────────────────────────────

function ReportCardItem({ card }: { card: ReportCard }) {
  const [expanded, setExpanded] = useState(false);
  const board   = card.board ?? 'GENERIC';
  const accent  = boardAccentColor(board);
  const b       = board.toUpperCase();
  const pass    = getPassMark(board);

  // Board-specific overall grade display
  const overallGrade = getSubjectGrade(card.percentage, board);
  const gradeColor   = gradeColorForPct(card.percentage, board);

  // For CBSE: also show grade point
  const cbseGP = (b === 'CBSE' || b === 'ICSE') ? cbseGrade(card.percentage).gp : null;
  const isPass = card.percentage >= pass;

  return (
    <View style={[cardStyles.card, { borderColor: accent + '40' }]}>
      {/* Board stripe */}
      <View style={[cardStyles.boardStripe, { backgroundColor: accent }]}>
        <Text style={cardStyles.boardText}>{b !== 'GENERIC' ? b : 'REPORT CARD'}</Text>
        <Text style={cardStyles.sessionText}>{card.session_year}</Text>
      </View>

      {/* Header */}
      <TouchableOpacity
        style={cardStyles.header}
        onPress={() => setExpanded((v) => !v)}
        activeOpacity={0.75}
        accessibilityRole="button"
        accessibilityLabel={`${humanTerm(card.term)} ${humanExamType(card.exam_type)} report card`}
      >
        <View style={cardStyles.headerLeft}>
          <Text style={cardStyles.termText}>
            {humanTerm(card.term)} · {humanExamType(card.exam_type)}
          </Text>
          <Text style={cardStyles.classText}>
            Class {card.class_name}-{card.section}
          </Text>
          <Text style={cardStyles.dateText}>Generated {formatDate(card.generated_at)}</Text>
        </View>
        <View style={cardStyles.headerRight}>
          {/* Grade badge */}
          <GradeChip grade={overallGrade} pct={card.percentage} board={board} />
          {cbseGP !== null && (
            <Text style={[cardStyles.gpText, { color: gradeColor }]}>GP {cbseGP}/10</Text>
          )}
          <Text style={[cardStyles.pctText, { color: gradeColor }]}>
            {card.percentage.toFixed(1)}%
          </Text>
          {/* Pass/Fail pill */}
          <View style={[cardStyles.resultPill, { backgroundColor: isPass ? '#D1FAE5' : '#FEE2E2' }]}>
            <Text style={[cardStyles.resultText, { color: isPass ? '#065F46' : '#991B1B' }]}>
              {isPass ? '✓ PASS' : '✗ FAIL'}
            </Text>
          </View>
          <Text style={cardStyles.chevron}>{expanded ? '▲' : '▼'}</Text>
        </View>
      </TouchableOpacity>

      {/* Progress bar when collapsed */}
      {!expanded && (
        <View style={cardStyles.progressWrap}>
          <View style={cardStyles.progressTrack}>
            <View
              style={[
                cardStyles.progressFill,
                {
                  width: `${Math.min(card.percentage, 100)}%` as `${number}%`,
                  backgroundColor: gradeColor,
                },
              ]}
            />
          </View>
          <Text style={[cardStyles.progressLabel, { color: gradeColor }]}>
            {card.grand_total}/{card.grand_max}
          </Text>
        </View>
      )}

      {/* Expanded subject table */}
      {expanded && (
        <View style={cardStyles.tableWrap}>
          <TableHeader board={board} />

          {card.marks.length === 0 ? (
            <Text style={cardStyles.emptyMarks}>No marks recorded.</Text>
          ) : (
            card.marks.map((entry, i) => (
              <SubjectRow key={i} entry={entry} board={board} showGP={b === 'CBSE'} />
            ))
          )}

          {/* Totals row */}
          <View style={[cardStyles.totalsRow, { borderTopColor: accent }]}>
            <Text style={cardStyles.totalsLabel}>Grand Total</Text>
            <Text style={cardStyles.totalsScore}>
              {card.grand_total}/{card.grand_max}
            </Text>
            <Text style={[cardStyles.totalsPct, { color: gradeColor }]}>
              {card.percentage.toFixed(1)}%
            </Text>
            <View style={{ width: 36, alignItems: 'center' }}>
              <GradeChip grade={overallGrade} pct={card.percentage} board={board} />
            </View>
          </View>

          {/* Board-specific grading legend */}
          {(b === 'CBSE' || b === 'ICSE') && <CbseLegend />}

          {/* Signature reminder */}
          <View style={cardStyles.sigNote}>
            <Text style={cardStyles.sigNoteText}>
              📄 Download the PDF from your school portal to get the signed copy
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
    marginBottom: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 6,
    elevation: 3,
  },
  boardStripe: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 5,
  },
  boardText:   { color: '#FFFFFF', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  sessionText: { color: 'rgba(255,255,255,0.8)', fontSize: 10, fontWeight: '500' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: 14,
  },
  headerLeft:  { flex: 1, marginRight: 10 },
  headerRight: { alignItems: 'flex-end', gap: 5 },
  termText:    { fontSize: 15, fontWeight: '700', color: '#111827', marginBottom: 2 },
  classText:   { fontSize: 12, color: '#6B7280', marginBottom: 2 },
  dateText:    { fontSize: 11, color: '#9CA3AF' },
  gpText:      { fontSize: 11, fontWeight: '600' },
  pctText:     { fontSize: 13, fontWeight: '700' },
  resultPill:  { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  resultText:  { fontSize: 10, fontWeight: '800' },
  chevron:     { fontSize: 10, color: '#9CA3AF', marginTop: 2 },
  progressWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 12,
    gap: 8,
  },
  progressTrack: {
    flex: 1,
    height: 6,
    backgroundColor: '#E5E7EB',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill:  { height: '100%', borderRadius: 3 },
  progressLabel: { fontSize: 11, fontWeight: '600', minWidth: 50, textAlign: 'right' },
  tableWrap:     { paddingHorizontal: 14, paddingBottom: 14 },
  emptyMarks:    { fontSize: 12, color: '#9CA3AF', paddingVertical: 12, textAlign: 'center' },
  totalsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 10,
    borderTopWidth: 1.5,
    marginTop: 4,
    gap: 6,
  },
  totalsLabel: { flex: 1, fontSize: 12.5, fontWeight: '700', color: '#111827' },
  totalsScore: { width: 68, fontSize: 12.5, fontWeight: '700', color: '#374151', textAlign: 'right' },
  totalsPct:   { width: 46, fontSize: 12.5, fontWeight: '700', textAlign: 'right' },
  sigNote:     { marginTop: 14, padding: 10, backgroundColor: '#F9FAFB', borderRadius: 8 },
  sigNoteText: { fontSize: 11, color: '#6B7280', textAlign: 'center' },
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
            <Text style={styles.title}>My Report Cards</Text>
            <Text style={styles.subtitle}>
              Tap any card to see subject-wise marks with your board's grading
            </Text>
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
  container:  { flex: 1, backgroundColor: '#F9FAFB' },
  content:    { padding: 20, paddingBottom: 48 },
  centered:   { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F9FAFB' },
  listHeader: { marginBottom: 20 },
  title:      { fontSize: 22, fontWeight: '700', color: '#111827', marginBottom: 4 },
  subtitle:   { fontSize: 13, color: '#6B7280' },
  emptyState: { alignItems: 'center', marginTop: 60 },
  emptyIcon:  { fontSize: 48, marginBottom: 12 },
  emptyText:  { fontSize: 15, color: '#9CA3AF', textAlign: 'center', fontWeight: '600' },
  emptyHint:  { fontSize: 13, color: '#9CA3AF', textAlign: 'center', marginTop: 6, paddingHorizontal: 30 },
  retryBtn: {
    marginTop: 16,
    backgroundColor: '#1D4ED8',
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  retryText: { color: '#FFFFFF', fontWeight: '600', fontSize: 14 },
});
