/**
 * DailyTestAttemptScreen
 *
 * Full-featured daily test attempt screen matching the behaviour of the normal
 * TestAttemptScreen:
 *
 *  - Server-side timer: started_at is stored on the backend.  Remaining time is
 *    always  time_limit_minutes * 60 – elapsed_since(started_at).  The timer
 *    therefore keeps running even when the student leaves the app.
 *
 *  - AppState foreground handler: whenever the app returns from background the
 *    remaining seconds are recomputed from the server timestamp so drift is
 *    impossible.
 *
 *  - AsyncStorage progress: current answers + currentIndex are saved on every
 *    answer change and on app-background.  If the student exits mid-test and
 *    re-opens, the pre-screen shows "Continue Test →" and resumes from where
 *    they left off.
 *
 *  - Auto-submit: when secondsLeft reaches 0 the test is submitted automatically.
 *
 * Phases:
 *   'pre'        → instructions + Start / Continue button
 *   'active'     → question-by-question MCQ
 *   'submitting' → spinner while grading
 *   'results'    → score + per-question explanations
 *   'error'      → could not load results for a completed test
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  AppState,
  AppStateStatus,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
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

/** Saved answers stored in AsyncStorage while the attempt is in progress. */
interface SavedProgress {
  attempt_id: string;
  answers:    Record<number, number>; // question_index → selected_index
  currentIndex: number;
  savedAt:    string;
}

type Phase = 'pre' | 'active' | 'submitting' | 'results' | 'error';

// ── Navigation prop ───────────────────────────────────────────────────────────

interface Props {
  route: { params: { test: DailyTestMeta } };
  navigation: { goBack: () => void };
}

// ── AsyncStorage helpers ──────────────────────────────────────────────────────

const progressKey = (testId: string) => `eduvo_daily_test_progress_${testId}`;

async function saveProgress(
  testId: string,
  attempt_id: string,
  answers: Record<number, number>,
  currentIndex: number,
): Promise<void> {
  const payload: SavedProgress = {
    attempt_id,
    answers,
    currentIndex,
    savedAt: new Date().toISOString(),
  };
  await AsyncStorage.setItem(progressKey(testId), JSON.stringify(payload));
}

async function loadProgress(testId: string): Promise<SavedProgress | null> {
  try {
    const raw = await AsyncStorage.getItem(progressKey(testId));
    return raw ? (JSON.parse(raw) as SavedProgress) : null;
  } catch {
    return null;
  }
}

async function clearProgress(testId: string): Promise<void> {
  await AsyncStorage.removeItem(progressKey(testId));
}

// ── Timer hook ────────────────────────────────────────────────────────────────

function useCountdown(
  onExpire: () => void
): {
  secondsLeft:    number | null;
  setSecondsLeft: React.Dispatch<React.SetStateAction<number | null>>;
} {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    if (secondsLeft === null) return;
    if (secondsLeft <= 0) {
      onExpireRef.current();
      return;
    }
    const id = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev === null) return null;
        if (prev <= 1) return 0;
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [secondsLeft]);

  return { secondsLeft, setSecondsLeft };
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── Pill strip ────────────────────────────────────────────────────────────────

function QuestionPills({
  total,
  current,
  answered,
  onJump,
}: {
  total:    number;
  current:  number;
  answered: Set<number>;
  onJump:   (i: number) => void;
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
            i === current  && pillStyles.pillCurrent,
          ]}
          accessibilityRole="button"
          accessibilityLabel={`Question ${i + 1}${answered.has(i) ? ', answered' : ''}`}
        >
          <Text style={[
            pillStyles.pillText,
            answered.has(i) && pillStyles.pillTextAnswered,
            i === current  && pillStyles.pillTextCurrent,
          ]}>
            {i + 1}
          </Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const pillStyles = StyleSheet.create({
  scroll:  { maxHeight: 52 },
  content: { paddingHorizontal: 16, paddingVertical: 8, gap: 8, flexDirection: 'row' },
  pill: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#E5E7EB', justifyContent: 'center', alignItems: 'center',
  },
  pillAnswered: { backgroundColor: '#22C55E' },
  pillCurrent:  { backgroundColor: '#1D4ED8', borderWidth: 2, borderColor: '#93C5FD' },
  pillText:            { fontSize: 13, fontWeight: '600', color: '#6B7280' },
  pillTextAnswered:    { color: '#FFFFFF' },
  pillTextCurrent:     { color: '#FFFFFF' },
});

