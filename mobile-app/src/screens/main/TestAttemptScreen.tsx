import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Modal,
  ActivityIndicator,
  StatusBar,
  AppState,
  AppStateStatus,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from '../../api/client';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TestMeta {
  id: string;
  title: string;
  time_limit_minutes: number;
  question_count: number;
  instructions?: string | null;
  attempt_status?: 'not_started' | 'in_progress' | 'completed';
  available_from?: string | null;
  available_until?: string | null;
}

interface Question {
  id: string;
  order_index: number;
  question_text: string;
  question_type: 'mcq' | 'theory';
  option_a: string | null;
  option_b: string | null;
  option_c: string | null;
  option_d: string | null;
  marks: number;
}

type OptionKey = 'a' | 'b' | 'c' | 'd';

interface Answer {
  question_id: string;
  selected_option?: OptionKey;
  theory_answer?: string;
}

type Phase = 'pre' | 'active' | 'submitting' | 'results';

interface ResultAnswer {
  question_id: string;
  question_text: string;
  question_type: 'mcq' | 'theory';
  option_a?: string | null;
  option_b?: string | null;
  option_c?: string | null;
  option_d?: string | null;
  selected_option?: string | null;
  correct_option?: string | null;
  is_correct?: boolean | null;
  marks: number;
  marks_awarded: number | 'pending' | null;
  theory_answer?: string | null;
}

interface ResultData {
  attempt_id: string;
  mcq_score: number | null;
  total_score: number | null;
  total_score_pending: boolean;
  answers: ResultAnswer[];
}

// ── Navigation prop type (stack-compatible) ───────────────────────────────────

interface TestAttemptScreenProps {
  route: {
    params: {
      test: TestMeta;
    };
  };
  navigation: {
    goBack: () => void;
    navigate: (screen: string) => void;
  };
}

// ── AsyncStorage key helpers ──────────────────────────────────────────────────

const progressKey = (testId: string) => `eduvo_test_progress_${testId}`;

interface SavedProgress {
  attempt_id: string;
  answers: Answer[];
  currentIndex: number;
  secondsLeft: number | null;
  savedAt: string;
}

