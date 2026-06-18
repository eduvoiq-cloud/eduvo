/**
 * MonthlyRecoveryTestAttemptScreen — Parts D & E
 *
 * Reuses useTestIntegrity and IntegrityWarningModal exported from
 * TestAttemptScreen.tsx (Session 2). No duplication.
 *
 * Flow: integrity_warning → active → submitting → results
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  StatusBar,
} from 'react-native';
import apiClient from '../../api/client';
import {
  useTestIntegrity,
  IntegrityWarningModal,
} from '../main/TestAttemptScreen';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { StudentStackParamList } from '../../navigation/AppNavigator';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Question {
  question: string;
  options: string[];
  explanation?: string;
  reasoning?: string;
  topic?: string;
  difficulty?: string;
}

interface QuestionWithResult extends Question {
  correct_index: number;
  selected_index: number | null;
  is_correct: boolean;
}

interface TopicScore {
  correct: number;
  total: number;
  percentage: number;
}

interface SubmitResult {
  attempt_id: string;
  score: number;
  total_questions: number;
  score_percentage: number;
  topic_scores: Record<string, TopicScore>;
  previous_month_score_percentage: number | null;
  improvement_percentage: number | null;
  questions: QuestionWithResult[];
}

interface TestData {
  id: string;
  subject: string;
  scheduled_month: string;
  total_questions: number;
  questions: Question[];
}

type Phase = 'loading' | 'integrity_warning' | 'active' | 'submitting' | 'results' | 'error';

interface Props {
  route: { params: { testId: string } };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatMonth(dateStr: string): string {
  const [y, m] = dateStr.split('-');
  const date = new Date(parseInt(y), parseInt(m) - 1, 1);
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

const OPTION_LABELS = ['A', 'B', 'C', 'D'];

// ── Question pill strip ───────────────────────────────────────────────────────

function QuestionPills({
  total,
  current,
  answered,
  onPress,
}: {
  total: number;
  current: number;
  answered: Set<number>;
  onPress: (i: number) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={pillStyles.strip}
      contentContainerStyle={pillStyles.stripContent}
    >
      {Array.from({ length: total }).map((_, i) => {
        const isCurrent = i === current;
        const isDone = answered.has(i);
        return (
          <TouchableOpacity
            key={i}
            style={[
              pillStyles.pill,
              isCurrent && pillStyles.pillCurrent,
              !isCurrent && isDone && pillStyles.pillAnswered,
            ]}
            onPress={() => onPress(i)}
            accessibilityRole="button"
            accessibilityLabel={`Question ${i + 1}${isDone ? ' answered' : ''}`}
          >
            <Text style={[
              pillStyles.pillText,
              isCurrent && pillStyles.pillTextCurrent,
              !isCurrent && isDone && pillStyles.pillTextAnswered,
            ]}>
              {i + 1}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const pillStyles = StyleSheet.create({
  strip: { maxHeight: 48, borderBottomWidth: 1, borderBottomColor: '#F3F4F6', backgroundColor: '#FFFFFF' },
  stripContent: { paddingHorizontal: 14, paddingVertical: 8, gap: 6, flexDirection: 'row' },
  pill: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: '#F3F4F6',
    justifyContent: 'center', alignItems: 'center',
  },
  pillCurrent: { backgroundColor: '#1D4ED8' },
  pillAnswered: { backgroundColor: '#DCFCE7' },
  pillText: { fontSize: 13, fontWeight: '600', color: '#6B7280' },
  pillTextCurrent: { color: '#FFFFFF' },
  pillTextAnswered: { color: '#15803D' },
});

// ── Recovery MCQ Breakdown with reasoning ────────────────────────────────────

function RecoveryMCQBreakdown({ questions }: { questions: QuestionWithResult[] }) {
  const [expandedCorrect, setExpandedCorrect] = useState<Set<number>>(new Set());

  const toggleCorrect = (idx: number) => {
    setExpandedCorrect((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) { next.delete(idx); } else { next.add(idx); }
      return next;
    });
  };

  return (
    <View style={recoveryBreakdownStyles.section}>
      <Text style={recoveryBreakdownStyles.sectionTitle}>Question Review</Text>
      {questions.map((q, idx) => {
        const correct = q.is_correct;
        const skipped = q.selected_index === null;
        const hasReasoning = Boolean(q.reasoning);
        const hasExplanation = Boolean(q.explanation);
        const isExpanded = expandedCorrect.has(idx);
        const selectedLabel = q.selected_index !== null ? OPTION_LABELS[q.selected_index] : null;
        const correctLabel = OPTION_LABELS[q.correct_index];
        const selectedText = q.selected_index !== null ? q.options[q.selected_index] : null;
        const correctText = q.options[q.correct_index];

        return (
          <View
            key={idx}
            style={[
              recoveryBreakdownStyles.qRow,
              correct ? recoveryBreakdownStyles.qRowCorrect : recoveryBreakdownStyles.qRowWrong,
            ]}
          >
            <View style={recoveryBreakdownStyles.qHeader}>
              <Text style={recoveryBreakdownStyles.qNum}>Q{idx + 1}</Text>
              <Text style={correct ? recoveryBreakdownStyles.tick : recoveryBreakdownStyles.cross}>
                {skipped ? '—' : correct ? '✓ Correct' : '✗ Incorrect'}
              </Text>
            </View>
            <Text style={recoveryBreakdownStyles.qText}>{q.question}</Text>

            {!skipped && selectedLabel && (
              <Text style={recoveryBreakdownStyles.yourAnswer}>
                Your answer:{' '}
                <Text style={correct ? recoveryBreakdownStyles.ansCorrect : recoveryBreakdownStyles.ansWrong}>
                  {selectedLabel} — {selectedText}
                </Text>
              </Text>
            )}
            {skipped && <Text style={recoveryBreakdownStyles.yourAnswer}>Not answered</Text>}

            {!correct && (
              <Text style={recoveryBreakdownStyles.correctAnswer}>
                ✓ Correct answer:{' '}
                <Text style={recoveryBreakdownStyles.ansCorrect}>
                  {correctLabel} — {correctText}
                </Text>
              </Text>
            )}

            {/* Incorrect — always expanded reasoning */}
            {!correct && (hasReasoning || hasExplanation) && (
              <View style={recoveryBreakdownStyles.reasoningBox}>
                <Text style={recoveryBreakdownStyles.reasoningTitle}>Understanding this question</Text>
                {hasReasoning && <Text style={recoveryBreakdownStyles.reasoningText}>{q.reasoning}</Text>}
                {hasExplanation && <Text style={recoveryBreakdownStyles.explanationLine}>{q.explanation}</Text>}
              </View>
            )}

            {/* Correct — collapsible reasoning */}
            {correct && hasReasoning && (
              <TouchableOpacity
                style={recoveryBreakdownStyles.whyToggle}
                onPress={() => toggleCorrect(idx)}
                accessibilityRole="button"
                accessibilityLabel={isExpanded ? 'Collapse explanation' : 'Why is this correct?'}
              >
                <Text style={recoveryBreakdownStyles.whyToggleText}>
                  {isExpanded ? '▲ Hide explanation' : '▼ Why is this correct?'}
                </Text>
              </TouchableOpacity>
            )}
            {correct && hasReasoning && isExpanded && (
              <View style={recoveryBreakdownStyles.reasoningBox}>
                <Text style={recoveryBreakdownStyles.reasoningText}>{q.reasoning}</Text>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

const recoveryBreakdownStyles = StyleSheet.create({
  section: { marginBottom: 16 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: '#111827', marginBottom: 10 },
  qRow: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderLeftWidth: 4,
    borderLeftColor: '#E5E7EB',
  },
  qRowCorrect: { borderLeftColor: '#22C55E', backgroundColor: '#F0FDF4' },
  qRowWrong: { borderLeftColor: '#EF4444', backgroundColor: '#FEF2F2' },
  qHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  qNum: { fontSize: 12, fontWeight: '700', color: '#6B7280' },
  tick: { fontSize: 13, color: '#22C55E', fontWeight: '700' },
  cross: { fontSize: 13, color: '#EF4444', fontWeight: '700' },
  qText: { fontSize: 14, color: '#111827', lineHeight: 20, marginBottom: 8 },
  yourAnswer: { fontSize: 13, color: '#6B7280' },
  correctAnswer: { fontSize: 13, color: '#15803D', marginTop: 4, fontWeight: '500' },
  ansCorrect: { color: '#15803D', fontWeight: '600' },
  ansWrong: { color: '#DC2626', fontWeight: '600' },
  reasoningBox: {
    backgroundColor: '#EFF6FF',
    borderRadius: 8,
    padding: 12,
    marginTop: 10,
    borderLeftWidth: 3,
    borderLeftColor: '#3B82F6',
  },
  reasoningTitle: { fontSize: 13, fontWeight: '700', color: '#1E3A8A', marginBottom: 6 },
  reasoningText: { fontSize: 14, color: '#1E3A8A', lineHeight: 21 },
  explanationLine: { fontSize: 13, color: '#3B82F6', marginTop: 6, fontStyle: 'italic' },
  whyToggle: { marginTop: 8, alignSelf: 'flex-start' },
  whyToggleText: { fontSize: 13, fontWeight: '600', color: '#1D4ED8' },
});

// ── Results screen ────────────────────────────────────────────────────────────

function ResultsScreen({
  result,
  testData,
  integrityScore,
  packId,
  onBack,
}: {
  result: SubmitResult;
  testData: TestData;
  integrityScore: number | null;
  packId: string | null;
  onBack: () => void;
}) {
  const navigation = useNavigation<StackNavigationProp<StudentStackParamList>>();
  const { score_percentage, improvement_percentage } = result;

  const integrityColor =
    integrityScore === null ? '#6B7280' :
    integrityScore >= 80 ? '#15803D' :
    integrityScore >= 50 ? '#D97706' : '#DC2626';

  function topicColor(pct: number): string {
    if (pct >= 70) return '#15803D';
    if (pct >= 50) return '#D97706';
    return '#DC2626';
  }

  let improvementNode: React.ReactNode = null;
  if (improvement_percentage !== null && improvement_percentage !== undefined) {
    if (improvement_percentage > 0) {
      improvementNode = (
        <View style={[resultStyles.improvementBanner, { backgroundColor: '#DCFCE7' }]}>
          <Text style={[resultStyles.improvementText, { color: '#15803D' }]}>
            📈 Improved by {improvement_percentage}% from last month!
          </Text>
        </View>
      );
    } else if (improvement_percentage < 0) {
      improvementNode = (
        <View style={[resultStyles.improvementBanner, { backgroundColor: '#FEF3C7' }]}>
          <Text style={[resultStyles.improvementText, { color: '#92400E' }]}>
            📉 {Math.abs(improvement_percentage)}% below last month. Keep practicing!
          </Text>
        </View>
      );
    } else {
      improvementNode = (
        <View style={[resultStyles.improvementBanner, { backgroundColor: '#F3F4F6' }]}>
          <Text style={[resultStyles.improvementText, { color: '#6B7280' }]}>
            Same score as last month. Keep going!
          </Text>
        </View>
      );
    }
  }
  return (
    <ScrollView style={resultStyles.container} contentContainerStyle={resultStyles.content}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      {/* Title */}
      <Text style={resultStyles.heading}>
        {testData.subject} Recovery Test — {formatMonth(testData.scheduled_month)}
      </Text>

      {/* Score card */}
      <View style={resultStyles.scoreCard}>
        <Text style={resultStyles.scoreLabel}>Score</Text>
        <Text style={resultStyles.scoreMain}>
          {result.score} / {result.total_questions} correct
        </Text>
        <Text style={[resultStyles.scorePct, {
          color: score_percentage >= 70 ? '#15803D' : score_percentage >= 50 ? '#D97706' : '#DC2626'
        }]}>
          {score_percentage}%
        </Text>
        {integrityScore !== null && (
          <View style={resultStyles.integrityRow}>
            <Text style={resultStyles.integrityLabel}>Integrity Score: </Text>
            <Text style={[resultStyles.integrityScore, { color: integrityColor }]}>
              {integrityScore}/100
            </Text>
          </View>
        )}
      </View>

      {/* Improvement banner */}
      {improvementNode}

      {/* Topic breakdown */}
      {Object.keys(result.topic_scores).length > 0 && (
        <View style={resultStyles.topicSection}>
          <Text style={resultStyles.topicSectionTitle}>Topic Breakdown</Text>
          <View style={resultStyles.topicTable}>
            <View style={resultStyles.topicHeaderRow}>
              <Text style={[resultStyles.topicHeaderCell, { flex: 2 }]}>Topic</Text>
              <Text style={resultStyles.topicHeaderCell}>Correct</Text>
              <Text style={resultStyles.topicHeaderCell}>Total</Text>
              <Text style={resultStyles.topicHeaderCell}>%</Text>
            </View>
            {Object.entries(result.topic_scores).map(([topic, ts]) => (
              <View key={topic} style={resultStyles.topicRow}>
                <Text style={[resultStyles.topicCell, { flex: 2 }]} numberOfLines={2}>{topic}</Text>
                <Text style={resultStyles.topicCell}>{ts.correct}</Text>
                <Text style={resultStyles.topicCell}>{ts.total}</Text>
                <Text style={[resultStyles.topicCell, { fontWeight: '700', color: topicColor(ts.percentage) }]}>
                  {ts.percentage}%
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* Per-question breakdown with reasoning */}
      {result.questions && result.questions.length > 0 && (
        <RecoveryMCQBreakdown questions={result.questions} />
      )}

      {/* Review pack button */}
      {packId && (
        <TouchableOpacity
          style={resultStyles.reviewBtn}
          onPress={() => navigation.navigate('RecoveryPackDetail', { packId: packId! })}
          accessibilityRole="button"
        >
          <Text style={resultStyles.reviewBtnText}>📖 Review Your Recovery Pack</Text>
        </TouchableOpacity>
      )}

      {/* Back */}
      <TouchableOpacity
        style={resultStyles.backBtn}
        onPress={onBack}
        accessibilityRole="button"
      >
        <Text style={resultStyles.backBtnText}>← Back to Tests</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const resultStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { padding: 20, paddingBottom: 48 },
  heading: { fontSize: 20, fontWeight: '800', color: '#111827', marginBottom: 16, lineHeight: 28 },
  scoreCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 20,
    marginBottom: 12,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 5,
    elevation: 2,
  },
  scoreLabel: { fontSize: 12, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  scoreMain: { fontSize: 16, fontWeight: '700', color: '#374151', marginBottom: 4 },
  scorePct: { fontSize: 36, fontWeight: '800', marginBottom: 10 },
  integrityRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  integrityLabel: { fontSize: 13, color: '#6B7280' },
  integrityScore: { fontSize: 15, fontWeight: '700' },
  improvementBanner: {
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
  },
  improvementText: { fontSize: 14, fontWeight: '700', lineHeight: 20, textAlign: 'center' },
  topicSection: { marginBottom: 16 },
  topicSectionTitle: { fontSize: 15, fontWeight: '700', color: '#111827', marginBottom: 10 },
  topicTable: { backgroundColor: '#FFFFFF', borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: '#E5E7EB' },
  topicHeaderRow: { flexDirection: 'row', backgroundColor: '#F9FAFB', paddingVertical: 8, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  topicHeaderCell: { flex: 1, fontSize: 11, fontWeight: '700', color: '#6B7280', textTransform: 'uppercase', letterSpacing: 0.4 },
  topicRow: { flexDirection: 'row', paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  topicCell: { flex: 1, fontSize: 13, color: '#374151' },
  reviewBtn: {
    backgroundColor: '#EFF6FF',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  reviewBtnText: { fontSize: 14, fontWeight: '700', color: '#1D4ED8' },
  backBtn: { padding: 12, alignItems: 'center' },
  backBtnText: { fontSize: 14, fontWeight: '600', color: '#6B7280' },
});

// ── Main component ────────────────────────────────────────────────────────────

export default function MonthlyRecoveryTestAttemptScreen({ route }: Props) {
  const { testId } = route.params;
  const [phase, setPhase] = useState<Phase>('loading');
  const [testData, setTestData] = useState<TestData | null>(null);
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);
  const [integrityScore, setIntegrityScore] = useState<number | null>(null);
  const [packId, setPackId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const phaseRef = useRef<Phase>('loading');

  const navigation = useNavigation<StackNavigationProp<StudentStackParamList>>();

  // Reuse the integrity hook exported from TestAttemptScreen (Session 2)
  const { startTracking, finaliseTracking } = useTestIntegrity();

  // Keep phaseRef current to avoid stale closures
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // Load test on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await apiClient.get(`/api/student-recovery/tests/${testId}`);
        const td = res.data?.data as TestData;
        setTestData(td);
        setAnswers(new Array(td.questions.length).fill(null));

        // Try to find matching recovery pack for "Review" button
        try {
          const packsRes = await apiClient.get('/api/student-recovery/packs');
          const packs = (packsRes.data?.data ?? []) as Array<{ id: string; subject: string; scheduled_month: string }>;
          const matching = packs.find(
            (p) => p.subject === td.subject && p.scheduled_month === td.scheduled_month
          );
          if (matching) setPackId(matching.id);
        } catch {
          // Non-critical — pack link is optional
        }

        setPhase('integrity_warning');
      } catch (err: unknown) {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to load test');
        setPhase('error');
      }
    })();
  }, [testId]);

  const handleIntegrityConfirm = useCallback(() => {
    startTracking();
    setPhase('active');
  }, [startTracking]);

  const answeredSet = new Set(
    answers.map((a, i) => (a !== null ? i : -1)).filter((i) => i >= 0)
  );

  const handleSelectOption = (optionIndex: number) => {
    setAnswers((prev) => {
      const next = [...prev];
      next[currentIndex] = optionIndex;
      return next;
    });
  };

  const handleSubmit = useCallback(async () => {
    if (!testData) return;

    const unanswered = answers.filter((a) => a === null).length;
    if (unanswered > 0) {
      // Show a brief confirmation
      // (no Alert import needed — we'll let the user proceed; unanswered = 0 treated as wrong)
    }

    setPhase('submitting');
    const integrityData = finaliseTracking();

    try {
      const submitRes = await apiClient.post(`/api/student-recovery/tests/${testId}/submit`, {
        answers,
      });
      const result = submitRes.data?.data as SubmitResult;
      setSubmitResult(result);

      // Post integrity data (fire-and-forget on error)
      try {
        const intRes = await apiClient.post(`/api/student-recovery/tests/${testId}/integrity`, {
          monthly_recovery_attempt_id: result.attempt_id,
          ...integrityData,
        });
        setIntegrityScore((intRes.data?.data as { integrity_score?: number })?.integrity_score ?? null);
      } catch {
        // Integrity post failure should not block results
      }

      setPhase('results');
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to submit test');
      setPhase('error');
    }
  }, [testData, answers, testId, finaliseTracking]);

  // ── Render ────────────────────────────────────────────────────────────────────

  if (phase === 'loading') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1D4ED8" />
      </View>
    );
  }

  if (phase === 'error') {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>⚠️ {errorMsg ?? 'Something went wrong'}</Text>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.backBtnText}>← Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (phase === 'submitting') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1D4ED8" />
        <Text style={styles.submittingText}>Submitting your answers…</Text>
      </View>
    );
  }

  if (phase === 'results' && submitResult && testData) {
    return (
      <ResultsScreen
        result={submitResult}
        testData={testData}
        integrityScore={integrityScore}
        packId={packId}
        onBack={() => navigation.navigate('MonthlyRecoveryTests')}
      />
    );
  }

  if (!testData) return null;

  const question = testData.questions[currentIndex];
  const isLast = currentIndex === testData.questions.length - 1;
  const allAnswered = answers.every((a) => a !== null);

  return (
    <>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />

      {/* Integrity warning — shown before test starts */}
      <IntegrityWarningModal
        visible={phase === 'integrity_warning'}
        onConfirm={handleIntegrityConfirm}
      />

      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerSubject}>{testData.subject}</Text>
          <Text style={styles.headerProgress}>
            {currentIndex + 1} / {testData.questions.length}
          </Text>
        </View>

        {/* Question pills */}
        <QuestionPills
          total={testData.questions.length}
          current={currentIndex}
          answered={answeredSet}
          onPress={setCurrentIndex}
        />

        {/* Question */}
        <ScrollView style={styles.questionArea} contentContainerStyle={styles.questionContent}>
          <Text style={styles.questionText}>
            Q{currentIndex + 1}. {question.question}
          </Text>

          {/* Options */}
          {question.options.map((option, oi) => {
            const selected = answers[currentIndex] === oi;
            return (
              <TouchableOpacity
                key={oi}
                style={[styles.optionBtn, selected && styles.optionBtnSelected]}
                onPress={() => handleSelectOption(oi)}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel={`Option ${OPTION_LABELS[oi]}: ${option}`}
                accessibilityState={{ selected }}
              >
                <View style={[styles.optionBadge, selected && styles.optionBadgeSelected]}>
                  <Text style={[styles.optionBadgeText, selected && styles.optionBadgeTextSelected]}>
                    {OPTION_LABELS[oi]}
                  </Text>
                </View>
                <Text style={[styles.optionText, selected && styles.optionTextSelected]}>
                  {option}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* Navigation + Submit */}
        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.navBtn, currentIndex === 0 && styles.navBtnDisabled]}
            onPress={() => setCurrentIndex((i) => Math.max(0, i - 1))}
            disabled={currentIndex === 0}
          >
            <Text style={[styles.navBtnText, currentIndex === 0 && styles.navBtnTextDisabled]}>← Prev</Text>
          </TouchableOpacity>

          {isLast ? (
            <TouchableOpacity
              style={[styles.submitBtn, !allAnswered && styles.submitBtnPartial]}
              onPress={handleSubmit}
              accessibilityRole="button"
            >
              <Text style={styles.submitBtnText}>
                {allAnswered ? 'Submit Test' : `Submit (${answeredSet.size}/${testData.questions.length})`}
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.navBtn}
              onPress={() => setCurrentIndex((i) => Math.min(testData.questions.length - 1, i + 1))}
            >
              <Text style={styles.navBtnText}>Next →</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F9FAFB', padding: 24 },

  header: {
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  headerSubject: { fontSize: 15, fontWeight: '700', color: '#111827' },
  headerProgress: { fontSize: 13, fontWeight: '600', color: '#6B7280' },

  questionArea: { flex: 1 },
  questionContent: { padding: 20, paddingBottom: 8 },
  questionText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
    lineHeight: 24,
    marginBottom: 20,
  },

  optionBtn: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#E5E7EB',
    padding: 14,
    marginBottom: 10,
  },
  optionBtnSelected: {
    borderColor: '#1D4ED8',
    backgroundColor: '#EFF6FF',
  },
  optionBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#F3F4F6',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
    flexShrink: 0,
  },
  optionBadgeSelected: { backgroundColor: '#1D4ED8' },
  optionBadgeText: { fontSize: 13, fontWeight: '700', color: '#6B7280' },
  optionBadgeTextSelected: { color: '#FFFFFF' },
  optionText: { flex: 1, fontSize: 14, color: '#374151', lineHeight: 22 },
  optionTextSelected: { color: '#1D4ED8', fontWeight: '600' },

  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    gap: 10,
  },
  navBtn: {
    flex: 1,
    backgroundColor: '#F3F4F6',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  navBtnDisabled: { opacity: 0.4 },
  navBtnText: { fontSize: 14, fontWeight: '600', color: '#374151' },
  navBtnTextDisabled: { color: '#9CA3AF' },
  submitBtn: {
    flex: 2,
    backgroundColor: '#1D4ED8',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  submitBtnPartial: { backgroundColor: '#3B82F6' },
  submitBtnText: { fontSize: 14, fontWeight: '700', color: '#FFFFFF' },

  errorText: { fontSize: 15, color: '#DC2626', textAlign: 'center', marginBottom: 14 },
  submittingText: { fontSize: 14, color: '#6B7280', marginTop: 12 },
  backBtn: { marginTop: 8, padding: 10 },
  backBtnText: { fontSize: 14, fontWeight: '600', color: '#1D4ED8' },
});
