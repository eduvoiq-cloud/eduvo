/**
 * DailyTestAttemptScreen
 *
 * Takes a DailyTestMeta (passed via navigation param).
 * Phases:
 *   'pre'        → instructions + Start button
 *   'active'     → question-by-question MCQ
 *   'submitting' → spinner while grading
 *   'results'    → score + per-question explanations
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  StatusBar,
  Alert,
  Modal,
} from 'react-native';
import apiClient from '../../api/client';
import type { DailyTestMeta } from './DailyTestScreen';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Question {
  question_text: string;
  options: string[];
  difficulty?: string;
  marks: number;
}

interface QuestionResult {
  question_text: string;
  options: string[];
  selected_index: number | null;
  correct_index: number;
  is_correct: boolean;
  explanation: string;
  difficulty: string;
  show_hint: boolean;
}

interface SubmitResult {
  attempt_id: string;
  score: number;
  total_questions: number;
  percentage: number;
  question_results: QuestionResult[];
}

type Phase = 'pre' | 'active' | 'submitting' | 'results';

// ── Navigation prop ───────────────────────────────────────────────────────────

interface Props {
  route: { params: { test: DailyTestMeta } };
  navigation: { goBack: () => void };
}

// ── Pill strip ────────────────────────────────────────────────────────────────

function QuestionPills({
  total,
  current,
  answered,
  onJump,
}: {
  total: number;
  current: number;
  answered: Set<number>;
  onJump: (i: number) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={pillStyles.scroll}
      contentContainerStyle={pillStyles.content}
    >
      {Array.from({ length: total }, (_, i) => (
        <TouchableOpacity
          key={i}
          onPress={() => onJump(i)}
          style={[
            pillStyles.pill,
            answered.has(i) && pillStyles.pillAnswered,
            i === current && pillStyles.pillCurrent,
          ]}
          accessibilityRole="button"
          accessibilityLabel={`Question ${i + 1}${answered.has(i) ? ', answered' : ''}`}
        >
          <Text style={[
            pillStyles.pillText,
            answered.has(i) && pillStyles.pillTextAnswered,
            i === current && pillStyles.pillTextCurrent,
          ]}>
            {i + 1}
          </Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const pillStyles = StyleSheet.create({
  scroll: { maxHeight: 52 },
  content: { paddingHorizontal: 16, paddingVertical: 8, gap: 8, flexDirection: 'row' },
  pill: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#E5E7EB', justifyContent: 'center', alignItems: 'center' },
  pillAnswered: { backgroundColor: '#22C55E' },
  pillCurrent: { backgroundColor: '#1D4ED8', borderWidth: 2, borderColor: '#93C5FD' },
  pillText: { fontSize: 13, fontWeight: '600', color: '#6B7280' },
  pillTextAnswered: { color: '#FFFFFF' },
  pillTextCurrent: { color: '#FFFFFF' },
});

// ── Submit modal ──────────────────────────────────────────────────────────────

function SubmitModal({
  visible,
  answered,
  total,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  answered: number;
  total: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const unanswered = total - answered;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={modalStyles.overlay}>
        <View style={modalStyles.card}>
          <Text style={modalStyles.title}>Submit Test?</Text>
          <Text style={modalStyles.body}>
            <Text style={modalStyles.bold}>{answered}</Text> answered
            {unanswered > 0 && (
              <Text>, <Text style={modalStyles.warn}>{unanswered} unanswered</Text></Text>
            )}.
          </Text>
          {unanswered > 0 && (
            <Text style={modalStyles.hint}>Unanswered questions get 0 marks.</Text>
          )}
          <View style={modalStyles.btnRow}>
            <TouchableOpacity style={[modalStyles.btn, modalStyles.btnCancel]} onPress={onCancel} accessibilityRole="button">
              <Text style={modalStyles.btnCancelText}>Go Back</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[modalStyles.btn, modalStyles.btnConfirm]} onPress={onConfirm} accessibilityRole="button">
              <Text style={modalStyles.btnConfirmText}>Submit</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const modalStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  card: { width: '100%', backgroundColor: '#FFFFFF', borderRadius: 16, padding: 24, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 12, elevation: 8 },
  title: { fontSize: 20, fontWeight: '800', color: '#111827', marginBottom: 12 },
  body: { fontSize: 15, color: '#374151', lineHeight: 22, marginBottom: 8 },
  bold: { fontWeight: '700' },
  warn: { color: '#DC2626', fontWeight: '700' },
  hint: { fontSize: 13, color: '#6B7280', marginBottom: 20, lineHeight: 19 },
  btnRow: { flexDirection: 'row', gap: 12, marginTop: 8 },
  btn: { flex: 1, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  btnCancel: { backgroundColor: '#F3F4F6' },
  btnConfirm: { backgroundColor: '#1D4ED8' },
  btnCancelText: { fontSize: 15, fontWeight: '600', color: '#374151' },
  btnConfirmText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
});

// ── Results screen ────────────────────────────────────────────────────────────

function ResultsScreen({
  test,
  result,
  onBack,
}: {
  test: DailyTestMeta;
  result: SubmitResult;
  onBack: () => void;
}) {
  const pct = result.percentage;
  const scoreColor = pct >= 70 ? '#15803D' : pct >= 40 ? '#D97706' : '#DC2626';
  const scoreBg = pct >= 70 ? '#DCFCE7' : pct >= 40 ? '#FEF3C7' : '#FEE2E2';

  return (
    <ScrollView style={resStyles.container} contentContainerStyle={resStyles.content}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <Text style={resStyles.heading}>Results</Text>
      <Text style={resStyles.subheading}>{test.subject} · {test.topic}</Text>

      {/* Score card */}
      <View style={[resStyles.scoreCard, { backgroundColor: scoreBg, borderColor: scoreColor + '40' }]}>
        <Text style={[resStyles.scoreValue, { color: scoreColor }]}>
          {result.score}<Text style={resStyles.scoreTotal}>/{result.total_questions}</Text>
        </Text>
        <Text style={[resStyles.scoreLabel, { color: scoreColor }]}>{pct}% Correct</Text>
        <Text style={resStyles.scoreMessage}>
          {pct >= 80 ? '🎉 Excellent work!' : pct >= 60 ? '👍 Good job!' : pct >= 40 ? '📚 Keep practicing!' : '💪 Try harder next time!'}
        </Text>
      </View>

      {/* Per-question breakdown */}
      <Text style={resStyles.sectionTitle}>Question Breakdown</Text>
      {result.question_results.map((qr, idx) => (
        <View
          key={idx}
          style={[resStyles.qCard, qr.is_correct ? resStyles.qCardCorrect : resStyles.qCardWrong]}
        >
          <View style={resStyles.qHeader}>
            <Text style={resStyles.qNum}>Q{idx + 1}</Text>
            <Text style={qr.is_correct ? resStyles.tick : resStyles.cross}>
              {qr.selected_index === null ? '—' : qr.is_correct ? '✓' : '✗'}
            </Text>
          </View>
          <Text style={resStyles.qText}>{qr.question_text}</Text>

          {/* Show all options */}
          {qr.options.map((opt, oi) => (
            <View
              key={oi}
              style={[
                resStyles.optRow,
                oi === qr.correct_index && resStyles.optCorrect,
                qr.selected_index === oi && oi !== qr.correct_index && resStyles.optWrong,
              ]}
            >
              <Text style={resStyles.optLabel}>{String.fromCharCode(65 + oi)}.</Text>
              <Text style={resStyles.optText}>{opt}</Text>
              {oi === qr.correct_index && (
                <Text style={resStyles.optCorrectMark}>✓</Text>
              )}
              {qr.selected_index === oi && oi !== qr.correct_index && (
                <Text style={resStyles.optWrongMark}>✗</Text>
              )}
            </View>
          ))}

          {!qr.is_correct && qr.explanation && qr.show_hint ? (
            <Text style={resStyles.explanation}>💡 {qr.explanation}</Text>
          ) : null}
        </View>
      ))}

      <TouchableOpacity
        style={resStyles.backBtn}
        onPress={onBack}
        accessibilityRole="button"
      >
        <Text style={resStyles.backBtnText}>← Back to Daily Tests</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const resStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { padding: 20, paddingBottom: 48 },
  heading: { fontSize: 26, fontWeight: '800', color: '#111827', marginBottom: 2 },
  subheading: { fontSize: 14, color: '#6B7280', marginBottom: 20 },
  scoreCard: {
    borderRadius: 16, borderWidth: 1, padding: 24, alignItems: 'center', marginBottom: 28,
  },
  scoreValue: { fontSize: 56, fontWeight: '800', lineHeight: 64 },
  scoreTotal: { fontSize: 28, fontWeight: '500' },
  scoreLabel: { fontSize: 20, fontWeight: '700', marginTop: 4 },
  scoreMessage: { fontSize: 15, color: '#374151', marginTop: 8, fontWeight: '500' },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#374151', marginBottom: 12 },
  qCard: {
    backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14, marginBottom: 12, borderLeftWidth: 4,
  },
  qCardCorrect: { borderLeftColor: '#22C55E', backgroundColor: '#F0FDF4' },
  qCardWrong: { borderLeftColor: '#EF4444', backgroundColor: '#FEF2F2' },
  qHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  qNum: { fontSize: 12, fontWeight: '700', color: '#6B7280' },
  tick: { fontSize: 18, color: '#22C55E', fontWeight: '700' },
  cross: { fontSize: 18, color: '#EF4444', fontWeight: '700' },
  qText: { fontSize: 14, color: '#111827', lineHeight: 20, marginBottom: 10, fontWeight: '500' },
  optRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5, paddingHorizontal: 8, borderRadius: 8, marginBottom: 4, backgroundColor: '#F9FAFB' },
  optCorrect: { backgroundColor: '#DCFCE7' },
  optWrong: { backgroundColor: '#FEE2E2' },
  optLabel: { fontSize: 12, fontWeight: '700', color: '#9CA3AF', width: 16 },
  optText: { fontSize: 13, color: '#374151', flex: 1, lineHeight: 18 },
  optCorrectMark: { fontSize: 13, color: '#15803D', fontWeight: '700' },
  optWrongMark: { fontSize: 13, color: '#DC2626', fontWeight: '700' },
  explanation: { fontSize: 12, color: '#6B7280', fontStyle: 'italic', marginTop: 8, borderTopWidth: 1, borderTopColor: '#E5E7EB', paddingTop: 8 },
  backBtn: { backgroundColor: '#1D4ED8', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  backBtnText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
});