// ── Submit modal ──────────────────────────────────────────────────────────────

function SubmitModal({
  visible,
  answered,
  total,
  onConfirm,
  onCancel,
}: {
  visible:   boolean;
  answered:  number;
  total:     number;
  onConfirm: () => void;
  onCancel:  () => void;
}) {
  const unanswered = total - answered;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel} accessibilityViewIsModal>
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
            <TouchableOpacity
              style={[modalStyles.btn, modalStyles.btnCancel]}
              onPress={onCancel}
              accessibilityRole="button"
              accessibilityLabel="Cancel submission"
            >
              <Text style={modalStyles.btnCancelText}>Go Back</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[modalStyles.btn, modalStyles.btnConfirm]}
              onPress={onConfirm}
              accessibilityRole="button"
              accessibilityLabel="Confirm submission"
            >
              <Text style={modalStyles.btnConfirmText}>Submit</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const modalStyles = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center', alignItems: 'center', padding: 24,
  },
  card: {
    width: '100%', backgroundColor: '#FFFFFF', borderRadius: 16, padding: 24,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15, shadowRadius: 12, elevation: 8,
  },
  title: { fontSize: 20, fontWeight: '800', color: '#111827', marginBottom: 12 },
  body:  { fontSize: 15, color: '#374151', lineHeight: 22, marginBottom: 8 },
  bold:  { fontWeight: '700' },
  warn:  { color: '#DC2626', fontWeight: '700' },
  hint:  { fontSize: 13, color: '#6B7280', marginBottom: 20, lineHeight: 19 },
  btnRow:       { flexDirection: 'row', gap: 12, marginTop: 8 },
  btn:          { flex: 1, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  btnCancel:    { backgroundColor: '#F3F4F6' },
  btnConfirm:   { backgroundColor: '#1D4ED8' },
  btnCancelText:  { fontSize: 15, fontWeight: '600', color: '#374151' },
  btnConfirmText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
});

// ── Results screen ────────────────────────────────────────────────────────────