async function saveProgress(
  testId: string,
  attempt_id: string,
  answers: Answer[],
  currentIndex: number,
  secondsLeft: number | null
): Promise<void> {
  const payload: SavedProgress = {
    attempt_id,
    answers,
    currentIndex,
    secondsLeft,
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
  _initialSeconds: number | null,
  onExpire: () => void
): { secondsLeft: number | null; setSecondsLeft: React.Dispatch<React.SetStateAction<number | null>> } {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  // Only fire onExpire after the timer has actually been counting down from a
  // positive value. This prevents an instant auto-submit when remaining time
  // is computed as 0 on the very first assignment (e.g. clock skew or a
  // resumed attempt whose time limit already elapsed).
  const hasTickedRef = useRef(false);

  useEffect(() => {
    // No timer active — reset ticked flag
    if (secondsLeft === null) {
      hasTickedRef.current = false;
      return;
    }

    // Expired — only call onExpire if we actually counted down to 0
    if (secondsLeft <= 0) {
      if (hasTickedRef.current) {
        onExpireRef.current();
      }
      return;
    }

    // Timer running — mark that we've seen at least one positive tick
    hasTickedRef.current = true;

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

function formatHHMM(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(':');
  const h = parseInt(hStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${mStr} ${ampm}`;
}

type WindowState = 'before' | 'open' | 'closed' | 'no_window';

/** Converts "HH:MM" to minutes-since-midnight for arithmetic comparison. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Returns the window state for the attempt screen.
 * The date-boundary check is already done in TestsScreen before navigation,
 * so here we only need to verify the HH:MM range — including overnight windows
 * (e.g. 23:00 → 00:30 where available_until < available_from).
 */
function getWindowState(
  availableFrom: string | null | undefined,
  availableUntil: string | null | undefined,
): WindowState {
  if (!availableFrom && !availableUntil) return 'no_window';
  const now = new Date();
  const nowHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const nowMins  = toMinutes(nowHHMM);

  const fromMins  = availableFrom  ? toMinutes(availableFrom)  : null;
  const untilMins = availableUntil ? toMinutes(availableUntil) : null;

  // Overnight window: until < from (e.g. 23:00 → 00:30)
  const isOvernight = fromMins !== null && untilMins !== null && untilMins < fromMins;
  if (isOvernight) {
    if (fromMins !== null && nowMins >= fromMins) return 'open';
    if (untilMins !== null && nowMins <= untilMins) return 'open';
    return 'before';
  }

  // Normal same-day window
  if (fromMins !== null && nowMins < fromMins) return 'before';
  // Zero-duration window (until == from) → treat as no close time
  const effectiveUntil = (availableUntil && availableUntil !== availableFrom) ? availableUntil : null;
  if (effectiveUntil && nowMins > toMinutes(effectiveUntil)) return 'closed';
  return 'open';
}

// ── Pre-test screen ───────────────────────────────────────────────────────────

function PreTestScreen({
  test,
  onStart,
  starting,
  isResume,
}: {
  test: TestMeta;
  onStart: () => void;
  starting: boolean;
  isResume?: boolean;
}) {
  return (
    <ScrollView style={preStyles.container} contentContainerStyle={preStyles.content}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      <View style={preStyles.iconWrap}>
        <Text style={preStyles.icon}>📝</Text>
      </View>

      <Text style={preStyles.title}>{test.title}</Text>

      {/* Details grid */}
      <View style={preStyles.detailsCard}>
        <View style={preStyles.detailRow}>
          <Text style={preStyles.detailLabel}>Questions</Text>
          <Text style={preStyles.detailValue}>{test.question_count}</Text>
        </View>
        <View style={preStyles.divider} />
        <View style={preStyles.detailRow}>
          <Text style={preStyles.detailLabel}>Time Limit</Text>
          <Text style={preStyles.detailValue}>
            {test.time_limit_minutes > 0 ? `${test.time_limit_minutes} min` : 'No limit'}
          </Text>
        </View>
      </View>

      {/* Instructions */}
      <View style={preStyles.instructionsCard}>
        <Text style={preStyles.instructionsTitle}>Instructions</Text>
        {[
          'Read each question carefully before answering.',
          'MCQ: tap an option to select it. You can change your answer before submitting.',
          'Theory: type your answer in the text box provided.',
          test.time_limit_minutes > 0
            ? `You have ${test.time_limit_minutes} minutes. The test auto-submits when time runs out.`
            : 'There is no time limit for this test.',
          'Use the question pills at the top to jump between questions.',
          'You must confirm before final submission.',
        ].map((line, i) => (
          <View key={i} style={preStyles.instrRow}>
            <Text style={preStyles.instrBullet}>•</Text>
            <Text style={preStyles.instrText}>{line}</Text>
          </View>
        ))}
        {test.instructions ? (
          <View style={preStyles.customInstr}>
            <Text style={preStyles.customInstrTitle}>Teacher's Note</Text>
            <Text style={preStyles.customInstrText}>{test.instructions}</Text>
          </View>
        ) : null}
      </View>

      {/* Resume banner */}
      {isResume && (
        <View style={preStyles.resumeBanner}>
          <Text style={preStyles.resumeText}>⏸ You have an attempt in progress. Tap below to continue.</Text>
        </View>
      )}

      <TouchableOpacity
        style={[preStyles.startBtn, isResume && preStyles.startBtnResume, starting && preStyles.startBtnDisabled]}
        onPress={onStart}
        disabled={starting}
        accessibilityRole="button"
        accessibilityLabel={isResume ? 'Continue test' : 'Start test'}
      >
        {starting ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text style={preStyles.startBtnText}>{isResume ? 'Continue Test →' : 'Start Test →'}</Text>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
}

const preStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { padding: 24, paddingBottom: 48, alignItems: 'center' },
  iconWrap: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: '#DBEAFE',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  icon: { fontSize: 40 },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: '#111827',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 32,
  },
  detailsCard: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  detailLabel: { fontSize: 14, color: '#6B7280', fontWeight: '500' },
  detailValue: { fontSize: 14, color: '#111827', fontWeight: '700' },
  divider: { height: 1, backgroundColor: '#F3F4F6', marginVertical: 4 },
  instructionsCard: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 28,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  instructionsTitle: { fontSize: 15, fontWeight: '700', color: '#374151', marginBottom: 12 },
  instrRow: { flexDirection: 'row', marginBottom: 8 },
  instrBullet: { fontSize: 14, color: '#1D4ED8', marginRight: 8, lineHeight: 20 },
  instrText: { fontSize: 13, color: '#4B5563', flex: 1, lineHeight: 20 },
  customInstr: {
    marginTop: 12,
    backgroundColor: '#EFF6FF',
    borderRadius: 8,
    padding: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#1D4ED8',
  },
  customInstrTitle: { fontSize: 12, fontWeight: '700', color: '#1E3A8A', marginBottom: 4 },
  customInstrText: { fontSize: 13, color: '#374151', lineHeight: 19 },
  startBtn: {
    width: '100%',
    backgroundColor: '#1D4ED8',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  startBtnDisabled: { opacity: 0.6 },
  startBtnResume: { backgroundColor: '#15803D' },
  startBtnText: { fontSize: 17, fontWeight: '700', color: '#FFFFFF' },
  resumeBanner: {
    width: '100%',
    backgroundColor: '#ECFDF5',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    borderLeftWidth: 4,
    borderLeftColor: '#15803D',
  },
  resumeText: { fontSize: 13, color: '#065F46', fontWeight: '600', lineHeight: 19 },
});

// ── Question pill strip ───────────────────────────────────────────────────────

function QuestionPills({
  total,
  current,
  answers,
  onJump,
}: {
  total: number;
  current: number;
  answers: Answer[];
  onJump: (idx: number) => void;
}) {
  const answeredSet = new Set(
    answers
      .filter((a) => a.selected_option || (a.theory_answer && a.theory_answer.trim().length > 0))
      .map((a) => a.question_id)
  );

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={pillStyles.scroll}
      contentContainerStyle={pillStyles.content}
    >
      {Array.from({ length: total }, (_, i) => {
        const isCurrent = i === current;
        // We don't have question IDs here, so we track by index via answers array position
        const ans = answers[i];
        const isAnswered = ans
          ? !!(ans.selected_option || (ans.theory_answer && ans.theory_answer.trim().length > 0))
          : false;

        return (
          <TouchableOpacity
            key={i}
            style={[
              pillStyles.pill,
              isAnswered && pillStyles.pillAnswered,
              isCurrent && pillStyles.pillCurrent,
            ]}
            onPress={() => onJump(i)}
            accessibilityRole="button"
            accessibilityLabel={`Question ${i + 1}${isAnswered ? ', answered' : ', unanswered'}`}
            accessibilityState={{ selected: isCurrent }}
          >
            <Text
              style={[
                pillStyles.pillText,
                isAnswered && pillStyles.pillTextAnswered,
                isCurrent && pillStyles.pillTextCurrent,
              ]}
            >
              {i + 1}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const pillStyles = StyleSheet.create({
  scroll: { maxHeight: 52 },
  content: { paddingHorizontal: 16, paddingVertical: 8, gap: 8, flexDirection: 'row' },
  pill: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#E5E7EB',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pillAnswered: { backgroundColor: '#22C55E' },
  pillCurrent: { backgroundColor: '#1D4ED8', borderWidth: 2, borderColor: '#93C5FD' },
  pillText: { fontSize: 13, fontWeight: '600', color: '#6B7280' },
  pillTextAnswered: { color: '#FFFFFF' },
  pillTextCurrent: { color: '#FFFFFF' },
});

// ── MCQ question view ─────────────────────────────────────────────────────────

const OPTION_LABELS: OptionKey[] = ['a', 'b', 'c', 'd'];
const OPTION_DISPLAY: Record<OptionKey, string> = { a: 'A', b: 'B', c: 'C', d: 'D' };

function MCQQuestion({
  question,
  answer,
  onSelect,
}: {
  question: Question;
  answer: Answer | undefined;
  onSelect: (opt: OptionKey) => void;
}) {
  const options: Array<{ key: OptionKey; text: string | null }> = [
    { key: 'a', text: question.option_a },
    { key: 'b', text: question.option_b },
    { key: 'c', text: question.option_c },
    { key: 'd', text: question.option_d },
  ];

  return (
    <View style={qStyles.container}>
      <View style={qStyles.marksRow}>
        <Text style={qStyles.marksLabel}>MCQ · {question.marks} mark{question.marks !== 1 ? 's' : ''}</Text>
      </View>
      <Text style={qStyles.questionText}>{question.question_text}</Text>

      <View style={qStyles.optionsContainer}>
        {options.map(({ key, text }) => {
          if (!text) return null;
          const selected = answer?.selected_option === key;
          return (
            <TouchableOpacity
              key={key}
              style={[qStyles.optionBtn, selected && qStyles.optionBtnSelected]}
              onPress={() => onSelect(key)}
              activeOpacity={0.75}
              accessibilityRole="radio"
              accessibilityLabel={`Option ${OPTION_DISPLAY[key]}: ${text}`}
              accessibilityState={{ checked: selected }}
            >
              <View style={[qStyles.optionBadge, selected && qStyles.optionBadgeSelected]}>
                <Text style={[qStyles.optionBadgeText, selected && qStyles.optionBadgeTextSelected]}>
                  {OPTION_DISPLAY[key]}
                </Text>
              </View>
              <Text style={[qStyles.optionText, selected && qStyles.optionTextSelected]}>
                {text}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

// ── Theory question view ──────────────────────────────────────────────────────

function TheoryQuestion({
  question,
  answer,
  onChange,
}: {
  question: Question;
  answer: Answer | undefined;
  onChange: (text: string) => void;
}) {
  return (
    <View style={qStyles.container}>
      <View style={qStyles.marksRow}>
        <Text style={qStyles.marksLabel}>Theory · {question.marks} mark{question.marks !== 1 ? 's' : ''}</Text>
      </View>
      <Text style={qStyles.questionText}>{question.question_text}</Text>

      <TextInput
        style={qStyles.theoryInput}
        multiline
        placeholder="Type your answer here…"
        placeholderTextColor="#9CA3AF"
        value={answer?.theory_answer ?? ''}
        onChangeText={onChange}
        textAlignVertical="top"
        accessibilityLabel="Theory answer input"
      />
    </View>
  );
}

const qStyles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  marksRow: { marginBottom: 8 },
  marksLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  questionText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    lineHeight: 28,
    marginBottom: 24,
  },
  optionsContainer: { gap: 12 },
  optionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#E5E7EB',
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  optionBtnSelected: {
    borderColor: '#1D4ED8',
    backgroundColor: '#EFF6FF',
  },
  optionBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#F3F4F6',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  optionBadgeSelected: { backgroundColor: '#1D4ED8' },
  optionBadgeText: { fontSize: 13, fontWeight: '700', color: '#6B7280' },
  optionBadgeTextSelected: { color: '#FFFFFF' },
  optionText: { fontSize: 15, color: '#374151', flex: 1, lineHeight: 22 },
  optionTextSelected: { color: '#1E3A8A', fontWeight: '600' },
  theoryInput: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#D1D5DB',
    padding: 14,
    fontSize: 15,
    color: '#111827',
    minHeight: 180,
    lineHeight: 22,
  },
});

// ── Submit confirmation modal ─────────────────────────────────────────────────

function SubmitModal({
  visible,
  answeredCount,
  totalCount,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  answeredCount: number;
  totalCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const unanswered = totalCount - answeredCount;
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      accessibilityViewIsModal
    >
      <View style={modalStyles.overlay}>
        <View style={modalStyles.card}>
          <Text style={modalStyles.title}>Submit Test?</Text>
          <Text style={modalStyles.body}>
            <Text style={modalStyles.bold}>{answeredCount}</Text> question
            {answeredCount !== 1 ? 's' : ''} answered
            {unanswered > 0 ? (
              <>
                {', '}
                <Text style={modalStyles.warn}>{unanswered} unanswered</Text>
              </>
            ) : null}
            .
          </Text>
          {unanswered > 0 && (
            <Text style={modalStyles.hint}>
              Unanswered questions will receive 0 marks.
            </Text>
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
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
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
  testTitle,
  results,
  onBack,
}: {
  testTitle: string;
  results: ResultData;
  onBack: () => void;
}) {
  const mcqAnswers = results.answers.filter((a) => a.question_type === 'mcq');
  const theoryAnswers = results.answers.filter((a) => a.question_type === 'theory');
  const totalMcqMarks = mcqAnswers.reduce((s, a) => s + a.marks, 0);
  const correctCount = mcqAnswers.filter((a) => a.is_correct).length;

  return (
    <ScrollView style={resStyles.container} contentContainerStyle={resStyles.content}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

      <Text style={resStyles.heading}>Results</Text>
      <Text style={resStyles.testTitle}>{testTitle}</Text>

      {/* Score summary */}
      <View style={resStyles.scoreCard}>
        <View style={resStyles.scoreBlock}>
          <Text style={resStyles.scoreLabel}>MCQ Score</Text>
          <Text style={resStyles.scoreValue}>
            {results.mcq_score ?? 0}
            <Text style={resStyles.scoreMax}> / {totalMcqMarks}</Text>
          </Text>
          <Text style={resStyles.scoreSubtext}>
            {correctCount} of {mcqAnswers.length} correct
          </Text>
        </View>
        {theoryAnswers.length > 0 && (
          <>
            <View style={resStyles.scoreDivider} />
            <View style={resStyles.scoreBlock}>
              <Text style={resStyles.scoreLabel}>Theory</Text>
              <Text style={[resStyles.scoreValue, resStyles.scorePending]}>
                {results.total_score_pending ? 'Pending' : results.total_score ?? '—'}
              </Text>
              <Text style={resStyles.scoreSubtext}>Awaiting teacher review</Text>
            </View>
          </>
        )}
      </View>

      {/* MCQ per-question breakdown */}
      {mcqAnswers.length > 0 && (
        <View style={resStyles.section}>
          <Text style={resStyles.sectionTitle}>MCQ Breakdown</Text>
          {mcqAnswers.map((ans, idx) => {
            const correct = ans.is_correct === true;
            const skipped = ans.selected_option == null;
            const optionText = (opt: string | null | undefined) => {
              if (!opt) return null;
              const map: Record<string, string | null | undefined> = {
                a: ans.option_a, b: ans.option_b, c: ans.option_c, d: ans.option_d,
              };
              return map[opt] ?? opt.toUpperCase();
            };

            return (
              <View
                key={ans.question_id}
                style={[resStyles.qRow, correct ? resStyles.qRowCorrect : resStyles.qRowWrong]}
              >
                <View style={resStyles.qRowHeader}>
                  <Text style={resStyles.qNum}>Q{idx + 1}</Text>
                  <Text style={correct ? resStyles.tick : resStyles.cross}>
                    {skipped ? '—' : correct ? '✓' : '✗'}
                  </Text>
                </View>
                <Text style={resStyles.qText}>{ans.question_text}</Text>
                {!skipped && (
                  <Text style={resStyles.qYourAnswer}>
                    Your answer:{' '}
                    <Text style={correct ? resStyles.ansCorrect : resStyles.ansWrong}>
                      {ans.selected_option?.toUpperCase()} — {optionText(ans.selected_option)}
                    </Text>
                  </Text>
                )}
                {skipped && (
                  <Text style={resStyles.qYourAnswer}>Not answered</Text>
                )}
                {!correct && ans.correct_option && (
                  <Text style={resStyles.qCorrectAnswer}>
                    ✓ Correct answer: <Text style={resStyles.ansCorrect}>{ans.correct_option.toUpperCase()} — {optionText(ans.correct_option)}</Text>
                  </Text>
                )}
              </View>
            );
          })}
        </View>
      )}

      {/* Theory section */}
      {theoryAnswers.length > 0 && (
        <View style={resStyles.section}>
          <Text style={resStyles.sectionTitle}>Theory Questions</Text>
          <View style={resStyles.theoryNote}>
            <Text style={resStyles.theoryNoteText}>
              🕐 Theory answers are reviewed by your teacher. Marks will appear once graded.
            </Text>
          </View>
          {theoryAnswers.map((ans, idx) => (
            <View key={ans.question_id} style={resStyles.theoryRow}>
              <Text style={resStyles.theoryQNum}>Theory Q{idx + 1}</Text>
              <Text style={resStyles.theoryQText}>{ans.question_text}</Text>
              <Text style={resStyles.theoryMarks}>
                Marks:{' '}
                {ans.marks_awarded === 'pending' || ans.marks_awarded === null
                  ? 'Pending'
                  : `${ans.marks_awarded} / ${ans.marks}`}
              </Text>
            </View>
          ))}
        </View>
      )}

      <TouchableOpacity
        style={resStyles.backBtn}
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Back to tests list"
      >
        <Text style={resStyles.backBtnText}>← Back to Tests</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const resStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { padding: 20, paddingBottom: 48 },
  heading: { fontSize: 26, fontWeight: '800', color: '#111827', marginBottom: 4 },
  testTitle: { fontSize: 15, color: '#6B7280', marginBottom: 20 },
  scoreCard: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 20,
    marginBottom: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 5,
    elevation: 2,
  },
  scoreBlock: { flex: 1, alignItems: 'center' },
  scoreLabel: { fontSize: 11, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  scoreValue: { fontSize: 32, fontWeight: '800', color: '#111827' },
  scoreMax: { fontSize: 18, fontWeight: '500', color: '#6B7280' },
  scoreSubtext: { fontSize: 12, color: '#6B7280', marginTop: 4 },
  scorePending: { fontSize: 22, color: '#D97706' },
  scoreDivider: { width: 1, backgroundColor: '#F3F4F6', marginVertical: 4 },
  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#374151', marginBottom: 12 },
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
  qRowHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  qNum: { fontSize: 12, fontWeight: '700', color: '#6B7280' },
  tick: { fontSize: 18, color: '#22C55E', fontWeight: '700' },
  cross: { fontSize: 18, color: '#EF4444', fontWeight: '700' },
  qText: { fontSize: 14, color: '#111827', lineHeight: 20, marginBottom: 8 },
  qYourAnswer: { fontSize: 13, color: '#6B7280' },
  ansCorrect: { color: '#15803D', fontWeight: '600' },
  ansWrong: { color: '#DC2626', fontWeight: '600' },
  qCorrectAnswer: { fontSize: 13, color: '#15803D', marginTop: 4, fontWeight: '500' },
  theoryNote: {
    backgroundColor: '#FEF3C7',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  theoryNoteText: { fontSize: 13, color: '#92400E', lineHeight: 19 },
  theoryRow: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderLeftWidth: 4,
    borderLeftColor: '#D97706',
  },
  theoryQNum: { fontSize: 12, fontWeight: '700', color: '#6B7280', marginBottom: 4 },
  theoryQText: { fontSize: 14, color: '#111827', lineHeight: 20, marginBottom: 8 },
  theoryMarks: { fontSize: 13, color: '#D97706', fontWeight: '600' },
  backBtn: {
    backgroundColor: '#1D4ED8',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  backBtnText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
});

// ── Main component ────────────────────────────────────────────────────────────

export default function TestAttemptScreen({ route, navigation }: TestAttemptScreenProps) {
  const { test } = route.params;

  // ── Phase & core state ──────────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>('pre');
  const [loadingResults, setLoadingResults] = useState(
    test.attempt_status === 'completed'
  ); // true while silently fetching results for completed tests
  const [starting, setStarting] = useState(false);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [results, setResults] = useState<ResultData | null>(null);

  // ── Timer ───────────────────────────────────────────────────────────────────
  const hasTimeLimit = test.time_limit_minutes > 0;
  const initialSeconds = hasTimeLimit ? test.time_limit_minutes * 60 : null;
  const { secondsLeft, setSecondsLeft } = useCountdown(
    null, // start as null; set when test begins
    () => {
      // Auto-submit when timer hits 0 — use phaseRef to avoid stale closure
      if (phaseRef.current === 'active') {
        handleSubmit(true);
      }
    }
  );

  // Keep a ref to answers for use in AppState handler without stale closure
  const answersRef = useRef<Answer[]>([]);
  const attemptIdRef = useRef<string | null>(null);
  const currentIndexRef = useRef(0);
  const secondsLeftRef = useRef<number | null>(null);
  // Store the server-side started_at timestamp and time limit so the AppState
  // handler can recompute remaining time when the app returns to foreground.
  const startedAtRef = useRef<string | null>(null);
  const timeLimitSecondsRef = useRef<number | null>(null);
  const phaseRef = useRef<Phase>('pre');

  useEffect(() => { answersRef.current = answers; }, [answers]);
  useEffect(() => { attemptIdRef.current = attemptId; }, [attemptId]);
  useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);
  useEffect(() => { secondsLeftRef.current = secondsLeft; }, [secondsLeft]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // ── AppState: correct timer on foreground; save progress on background ──────
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'background' || state === 'inactive') {
        // Save progress when leaving — timer is NOT saved, it will be recomputed on return
        const aid = attemptIdRef.current;
        if (aid && phaseRef.current === 'active') {
          saveProgress(
            test.id,
            aid,
            answersRef.current,
            currentIndexRef.current,
            null  // never persist secondsLeft — always recompute from server timestamp
          ).catch(() => {/* silent */});
        }
      } else if (state === 'active') {
        // App came back to foreground — recalculate remaining time from server started_at.
        // This corrects any time the student spent outside the app.
        if (phaseRef.current === 'active' && startedAtRef.current && timeLimitSecondsRef.current !== null) {
          const elapsed = Math.floor((Date.now() - new Date(startedAtRef.current).getTime()) / 1000);
          const remaining = Math.max(0, timeLimitSecondsRef.current - elapsed);
          setSecondsLeft(remaining);
          // If time has already expired while in background, the countdown hook will
          // fire onExpire (→ handleSubmit) as soon as secondsLeft reaches 0.
        }
      }
    });
    return () => sub.remove();
  }, [test.id, setSecondsLeft]);

  // ── Start / resume test ─────────────────────────────────────────────────────
  const [hasActiveAttempt, setHasActiveAttempt] = useState(false);

  // On mount: if the test is already completed, skip the pre-screen and load results directly.
  // Otherwise check for saved local progress to show resume option.
  useEffect(() => {
    const checkAttemptStatus = async () => {
      if (test.attempt_status === 'completed') {
        // Silently fetch results in background — no spinner, no phase change until data is ready
        try {
          // Hit start — backend returns 409 with attempt_id for already-submitted tests
          await apiClient.post('/api/tests/attempt/start', { test_id: test.id });
          // Succeeded (edge case — test not actually submitted yet), show pre screen
          setLoadingResults(false);
          setPhase('pre');
        } catch (err: unknown) {
          const attemptIdFromErr =
            (err as { response?: { data?: { attempt_id?: string } } })?.response?.data?.attempt_id;
          const msg =
            (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '';

          if (attemptIdFromErr && msg.toLowerCase().includes('already submitted')) {
            try {
              const resResponse = await apiClient.get(`/api/tests/results/${attemptIdFromErr}`);
              const resultData = resResponse.data.data as ResultData;
              setResults(resultData);
              setAttemptId(attemptIdFromErr);
              setLoadingResults(false);
              setPhase('results');
              return;
            } catch {
              // fall through to pre screen
            }
          }
          setLoadingResults(false);
          setPhase('pre');
        }
        return;
      }

      // Not completed — check for saved local progress (in-progress attempt)
      const saved = await loadProgress(test.id);
      if (saved) setHasActiveAttempt(true);
    };

    void checkAttemptStatus();
  }, [test.id, test.attempt_status]);

  const handleStart = useCallback(async () => {
    setStarting(true);
    try {
      const res = await apiClient.post('/api/tests/attempt/start', { test_id: test.id });
      const payload = res.data.data as {
        attempt_id: string;
        time_limit_minutes: number;
        started_at: string;
        resumed: boolean;
        questions: Question[];
      };

      const qs = payload.questions;
      setQuestions(qs);
      setAttemptId(payload.attempt_id);

      // Store started_at and time limit in refs so the AppState foreground handler
      // can recompute remaining time whenever the student returns to the app.
      startedAtRef.current = payload.started_at;
      timeLimitSecondsRef.current = hasTimeLimit ? payload.time_limit_minutes * 60 : null;

      // Initialise answer slots (one per question, empty)
      setAnswers(qs.map((q) => ({ question_id: q.id })));

      // Restore saved progress if resuming (app backgrounded or server-side active attempt)
      const saved = await loadProgress(test.id);
      if (saved && saved.attempt_id === payload.attempt_id) {
        setAnswers(saved.answers);
        setCurrentIndex(saved.currentIndex);
      }

      // Timer is ALWAYS computed from started_at — never trust saved secondsLeft.
      // This means time spent in the background or outside the app is always deducted.
      if (hasTimeLimit) {
        const elapsed = Math.floor((Date.now() - new Date(payload.started_at).getTime()) / 1000);
        const remaining = Math.max(0, payload.time_limit_minutes * 60 - elapsed);

        // The backend now resets any expired attempt and gives a fresh started_at,
        // so remaining should always be positive here. If extreme clock skew causes
        // it to round down to 0, use 1 so the student isn't blocked from starting.
        setSecondsLeft(remaining > 0 ? remaining : 1);
      }

      // Sync phaseRef immediately before setPhase so onExpire never fires while
      // still in 'pre' state due to React batching
      phaseRef.current = 'active';
      setPhase('active');
    } catch (err: unknown) {
      const attemptIdFromErr =
        (err as { response?: { data?: { attempt_id?: string } } })?.response?.data?.attempt_id;
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? (err instanceof Error ? err.message : 'Failed to start test');

      // Safety net: if backend says already submitted, load results instead of erroring
      if (attemptIdFromErr && msg.toLowerCase().includes('already submitted')) {
        try {
          const resResponse = await apiClient.get(`/api/tests/results/${attemptIdFromErr}`);
          const resultData = resResponse.data.data as ResultData;
          setResults(resultData);
          setAttemptId(attemptIdFromErr);
          setPhase('results');
          return;
        } catch {
          // fall through to alert
        }
      }

      Alert.alert('Could not start test', msg);
    } finally {
      setStarting(false);
    }
  }, [test.id, hasTimeLimit, setSecondsLeft]);

  // ── Answer handlers ─────────────────────────────────────────────────────────
  const handleSelectOption = useCallback((opt: OptionKey) => {
    setAnswers((prev) =>
      prev.map((a, i) =>
        i === currentIndex ? { ...a, selected_option: opt } : a
      )
    );
  }, [currentIndex]);

  const handleTheoryChange = useCallback((text: string) => {
    setAnswers((prev) =>
      prev.map((a, i) =>
        i === currentIndex ? { ...a, theory_answer: text } : a
      )
    );
  }, [currentIndex]);

  // ── Navigation ──────────────────────────────────────────────────────────────
  const goTo = useCallback((idx: number) => {
    setCurrentIndex(Math.max(0, Math.min(idx, questions.length - 1)));
  }, [questions.length]);

  // ── Submit ──────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (autoSubmit = false) => {
    if (!attemptId) return;
    setShowSubmitModal(false);
    phaseRef.current = 'submitting'; // sync immediately so onExpire can't double-fire
    setPhase('submitting');
    setSubmitError(null);

    const currentAnswers = answersRef.current;

    // Build payload — include all questions, even unanswered ones
    const answersPayload = currentAnswers.map((a) => {
      const entry: { question_id: string; selected_option?: OptionKey; theory_answer?: string } = {
        question_id: a.question_id,
      };
      if (a.selected_option) entry.selected_option = a.selected_option;
      if (a.theory_answer && a.theory_answer.trim()) entry.theory_answer = a.theory_answer.trim();
      return entry;
    });

    try {
      await apiClient.post('/api/tests/attempt/submit', {
        attempt_id: attemptId,
        answers: answersPayload,
      });

      // Fetch results
      const resResponse = await apiClient.get(`/api/tests/results/${attemptId}`);
      const resultData = resResponse.data.data as ResultData;
      setResults(resultData);

      // Clear saved progress
      await clearProgress(test.id);

      setPhase('results');
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? (err instanceof Error ? err.message : 'Submission failed. Please retry.');
      setSubmitError(msg);
      setPhase('active'); // return to active so student can retry
    }
  }, [attemptId, test.id]);

  // ── Answered count ──────────────────────────────────────────────────────────
  const answeredCount = answers.filter(
    (a) => a.selected_option || (a.theory_answer && a.theory_answer.trim().length > 0)
  ).length;

  // ── Timer warning colour ────────────────────────────────────────────────────
  const timerWarning = secondsLeft !== null && secondsLeft <= 60;
  const timerCritical = secondsLeft !== null && secondsLeft <= 30;

  // ── Render: loading results (completed test, fetching silently) ─────────────
  if (loadingResults) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F9FAFB' }}>
        <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
        <ActivityIndicator size="large" color="#1D4ED8" />
        <Text style={{ marginTop: 14, fontSize: 14, color: '#6B7280', fontWeight: '500' }}>
          Loading your results…
        </Text>
      </View>
    );
  }

  // ── Render: pre-test ────────────────────────────────────────────────────────
  if (phase === 'pre') {
    return (
      <PreTestScreen test={test} onStart={handleStart} starting={starting} isResume={hasActiveAttempt} />
    );
  }

  // ── Render: results ─────────────────────────────────────────────────────────
  if (phase === 'results' && results) {
    return (
      <ResultsScreen
        testTitle={test.title}
        results={results}
        onBack={() => navigation.goBack()}
      />
    );
  }

  // ── Render: submitting overlay ───────────────────────────────────────────────
  if (phase === 'submitting') {
    return (
      <View style={activeStyles.centered}>
        <ActivityIndicator size="large" color="#1D4ED8" />
        <Text style={activeStyles.submittingText}>Submitting your test…</Text>
      </View>
    );
  }

  // ── Render: active test ──────────────────────────────────────────────────────
  const currentQuestion = questions[currentIndex];
  const currentAnswer = answers[currentIndex];
  const isLast = currentIndex === questions.length - 1;

  return (
    <KeyboardAvoidingView
      style={activeStyles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <StatusBar barStyle="light-content" backgroundColor="#1D4ED8" />

      {/* ── Header ── */}
      <View style={activeStyles.header}>
        <View style={activeStyles.headerTop}>
          <Text style={activeStyles.headerTitle} numberOfLines={1}>{test.title}</Text>
          {secondsLeft !== null && (
            <View style={[
              activeStyles.timerBadge,
              timerWarning && activeStyles.timerBadgeWarn,
              timerCritical && activeStyles.timerBadgeCritical,
            ]}>
              <Text style={[
                activeStyles.timerText,
                timerWarning && activeStyles.timerTextWarn,
              ]}>
                ⏱ {formatTime(secondsLeft)}
              </Text>
            </View>
          )}
        </View>
        <Text style={activeStyles.progress}>
          Question {currentIndex + 1} of {questions.length}
        </Text>
      </View>

      {/* ── Question pills ── */}
      <View style={activeStyles.pillsWrapper}>
        <QuestionPills
          total={questions.length}
          current={currentIndex}
          answers={answers}
          onJump={goTo}
        />
      </View>

      {/* ── Submit error banner ── */}
      {submitError && (
        <View style={activeStyles.errorBanner}>
          <Text style={activeStyles.errorText}>⚠️ {submitError}</Text>
          <TouchableOpacity
            onPress={() => handleSubmit()}
            accessibilityRole="button"
            accessibilityLabel="Retry submission"
          >
            <Text style={activeStyles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Question body ── */}
      <ScrollView
        style={activeStyles.questionScroll}
        contentContainerStyle={activeStyles.questionScrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {currentQuestion?.question_type === 'mcq' ? (
          <MCQQuestion
            question={currentQuestion}
            answer={currentAnswer}
            onSelect={handleSelectOption}
          />
        ) : currentQuestion ? (
          <TheoryQuestion
            question={currentQuestion}
            answer={currentAnswer}
            onChange={handleTheoryChange}
          />
        ) : null}
      </ScrollView>

      {/* ── Navigation footer ── */}
      <View style={activeStyles.footer}>
        <TouchableOpacity
          style={[activeStyles.navBtn, currentIndex === 0 && activeStyles.navBtnDisabled]}
          onPress={() => goTo(currentIndex - 1)}
          disabled={currentIndex === 0}
          accessibilityRole="button"
          accessibilityLabel="Previous question"
        >
          <Text style={[activeStyles.navBtnText, currentIndex === 0 && activeStyles.navBtnTextDisabled]}>
            ← Prev
          </Text>
        </TouchableOpacity>

        {isLast ? (
          <TouchableOpacity
            style={activeStyles.submitBtn}
            onPress={() => setShowSubmitModal(true)}
            accessibilityRole="button"
            accessibilityLabel="Submit test"
          >
            <Text style={activeStyles.submitBtnText}>Submit Test</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={activeStyles.navBtn}
            onPress={() => goTo(currentIndex + 1)}
            accessibilityRole="button"
            accessibilityLabel="Next question"
          >
            <Text style={activeStyles.navBtnText}>Next →</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ── Submit confirmation modal ── */}
      <SubmitModal
        visible={showSubmitModal}
        answeredCount={answeredCount}
        totalCount={questions.length}
        onConfirm={() => handleSubmit()}
        onCancel={() => setShowSubmitModal(false)}
      />
    </KeyboardAvoidingView>
  );
}

// ── Active test styles ────────────────────────────────────────────────────────

const activeStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F9FAFB' },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    gap: 16,
  },
  submittingText: { fontSize: 16, color: '#6B7280', fontWeight: '500' },

  // Header
  header: {
    backgroundColor: '#1D4ED8',
    paddingTop: 16,
    paddingBottom: 12,
    paddingHorizontal: 16,
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
    flex: 1,
    marginRight: 12,
  },
  timerBadge: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  timerBadgeWarn: { backgroundColor: '#FEF3C7' },
  timerBadgeCritical: { backgroundColor: '#FEE2E2' },
  timerText: { fontSize: 14, fontWeight: '700', color: '#FFFFFF' },
  timerTextWarn: { color: '#92400E' },
  progress: { fontSize: 13, color: 'rgba(255,255,255,0.75)', fontWeight: '500' },

  // Pills
  pillsWrapper: {
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },

  // Error banner
  errorBanner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#FEE2E2',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  errorText: { fontSize: 13, color: '#DC2626', flex: 1 },
  retryText: { fontSize: 13, fontWeight: '700', color: '#DC2626', marginLeft: 12 },

  // Question scroll
  questionScroll: { flex: 1 },
  questionScrollContent: { flexGrow: 1, paddingBottom: 16 },

  // Footer navigation
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    gap: 12,
  },
  navBtn: {
    flex: 1,
    backgroundColor: '#F3F4F6',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  navBtnDisabled: { opacity: 0.4 },
  navBtnText: { fontSize: 15, fontWeight: '600', color: '#374151' },
  navBtnTextDisabled: { color: '#9CA3AF' },
  submitBtn: {
    flex: 1,
    backgroundColor: '#1D4ED8',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  submitBtnText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
});