// ── Main component ────────────────────────────────────────────────────────────

export default function DailyTestAttemptScreen({ route, navigation }: Props) {
  const { test } = route.params;
  const questions: Question[] = test.questions;

  const [phase, setPhase] = useState<Phase>(
    test.attempt_status === 'completed' ? 'results' : 'pre'
  );
  const [currentIndex, setCurrentIndex] = useState(0);
  // Map question_index → selected option index (0–3)
  const [answers, setAnswers] = useState<Map<number, number>>(new Map());
  const [showModal, setShowModal] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);

  // For completed tests, build a fake result to show from stored data
  const alreadyCompleted = test.attempt_status === 'completed';

  const answersRef = useRef(answers);
  answersRef.current = answers;

  // ── Derived ─────────────────────────────────────────────────────────────────
  const answeredSet = new Set(answers.keys());
  const currentQ = questions[currentIndex];
  const isLast = currentIndex === questions.length - 1;

  // ── Handlers ─────────────────────────────────────────────────────────────────

  function selectOption(optionIndex: number) {
    setAnswers((prev) => {
      const next = new Map(prev);
      next.set(currentIndex, optionIndex);
      return next;
    });
  }

  const handleSubmit = useCallback(async () => {
    setShowModal(false);
    setPhase('submitting');
    setSubmitError(null);

    const currentAnswers = answersRef.current;
    const answersPayload = questions.map((_, qi) => ({
      question_index: qi,
      selected_index: currentAnswers.has(qi) ? currentAnswers.get(qi)! : -1,
    })).filter((a) => a.selected_index >= 0);

    try {
      const res = await apiClient.post(`/api/daily-tests/${test.id}/attempt`, {
        answers: answersPayload,
      });
      const data = res.data?.data as SubmitResult;
      setResult(data);
      setPhase('results');
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? (err instanceof Error ? err.message : 'Submission failed. Please retry.');

      // Already submitted — show results with score from test meta
      if (msg.includes('already submitted') || msg.includes('409')) {
        setResult({
          attempt_id: '',
          score: test.attempt_score ?? 0,
          total_questions: questions.length,
          percentage: questions.length > 0
            ? Math.round(((test.attempt_score ?? 0) / questions.length) * 100)
            : 0,
          question_results: [],
        });
        setPhase('results');
        return;
      }

      setSubmitError(msg);
      setPhase('active');
    }
  }, [questions, test.id, test.attempt_score]);

  // ── Pre screen ──────────────────────────────────────────────────────────────

  if (phase === 'pre') {
    return (
      <ScrollView style={preStyles.container} contentContainerStyle={preStyles.content}>
        <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
        <View style={preStyles.iconWrap}>
          <Text style={preStyles.icon}>📝</Text>
        </View>
        <Text style={preStyles.subject}>{test.subject}</Text>
        <Text style={preStyles.topic}>{test.topic}</Text>

        <View style={preStyles.detailCard}>
          <View style={preStyles.detailRow}>
            <Text style={preStyles.detailLabel}>Questions</Text>
            <Text style={preStyles.detailValue}>{questions.length}</Text>
          </View>
          <View style={preStyles.divider} />
          <View style={preStyles.detailRow}>
            <Text style={preStyles.detailLabel}>Total Marks</Text>
            <Text style={preStyles.detailValue}>{questions.reduce((s, q) => s + (q.marks ?? 1), 0)}</Text>
          </View>
          <View style={preStyles.divider} />
          <View style={preStyles.detailRow}>
            <Text style={preStyles.detailLabel}>Date</Text>
            <Text style={preStyles.detailValue}>{test.test_date}</Text>
          </View>
        </View>

        <View style={preStyles.infoCard}>
          <Text style={preStyles.infoTitle}>Instructions</Text>
          {[
            'All questions are multiple choice (MCQ).',
            'Tap an option to select it. You can change before submitting.',
            'Use the number pills at the top to jump between questions.',
            'After submitting, see your score and explanations instantly.',
          ].map((line, i) => (
            <View key={i} style={preStyles.instrRow}>
              <Text style={preStyles.instrBullet}>•</Text>
              <Text style={preStyles.instrText}>{line}</Text>
            </View>
          ))}
        </View>

        <TouchableOpacity
          style={preStyles.startBtn}
          onPress={() => setPhase('active')}
          accessibilityRole="button"
        >
          <Text style={preStyles.startBtnText}>Start Test →</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // ── Submitting ──────────────────────────────────────────────────────────────

  if (phase === 'submitting') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1D4ED8" />
        <Text style={styles.submittingText}>Submitting your test…</Text>
      </View>
    );
  }

  // ── Results ─────────────────────────────────────────────────────────────────

  if (phase === 'results') {
    // If already completed before starting attempt
    if (alreadyCompleted && !result) {
      const fallbackResult: SubmitResult = {
        attempt_id: '',
        score: test.attempt_score ?? 0,
        total_questions: questions.length,
        percentage: questions.length > 0
          ? Math.round(((test.attempt_score ?? 0) / questions.length) * 100)
          : 0,
        question_results: [],
      };
      return <ResultsScreen test={test} result={fallbackResult} onBack={() => navigation.goBack()} />;
    }
    if (result) {
      return <ResultsScreen test={test} result={result} onBack={() => navigation.goBack()} />;
    }
  }

  // ── Active test ─────────────────────────────────────────────────────────────

  const selectedOption = answers.get(currentIndex);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#1D4ED8" />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Text style={styles.headerSubject} numberOfLines={1}>{test.subject}</Text>
          <Text style={styles.headerProgress}>{currentIndex + 1}/{questions.length}</Text>
        </View>
        <Text style={styles.headerTopic} numberOfLines={1}>{test.topic}</Text>
      </View>

      {/* Pills */}
      <View style={styles.pillsWrapper}>
        <QuestionPills
          total={questions.length}
          current={currentIndex}
          answered={answeredSet}
          onJump={setCurrentIndex}
        />
      </View>

      {/* Error banner */}
      {submitError && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>⚠️ {submitError}</Text>
          <TouchableOpacity onPress={() => handleSubmit()} accessibilityRole="button">
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Question */}
      <ScrollView
        style={styles.questionScroll}
        contentContainerStyle={styles.questionContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.qContainer}>
          <Text style={styles.qDifficulty}>
            {currentQ.difficulty ? currentQ.difficulty.toUpperCase() : 'MCQ'} · {currentQ.marks} mark{currentQ.marks !== 1 ? 's' : ''}
          </Text>
          <Text style={styles.qText}>{currentQ.question_text}</Text>

          {currentQ.options.map((opt, oi) => {
            const selected = selectedOption === oi;
            return (
              <TouchableOpacity
                key={oi}
                style={[styles.optBtn, selected && styles.optBtnSelected]}
                onPress={() => selectOption(oi)}
                activeOpacity={0.75}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                accessibilityLabel={`Option ${String.fromCharCode(65 + oi)}: ${opt}`}
              >
                <View style={[styles.optBadge, selected && styles.optBadgeSelected]}>
                  <Text style={[styles.optBadgeText, selected && styles.optBadgeTextSelected]}>
                    {String.fromCharCode(65 + oi)}
                  </Text>
                </View>
                <Text style={[styles.optText, selected && styles.optTextSelected]}>{opt}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>

      {/* Footer */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.navBtn, currentIndex === 0 && styles.navBtnDisabled]}
          onPress={() => setCurrentIndex((i) => Math.max(0, i - 1))}
          disabled={currentIndex === 0}
          accessibilityRole="button"
        >
          <Text style={[styles.navBtnText, currentIndex === 0 && styles.navBtnTextDisabled]}>← Prev</Text>
        </TouchableOpacity>

        {isLast ? (
          <TouchableOpacity
            style={styles.submitBtn}
            onPress={() => setShowModal(true)}
            accessibilityRole="button"
          >
            <Text style={styles.submitBtnText}>Submit Test</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={styles.navBtn}
            onPress={() => setCurrentIndex((i) => Math.min(questions.length - 1, i + 1))}
            accessibilityRole="button"
          >
            <Text style={styles.navBtnText}>Next →</Text>
          </TouchableOpacity>
        )}
      </View>

      <SubmitModal
        visible={showModal}
        answered={answers.size}
        total={questions.length}
        onConfirm={() => handleSubmit()}
        onCancel={() => setShowModal(false)}
      />
    </View>
  );
}

// ── Pre styles ────────────────────────────────────────────────────────────────

const preStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { padding: 24, paddingBottom: 48, alignItems: 'center' },
  iconWrap: { width: 88, height: 88, borderRadius: 44, backgroundColor: '#DBEAFE', justifyContent: 'center', alignItems: 'center', marginBottom: 16 },
  icon: { fontSize: 40 },
  subject: { fontSize: 13, fontWeight: '700', color: '#1D4ED8', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 },
  topic: { fontSize: 22, fontWeight: '800', color: '#111827', textAlign: 'center', marginBottom: 24, lineHeight: 30 },
  detailCard: { width: '100%', backgroundColor: '#FFFFFF', borderRadius: 14, padding: 16, marginBottom: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  detailLabel: { fontSize: 14, color: '#6B7280', fontWeight: '500' },
  detailValue: { fontSize: 14, color: '#111827', fontWeight: '700' },
  divider: { height: 1, backgroundColor: '#F3F4F6', marginVertical: 2 },
  infoCard: { width: '100%', backgroundColor: '#FFFFFF', borderRadius: 14, padding: 16, marginBottom: 28, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  infoTitle: { fontSize: 15, fontWeight: '700', color: '#374151', marginBottom: 12 },
  instrRow: { flexDirection: 'row', marginBottom: 8 },
  instrBullet: { fontSize: 14, color: '#1D4ED8', marginRight: 8, lineHeight: 20 },
  instrText: { fontSize: 13, color: '#4B5563', flex: 1, lineHeight: 20 },
  startBtn: { width: '100%', backgroundColor: '#1D4ED8', borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  startBtnText: { fontSize: 17, fontWeight: '700', color: '#FFFFFF' },
});

// ── Active test styles ────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F9FAFB' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F9FAFB', gap: 16 },
  submittingText: { fontSize: 16, color: '#6B7280', fontWeight: '500' },

  header: { backgroundColor: '#1D4ED8', paddingTop: 16, paddingBottom: 12, paddingHorizontal: 16 },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  headerSubject: { fontSize: 16, fontWeight: '700', color: '#FFFFFF', flex: 1, marginRight: 12 },
  headerProgress: { fontSize: 13, color: 'rgba(255,255,255,0.8)', fontWeight: '600' },
  headerTopic: { fontSize: 13, color: 'rgba(255,255,255,0.75)' },

  pillsWrapper: { backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },

  errorBanner: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#FEE2E2', paddingHorizontal: 16, paddingVertical: 10 },
  errorText: { fontSize: 13, color: '#DC2626', flex: 1 },
  retryText: { fontSize: 13, fontWeight: '700', color: '#DC2626', marginLeft: 12 },

  questionScroll: { flex: 1 },
  questionContent: { flexGrow: 1, paddingBottom: 16 },

  qContainer: { flex: 1, padding: 20 },
  qDifficulty: { fontSize: 11, fontWeight: '700', color: '#6B7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  qText: { fontSize: 18, fontWeight: '600', color: '#111827', lineHeight: 28, marginBottom: 24 },

  optBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 12, borderWidth: 2, borderColor: '#E5E7EB', padding: 14, marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 3, elevation: 1 },
  optBtnSelected: { borderColor: '#1D4ED8', backgroundColor: '#EFF6FF' },
  optBadge: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#F3F4F6', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  optBadgeSelected: { backgroundColor: '#1D4ED8' },
  optBadgeText: { fontSize: 13, fontWeight: '700', color: '#6B7280' },
  optBadgeTextSelected: { color: '#FFFFFF' },
  optText: { fontSize: 15, color: '#374151', flex: 1, lineHeight: 22 },
  optTextSelected: { color: '#1E3A8A', fontWeight: '600' },

  footer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: '#FFFFFF', borderTopWidth: 1, borderTopColor: '#F3F4F6', gap: 12 },
  navBtn: { flex: 1, backgroundColor: '#F3F4F6', borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  navBtnDisabled: { opacity: 0.4 },
  navBtnText: { fontSize: 15, fontWeight: '600', color: '#374151' },
  navBtnTextDisabled: { color: '#9CA3AF' },
  submitBtn: { flex: 1, backgroundColor: '#1D4ED8', borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  submitBtnText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
});