function ResultsScreen({
  test,
  result,
  onBack,
}: {
  test:   DailyTestMeta;
  result: SubmitResult;
  onBack: () => void;
}) {
  const pct = result.percentage;
  const scoreColor = pct >= 70 ? '#15803D' : pct >= 40 ? '#D97706' : '#DC2626';
  const scoreBg    = pct >= 70 ? '#DCFCE7' : pct >= 40 ? '#FEF3C7' : '#FEE2E2';

  return (
    <ScrollView style={resStyles.container} contentContainerStyle={resStyles.content}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <Text style={resStyles.heading}>Results</Text>
      <Text style={resStyles.subheading}>{test.subject} · {test.topic}</Text>

      <View style={[resStyles.scoreCard, { backgroundColor: scoreBg, borderColor: scoreColor + '40' }]}>
        <Text style={[resStyles.scoreValue, { color: scoreColor }]}>
          {result.score}<Text style={resStyles.scoreTotal}>/{result.total_questions}</Text>
        </Text>
        <Text style={[resStyles.scoreLabel, { color: scoreColor }]}>{pct}% Correct</Text>
        <Text style={resStyles.scoreMessage}>
          {pct >= 80 ? '🎉 Excellent work!' : pct >= 60 ? '👍 Good job!' : pct >= 40 ? '📚 Keep practicing!' : '💪 Try harder next time!'}
        </Text>
      </View>

      {result.question_results.length > 0 && (
        <>
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

              {qr.options.map((opt, oi) => (
                <View
                  key={oi}
                  style={[
                    resStyles.optRow,
                    oi === qr.correct_index                            && resStyles.optCorrect,
                    qr.selected_index === oi && oi !== qr.correct_index && resStyles.optWrong,
                  ]}
                >
                  <Text style={resStyles.optLabel}>{String.fromCharCode(65 + oi)}.</Text>
                  <Text style={resStyles.optText}>{opt}</Text>
                  {oi === qr.correct_index && <Text style={resStyles.optCorrectMark}>✓</Text>}
                  {qr.selected_index === oi && oi !== qr.correct_index && (
                    <Text style={resStyles.optWrongMark}>✗</Text>
                  )}
                </View>
              ))}

              {!qr.is_correct && qr.explanation && qr.show_hint && (
                <Text style={resStyles.explanation}>💡 {qr.explanation}</Text>
              )}
            </View>
          ))}
        </>
      )}

      <TouchableOpacity
        style={resStyles.backBtn}
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Back to daily tests"
      >
        <Text style={resStyles.backBtnText}>← Back to Daily Tests</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const resStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content:   { padding: 20, paddingBottom: 48 },
  heading:   { fontSize: 26, fontWeight: '800', color: '#111827', marginBottom: 2 },
  subheading:{ fontSize: 14, color: '#6B7280', marginBottom: 20 },
  scoreCard: {
    borderRadius: 16, borderWidth: 1, padding: 24,
    alignItems: 'center', marginBottom: 28,
  },
  scoreValue:   { fontSize: 56, fontWeight: '800', lineHeight: 64 },
  scoreTotal:   { fontSize: 28, fontWeight: '500' },
  scoreLabel:   { fontSize: 20, fontWeight: '700', marginTop: 4 },
  scoreMessage: { fontSize: 15, color: '#374151', marginTop: 8, fontWeight: '500' },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#374151', marginBottom: 12 },
  qCard:        { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14, marginBottom: 12, borderLeftWidth: 4 },
  qCardCorrect: { borderLeftColor: '#22C55E', backgroundColor: '#F0FDF4' },
  qCardWrong:   { borderLeftColor: '#EF4444', backgroundColor: '#FEF2F2' },
  qHeader:      { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  qNum:         { fontSize: 12, fontWeight: '700', color: '#6B7280' },
  tick:         { fontSize: 18, color: '#22C55E', fontWeight: '700' },
  cross:        { fontSize: 18, color: '#EF4444', fontWeight: '700' },
  qText:        { fontSize: 14, color: '#111827', lineHeight: 20, marginBottom: 10, fontWeight: '500' },
  optRow:       { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5, paddingHorizontal: 8, borderRadius: 8, marginBottom: 4, backgroundColor: '#F9FAFB' },
  optCorrect:   { backgroundColor: '#DCFCE7' },
  optWrong:     { backgroundColor: '#FEE2E2' },
  optLabel:     { fontSize: 12, fontWeight: '700', color: '#9CA3AF', width: 16 },
  optText:      { fontSize: 13, color: '#374151', flex: 1, lineHeight: 18 },
  optCorrectMark: { fontSize: 13, color: '#15803D', fontWeight: '700' },
  optWrongMark:   { fontSize: 13, color: '#DC2626', fontWeight: '700' },
  explanation:  { fontSize: 12, color: '#6B7280', fontStyle: 'italic', marginTop: 8, borderTopWidth: 1, borderTopColor: '#E5E7EB', paddingTop: 8 },
  backBtn:      { backgroundColor: '#1D4ED8', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  backBtnText:  { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
});

// ── Main component ────────────────────────────────────────────────────────────

export default function DailyTestAttemptScreen({ route, navigation }: Props) {
  const { test } = route.params;

  // ── Phase & core state ───────────────────────────────────────────────────────
  const [phase, setPhase]               = useState<Phase>(
    test.attempt_status === 'completed' ? 'results' : 'pre'
  );
  const [loadingResults, setLoadingResults] = useState(
    test.attempt_status === 'completed'
  );
  const [starting, setStarting]         = useState(false);
  const [questions, setQuestions]       = useState<Question[]>(
    // Pre-populate from nav param so we have question count on pre-screen
    test.questions as Question[]
  );
  const [answers, setAnswers]           = useState<Record<number, number>>({});
  const [attemptId, setAttemptId]       = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showModal, setShowModal]       = useState(false);
  const [submitError, setSubmitError]   = useState<string | null>(null);
  const [result, setResult]             = useState<SubmitResult | null>(null);
  const [hasResumable, setHasResumable] = useState(false);

  // ── Stable refs (avoid stale closures in AppState / timer handlers) ──────────
  const answersRef      = useRef<Record<number, number>>({});
  const attemptIdRef    = useRef<string | null>(null);
  const currentIndexRef = useRef(0);
  const phaseRef        = useRef<Phase>('pre');
  const startedAtRef    = useRef<string | null>(null);
  const timeLimitSecRef = useRef<number | null>(null);

  useEffect(() => { answersRef.current      = answers;      }, [answers]);
  useEffect(() => { attemptIdRef.current    = attemptId;    }, [attemptId]);
  useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);
  useEffect(() => { phaseRef.current        = phase;        }, [phase]);

  // ── Timer ────────────────────────────────────────────────────────────────────
  const hasTimeLimit = (test.time_limit_minutes ?? 0) > 0;

  // submitRef lets the countdown fire handleSubmit without a circular dep
  const submitRef = useRef<(auto?: boolean) => Promise<void>>(async () => {/* placeholder */});

  const { secondsLeft, setSecondsLeft } = useCountdown(() => {
    if (phaseRef.current === 'active') {
      submitRef.current(true);
    }
  });

  const timerWarning  = secondsLeft !== null && secondsLeft <= 60;
  const timerCritical = secondsLeft !== null && secondsLeft <= 30;

  // ── AppState: correct timer on foreground; save progress on background ───────
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'background' || state === 'inactive') {
        // Save current answers to AsyncStorage when leaving the app
        const aid = attemptIdRef.current;
        if (aid && phaseRef.current === 'active') {
          saveProgress(test.id, aid, answersRef.current, currentIndexRef.current)
            .catch(() => {/* silent */});

          // Best-effort: persist current answers to the server too
          apiClient
            .patch(`/api/daily-tests/${test.id}/attempt/save`, {
              answers: Object.entries(answersRef.current).map(([qi, si]) => ({
                question_index:  parseInt(qi, 10),
                selected_index:  si,
              })),
            })
            .catch(() => {/* silent */});
        }
      } else if (state === 'active') {
        // App returned to foreground — recompute remaining time from server timestamp
        if (
          phaseRef.current === 'active' &&
          startedAtRef.current &&
          timeLimitSecRef.current !== null
        ) {
          const elapsed   = Math.floor((Date.now() - new Date(startedAtRef.current).getTime()) / 1000);
          const remaining = Math.max(0, timeLimitSecRef.current - elapsed);
          setSecondsLeft(remaining);
        }
      }
    });
    return () => sub.remove();
  }, [test.id, setSecondsLeft]);

  // ── On mount: if already completed load results; else check for local resume ─
  useEffect(() => {
    const init = async () => {
      if (test.attempt_status === 'completed') {
        // Build fallback result from test meta scores — no extra network call needed
        setResult({
          attempt_id:       '',
          score:            test.attempt_score ?? 0,
          total_questions:  test.questions.length,
          percentage:       test.questions.length > 0
            ? Math.round(((test.attempt_score ?? 0) / test.questions.length) * 100)
            : 0,
          question_results: [],
        });
        setLoadingResults(false);
        setPhase('results');
        return;
      }

      // Check for local in-progress data to show "Continue Test →"
      const saved = await loadProgress(test.id);
      if (saved) setHasResumable(true);
    };

    void init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Start / resume ───────────────────────────────────────────────────────────
  const handleStart = useCallback(async () => {
    setStarting(true);
    try {
      const res = await apiClient.post(`/api/daily-tests/${test.id}/attempt/start`);
      const payload = res.data.data as {
        attempt_id:         string;
        started_at:         string;
        time_limit_minutes: number;
        resumed:            boolean;
        questions:          Question[];
        saved_answers:      Array<{ question_index: number; selected_index: number }>;
      };

      const qs = payload.questions;
      setQuestions(qs);
      setAttemptId(payload.attempt_id);

      // Store server-side started_at for foreground recompute
      startedAtRef.current    = payload.started_at;
      timeLimitSecRef.current = hasTimeLimit ? payload.time_limit_minutes * 60 : null;

      // Restore answers: prefer local AsyncStorage (has currentIndex), fall back to server
      const localSaved = await loadProgress(test.id);

      if (localSaved && localSaved.attempt_id === payload.attempt_id) {
        setAnswers(localSaved.answers);
        setCurrentIndex(localSaved.currentIndex);
      } else if (payload.saved_answers.length > 0) {
        const restored: Record<number, number> = {};
        for (const a of payload.saved_answers) {
          restored[a.question_index] = a.selected_index;
        }
        setAnswers(restored);
      }

      // Start the countdown based on server timestamp
      if (hasTimeLimit) {
        const elapsed   = Math.floor((Date.now() - new Date(payload.started_at).getTime()) / 1000);
        const remaining = Math.max(0, payload.time_limit_minutes * 60 - elapsed);

        if (remaining <= 0) {
          // Time already expired while loading — auto-submit immediately
          Alert.alert('Time Expired', 'Your time limit has expired. The test will be submitted now.');
          setPhase('active'); // need active so submit runs
          await submitRef.current(true);
          return;
        }

        setSecondsLeft(remaining);
      }

      setPhase('active');
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      const msg    = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? (err instanceof Error ? err.message : 'Failed to start test');

      if (status === 410) {
        // Auto-submitted due to time expiry — show results screen with score 0
        setResult({
          attempt_id:       '',
          score:            0,
          total_questions:  test.questions.length,
          percentage:       0,
          question_results: [],
        });
        await clearProgress(test.id);
        setPhase('results');
        return;
      }

      if (status === 409 || msg.toLowerCase().includes('already submitted')) {
        // Already done — show results
        setResult({
          attempt_id:       '',
          score:            test.attempt_score ?? 0,
          total_questions:  test.questions.length,
          percentage:       test.questions.length > 0
            ? Math.round(((test.attempt_score ?? 0) / test.questions.length) * 100)
            : 0,
          question_results: [],
        });
        await clearProgress(test.id);
        setPhase('results');
        return;
      }

      Alert.alert('Could not start test', msg);
    } finally {
      setStarting(false);
    }
  }, [test, hasTimeLimit, setSecondsLeft]);

  // ── Submit ───────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (_autoSubmit = false) => {
    const aid = attemptIdRef.current;
    if (!aid) return;

    setShowModal(false);
    setPhase('submitting');
    setSubmitError(null);

    const currentAnswers = answersRef.current;
    const answersPayload = Object.entries(currentAnswers).map(([qi, si]) => ({
      question_index: parseInt(qi, 10),
      selected_index: si,
    }));

    try {
      const res = await apiClient.post(`/api/daily-tests/${test.id}/attempt`, {
        answers: answersPayload,
      });
      const data = res.data?.data as SubmitResult;
      await clearProgress(test.id);
      setResult(data);
      setPhase('results');
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? (err instanceof Error ? err.message : 'Submission failed. Please retry.');

      if (msg.toLowerCase().includes('already submitted') || msg.includes('409')) {
        await clearProgress(test.id);
        setResult({
          attempt_id:       '',
          score:            test.attempt_score ?? 0,
          total_questions:  questions.length,
          percentage:       questions.length > 0
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
  }, [test, questions]);

  // Keep submitRef in sync
  submitRef.current = handleSubmit;

  // ── Answered count ───────────────────────────────────────────────────────────
  const answeredSet   = new Set(Object.keys(answers).map(Number));
  const answeredCount = answeredSet.size;
  const currentQ      = questions[currentIndex];
  const isLast        = currentIndex === questions.length - 1;

  // ── Render: loading results (completed test) ─────────────────────────────────
  if (loadingResults) {
    return (
      <View style={styles.centered}>
        <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
        <ActivityIndicator size="large" color="#1D4ED8" />
        <Text style={styles.loadingText}>Loading your results…</Text>
      </View>
    );
  }

  // ── Render: results ──────────────────────────────────────────────────────────
  if (phase === 'results' && result) {
    return <ResultsScreen test={test} result={result} onBack={() => navigation.goBack()} />;
  }

  // ── Render: pre-test ─────────────────────────────────────────────────────────
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
            <Text style={preStyles.detailValue}>{test.questions.length}</Text>
          </View>
          <View style={preStyles.divider} />
          <View style={preStyles.detailRow}>
            <Text style={preStyles.detailLabel}>Total Marks</Text>
            <Text style={preStyles.detailValue}>{test.questions.reduce((s, q) => s + (q.marks ?? 1), 0)}</Text>
          </View>
          <View style={preStyles.divider} />
          <View style={preStyles.detailRow}>
            <Text style={preStyles.detailLabel}>Time Limit</Text>
            <Text style={preStyles.detailValue}>
              {hasTimeLimit ? `${test.time_limit_minutes} minutes` : 'No limit'}
            </Text>
          </View>
          {test.available_from && test.available_until && (
            <>
              <View style={preStyles.divider} />
              <View style={preStyles.detailRow}>
                <Text style={preStyles.detailLabel}>Available</Text>
                <Text style={preStyles.detailValue}>{test.available_from} – {test.available_until}</Text>
              </View>
            </>
          )}
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
            hasTimeLimit
              ? `You have ${test.time_limit_minutes} minutes. The timer runs even if you leave the app.`
              : 'There is no time limit for this test.',
            'Use the number pills at the top to jump between questions.',
            'After submitting, see your score and explanations instantly.',
          ].map((line, i) => (
            <View key={i} style={preStyles.instrRow}>
              <Text style={preStyles.instrBullet}>•</Text>
              <Text style={preStyles.instrText}>{line}</Text>
            </View>
          ))}
        </View>

        {/* Resume banner */}
        {hasResumable && (
          <View style={preStyles.resumeBanner}>
            <Text style={preStyles.resumeText}>
              ⏸ You have an attempt in progress. Tap below to continue.
            </Text>
          </View>
        )}

        <TouchableOpacity
          style={[preStyles.startBtn, hasResumable && preStyles.startBtnResume, starting && preStyles.startBtnDisabled]}
          onPress={handleStart}
          disabled={starting}
          accessibilityRole="button"
          accessibilityLabel={hasResumable ? 'Continue test' : 'Start test'}
        >
          {starting ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={preStyles.startBtnText}>
              {hasResumable ? 'Continue Test →' : 'Start Test →'}
            </Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // ── Render: submitting ───────────────────────────────────────────────────────
  if (phase === 'submitting') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1D4ED8" />
        <Text style={styles.loadingText}>Submitting your test…</Text>
      </View>
    );
  }

  // ── Render: active test ──────────────────────────────────────────────────────
  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#1D4ED8" />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Text style={styles.headerSubject} numberOfLines={1}>{test.subject}</Text>
          {secondsLeft !== null ? (
            <View style={[
              styles.timerBadge,
              timerWarning  && styles.timerBadgeWarn,
              timerCritical && styles.timerBadgeCritical,
            ]}>
              <Text style={[styles.timerText, timerWarning && styles.timerTextWarn]}>
                ⏱ {formatTime(secondsLeft)}
              </Text>
            </View>
          ) : (
            <Text style={styles.headerProgress}>{currentIndex + 1}/{questions.length}</Text>
          )}
        </View>
        <Text style={styles.headerTopic} numberOfLines={1}>{test.topic}</Text>
        {secondsLeft !== null && (
          <Text style={styles.progress}>Question {currentIndex + 1} of {questions.length}</Text>
        )}
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
        {currentQ ? (
          <View style={styles.qContainer}>
            <Text style={styles.qDifficulty}>
              {currentQ.difficulty ? currentQ.difficulty.toUpperCase() : 'MCQ'} · {currentQ.marks} mark{currentQ.marks !== 1 ? 's' : ''}
            </Text>
            <Text style={styles.qText}>{currentQ.question_text}</Text>

            {currentQ.options.map((opt, oi) => {
              const selected = answers[currentIndex] === oi;
              return (
                <TouchableOpacity
                  key={oi}
                  style={[styles.optBtn, selected && styles.optBtnSelected]}
                  onPress={() => {
                    setAnswers((prev) => {
                      const next = { ...prev, [currentIndex]: oi };
                      // Save progress after every answer
                      const aid = attemptIdRef.current;
                      if (aid) {
                        saveProgress(test.id, aid, next, currentIndexRef.current)
                          .catch(() => {/* silent */});
                      }
                      return next;
                    });
                  }}
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
        ) : null}
      </ScrollView>

      {/* Footer */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.navBtn, currentIndex === 0 && styles.navBtnDisabled]}
          onPress={() => setCurrentIndex((i) => Math.max(0, i - 1))}
          disabled={currentIndex === 0}
          accessibilityRole="button"
          accessibilityLabel="Previous question"
        >
          <Text style={[styles.navBtnText, currentIndex === 0 && styles.navBtnTextDisabled]}>← Prev</Text>
        </TouchableOpacity>

        {isLast ? (
          <TouchableOpacity
            style={styles.submitBtn}
            onPress={() => setShowModal(true)}
            accessibilityRole="button"
            accessibilityLabel="Submit test"
          >
            <Text style={styles.submitBtnText}>Submit Test</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={styles.navBtn}
            onPress={() => setCurrentIndex((i) => Math.min(questions.length - 1, i + 1))}
            accessibilityRole="button"
            accessibilityLabel="Next question"
          >
            <Text style={styles.navBtnText}>Next →</Text>
          </TouchableOpacity>
        )}
      </View>

      <SubmitModal
        visible={showModal}
        answered={answeredCount}
        total={questions.length}
        onConfirm={() => handleSubmit()}
        onCancel={() => setShowModal(false)}
      />
    </View>
  );
}

// ── Pre-screen styles ─────────────────────────────────────────────────────────

const preStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content:   { padding: 24, paddingBottom: 48, alignItems: 'center' },
  iconWrap:  {
    width: 88, height: 88, borderRadius: 44,
    backgroundColor: '#DBEAFE', justifyContent: 'center', alignItems: 'center', marginBottom: 16,
  },
  icon:    { fontSize: 40 },
  subject: { fontSize: 13, fontWeight: '700', color: '#1D4ED8', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 },
  topic:   { fontSize: 22, fontWeight: '800', color: '#111827', textAlign: 'center', marginBottom: 24, lineHeight: 30 },
  detailCard: {
    width: '100%', backgroundColor: '#FFFFFF', borderRadius: 14, padding: 16, marginBottom: 16,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2,
  },
  detailRow:   { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  detailLabel: { fontSize: 14, color: '#6B7280', fontWeight: '500' },
  detailValue: { fontSize: 14, color: '#111827', fontWeight: '700' },
  divider:     { height: 1, backgroundColor: '#F3F4F6', marginVertical: 2 },
  infoCard: {
    width: '100%', backgroundColor: '#FFFFFF', borderRadius: 14, padding: 16, marginBottom: 20,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2,
  },
  infoTitle:   { fontSize: 15, fontWeight: '700', color: '#374151', marginBottom: 12 },
  instrRow:    { flexDirection: 'row', marginBottom: 8 },
  instrBullet: { fontSize: 14, color: '#1D4ED8', marginRight: 8, lineHeight: 20 },
  instrText:   { fontSize: 13, color: '#4B5563', flex: 1, lineHeight: 20 },
  resumeBanner: {
    width: '100%', backgroundColor: '#ECFDF5', borderRadius: 12, padding: 14, marginBottom: 16,
    borderLeftWidth: 4, borderLeftColor: '#15803D',
  },
  resumeText:        { fontSize: 13, color: '#065F46', fontWeight: '600', lineHeight: 19 },
  startBtn:          { width: '100%', backgroundColor: '#1D4ED8', borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  startBtnResume:    { backgroundColor: '#15803D' },
  startBtnDisabled:  { opacity: 0.6 },
  startBtnText:      { fontSize: 17, fontWeight: '700', color: '#FFFFFF' },
});

// ── Active test + shared styles ───────────────────────────────────────────────

const styles = StyleSheet.create({
  root:    { flex: 1, backgroundColor: '#F9FAFB' },
  centered:{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F9FAFB', gap: 16 },
  loadingText: { fontSize: 15, color: '#6B7280', fontWeight: '500' },

  // Header
  header:        { backgroundColor: '#1D4ED8', paddingTop: 16, paddingBottom: 12, paddingHorizontal: 16 },
  headerTop:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  headerSubject: { fontSize: 16, fontWeight: '700', color: '#FFFFFF', flex: 1, marginRight: 12 },
  headerProgress:{ fontSize: 13, color: 'rgba(255,255,255,0.8)', fontWeight: '600' },
  headerTopic:   { fontSize: 13, color: 'rgba(255,255,255,0.75)' },
  progress:      { fontSize: 12, color: 'rgba(255,255,255,0.65)', marginTop: 4 },

  // Timer badge
  timerBadge:        { backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  timerBadgeWarn:    { backgroundColor: '#FEF3C7' },
  timerBadgeCritical:{ backgroundColor: '#FEE2E2' },
  timerText:         { fontSize: 14, fontWeight: '700', color: '#FFFFFF' },
  timerTextWarn:     { color: '#92400E' },

  // Pills wrapper
  pillsWrapper: { backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },

  // Error banner
  errorBanner: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: '#FEE2E2', paddingHorizontal: 16, paddingVertical: 10,
  },
  errorText:  { fontSize: 13, color: '#DC2626', flex: 1 },
  retryText:  { fontSize: 13, fontWeight: '700', color: '#DC2626', marginLeft: 12 },

  // Question scroll
  questionScroll:  { flex: 1 },
  questionContent: { flexGrow: 1, paddingBottom: 16 },
  qContainer:      { flex: 1, padding: 20 },
  qDifficulty: {
    fontSize: 11, fontWeight: '700', color: '#6B7280',
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8,
  },
  qText: { fontSize: 18, fontWeight: '600', color: '#111827', lineHeight: 28, marginBottom: 24 },

  // Option buttons
  optBtn: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF',
    borderRadius: 12, borderWidth: 2, borderColor: '#E5E7EB',
    padding: 14, marginBottom: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 3, elevation: 1,
  },
  optBtnSelected:      { borderColor: '#1D4ED8', backgroundColor: '#EFF6FF' },
  optBadge:            { width: 32, height: 32, borderRadius: 16, backgroundColor: '#F3F4F6', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  optBadgeSelected:    { backgroundColor: '#1D4ED8' },
  optBadgeText:        { fontSize: 13, fontWeight: '700', color: '#6B7280' },
  optBadgeTextSelected:{ color: '#FFFFFF' },
  optText:             { fontSize: 15, color: '#374151', flex: 1, lineHeight: 22 },
  optTextSelected:     { color: '#1E3A8A', fontWeight: '600' },

  // Footer
  footer: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 16, backgroundColor: '#FFFFFF', borderTopWidth: 1, borderTopColor: '#F3F4F6', gap: 12,
  },
  navBtn:             { flex: 1, backgroundColor: '#F3F4F6', borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  navBtnDisabled:     { opacity: 0.4 },
  navBtnText:         { fontSize: 15, fontWeight: '600', color: '#374151' },
  navBtnTextDisabled: { color: '#9CA3AF' },
  submitBtn:          { flex: 1, backgroundColor: '#1D4ED8', borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  submitBtnText:      { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
});
