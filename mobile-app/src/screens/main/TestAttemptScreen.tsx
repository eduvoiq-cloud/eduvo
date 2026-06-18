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
  Animated,
  Linking,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
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
  allow_web_attempt?: boolean;
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

type Phase = 'pre' | 'integrity_warning' | 'active' | 'submitting' | 'results' | 'error';

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
  explanation?: string | null;
  reasoning?: string | null;
}

interface ResultData {
  attempt_id: string;
  mcq_score: number | null;
  total_score: number | null;
  total_score_pending: boolean;
  answers: ResultAnswer[];
}

interface IntegrityApiResult {
  integrity_score: number;
  exit_count: number;
  total_exit_duration_seconds: number;
  is_suspicious: boolean;
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

// ── Test integrity tracking ───────────────────────────────────────────────────

export interface IntegrityResult {
  exit_count: number;
  return_count: number;
  total_exit_duration_seconds: number;
  longest_single_exit_seconds: number;
}

/**
 * useTestIntegrity — tracks tab/app visibility events during a test.
 *
 * Call `startTracking()` when the test begins (after the warning modal).
 * Call `finaliseTracking()` on submission to get the collected data.
 */
export function useTestIntegrity() {
  const exitCountRef              = useRef(0);
  const returnCountRef            = useRef(0);
  const totalExitDurationMsRef    = useRef(0);
  const longestSingleExitMsRef    = useRef(0);
  const currentExitStartRef       = useRef<number | null>(null);
  const isCurrentlyOutsideRef     = useRef(false);
  const trackingActiveRef         = useRef(false);

  const recordExit = useCallback(() => {
    if (!trackingActiveRef.current) return;
    if (isCurrentlyOutsideRef.current) return;
    isCurrentlyOutsideRef.current = true;
    currentExitStartRef.current   = Date.now();
    exitCountRef.current         += 1;
  }, []);

  const recordReturn = useCallback(() => {
    if (!trackingActiveRef.current) return;
    if (!isCurrentlyOutsideRef.current) return;
    const start = currentExitStartRef.current;
    if (start !== null) {
      const duration = Date.now() - start;
      totalExitDurationMsRef.current += duration;
      if (duration > longestSingleExitMsRef.current) {
        longestSingleExitMsRef.current = duration;
      }
    }
    returnCountRef.current        += 1;
    isCurrentlyOutsideRef.current  = false;
    currentExitStartRef.current    = null;
  }, []);

  const appStateSubRef = useRef<ReturnType<typeof AppState.addEventListener> | null>(null);

  const startTracking = useCallback(() => {
    trackingActiveRef.current = true;
    appStateSubRef.current = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'background' || state === 'inactive') {
        recordExit();
      } else if (state === 'active') {
        recordReturn();
      }
    });
  }, [recordExit, recordReturn]);

  const stopTracking = useCallback(() => {
    trackingActiveRef.current = false;
    appStateSubRef.current?.remove();
    appStateSubRef.current = null;
  }, []);

  const finaliseTracking = useCallback((): IntegrityResult => {
    if (isCurrentlyOutsideRef.current && currentExitStartRef.current !== null) {
      const duration = Date.now() - currentExitStartRef.current;
      totalExitDurationMsRef.current += duration;
      if (duration > longestSingleExitMsRef.current) {
        longestSingleExitMsRef.current = duration;
      }
      returnCountRef.current        += 1;
      isCurrentlyOutsideRef.current  = false;
      currentExitStartRef.current    = null;
    }
    stopTracking();
    return {
      exit_count:                  exitCountRef.current,
      return_count:                returnCountRef.current,
      total_exit_duration_seconds: Math.round(totalExitDurationMsRef.current / 1000),
      longest_single_exit_seconds: Math.round(longestSingleExitMsRef.current / 1000),
    };
  }, [stopTracking]);

  useEffect(() => {
    return () => { stopTracking(); };
  }, [stopTracking]);

  return { startTracking, finaliseTracking };
}

// ── Integrity warning modal ───────────────────────────────────────────────────

export function IntegrityWarningModal({
  visible,
  onConfirm,
}: {
  visible: boolean;
  onConfirm: () => void;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      accessibilityViewIsModal
    >
      <View style={integrityModalStyles.overlay}>
        <View style={integrityModalStyles.card}>
          <Text style={integrityModalStyles.icon}>🔒</Text>
          <Text style={integrityModalStyles.title}>Test Integrity Monitoring Active</Text>
          <Text style={integrityModalStyles.body}>
            Leaving this page, switching tabs, or minimizing the browser during
            the test will be recorded and shown to your teacher.
          </Text>
          <TouchableOpacity
            style={integrityModalStyles.btn}
            onPress={onConfirm}
            accessibilityRole="button"
            accessibilityLabel="I understand, start test"
          >
            <Text style={integrityModalStyles.btnText}>I Understand — Start Test</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const integrityModalStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 28,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 10,
  },
  icon: { fontSize: 44, marginBottom: 14 },
  title: {
    fontSize: 19,
    fontWeight: '800',
    color: '#111827',
    textAlign: 'center',
    marginBottom: 14,
    lineHeight: 26,
  },
  body: {
    fontSize: 14,
    color: '#4B5563',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  btn: {
    width: '100%',
    backgroundColor: '#1D4ED8',
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
  },
  btnText: { fontSize: 16, fontWeight: '700', color: '#FFFFFF' },
});

// ── Timer hook ────────────────────────────────────────────────────────────────
//
// Design rules:
//   1. Starts as null (no timer running).
//   2. Call setSecondsLeft(N) where N > 0 to start the countdown.
//   3. onExpire fires only after the interval ticks secondsLeft down to 0 —
//      never on the initial setSecondsLeft call.
//   4. The interval is created ONCE per "start" (when setSecondsLeft is called
//      with a positive number). It never re-creates on each state change —
//      this was the root cause of the instant-auto-submit bug where dozens of
//      intervals were stacking up and racing each other to zero.
//   5. onExpireRef keeps the callback fresh without restarting the interval.

function useCountdown(
  _initialSeconds: number | null,
  onExpire: () => void
): { secondsLeft: number | null; setSecondsLeft: (n: number | null) => void } {
  const [secondsLeft, setSecondsLeftState] = useState<number | null>(null);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  // Holds the active interval ID so we can clear it imperatively.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopInterval = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // Public setter — clears any existing interval, then starts a fresh one if
  // given a positive number. Calling with null or 0 just stops the timer.
  const setSecondsLeft = useCallback(
    (n: number | null) => {
      stopInterval();
      if (n === null || n <= 0) {
        setSecondsLeftState(null);
        return;
      }
      setSecondsLeftState(n);
      // One interval, created here imperatively. Each tick decrements by 1.
      // When it reaches 0 we fire onExpire and stop.
      intervalRef.current = setInterval(() => {
        setSecondsLeftState((prev) => {
          if (prev === null || prev <= 1) {
            stopInterval();
            // Schedule onExpire outside setState to avoid React warnings.
            setTimeout(() => onExpireRef.current(), 0);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    },
    [stopInterval],
  );

  // Clean up on unmount.
  useEffect(() => () => stopInterval(), [stopInterval]);

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

// ── Platform choice modal ─────────────────────────────────────────────────────
// Shown when a test allows web attempts and the student hasn't started yet.

function PlatformChoiceModal({
  visible,
  onPhone,
  onWeb,
}: {
  visible: boolean;
  onPhone: () => void;
  onWeb: () => void;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      accessibilityViewIsModal
    >
      <View style={platformModalStyles.overlay}>
        <View style={platformModalStyles.card}>
          <Text style={platformModalStyles.title}>How would you like to take this test?</Text>
          <Text style={platformModalStyles.subtitle}>
            This test is available on both your phone and the Eduvo web portal.
            Once you start on one platform you must finish there.
          </Text>

          <TouchableOpacity
            style={platformModalStyles.optionBtn}
            onPress={onPhone}
            accessibilityRole="button"
            accessibilityLabel="Continue on phone"
          >
            <Text style={platformModalStyles.optionIcon}>📱</Text>
            <View style={platformModalStyles.optionText}>
              <Text style={platformModalStyles.optionTitle}>Continue on Phone</Text>
              <Text style={platformModalStyles.optionDesc}>Take the test right here in the app</Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={[platformModalStyles.optionBtn, platformModalStyles.optionBtnWeb]}
            onPress={onWeb}
            accessibilityRole="button"
            accessibilityLabel="Continue on web"
          >
            <Text style={platformModalStyles.optionIcon}>💻</Text>
            <View style={platformModalStyles.optionText}>
              <Text style={platformModalStyles.optionTitle}>Continue on Web</Text>
              <Text style={platformModalStyles.optionDesc}>
                Opens eduvo.vercel.app in your browser — log in and the test will be there
              </Text>
            </View>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const platformModalStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 28,
    paddingBottom: 40,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: '800',
    color: '#111827',
    textAlign: 'center',
    marginBottom: 8,
    lineHeight: 25,
  },
  subtitle: {
    fontSize: 13,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
  },
  optionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F3F4F6',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 2,
    borderColor: '#E5E7EB',
  },
  optionBtnWeb: {
    backgroundColor: '#EFF6FF',
    borderColor: '#BFDBFE',
  },
  optionIcon: { fontSize: 28, marginRight: 14 },
  optionText: { flex: 1 },
  optionTitle: { fontSize: 15, fontWeight: '700', color: '#111827', marginBottom: 2 },
  optionDesc: { fontSize: 12, color: '#6B7280', lineHeight: 18 },
});

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

// ── MCQ Breakdown with reasoning ─────────────────────────────────────────────

function MCQBreakdown({ mcqAnswers }: { mcqAnswers: ResultAnswer[] }) {
  const [expandedCorrect, setExpandedCorrect] = useState<Set<string>>(new Set());

  const toggleCorrect = (id: string) => {
    setExpandedCorrect((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  };

  return (
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

        const hasReasoning = Boolean(ans.reasoning);
        const hasExplanation = Boolean(ans.explanation);
        const isExpanded = expandedCorrect.has(ans.question_id);

        return (
          <View
            key={ans.question_id}
            style={[resStyles.qRow, correct ? resStyles.qRowCorrect : resStyles.qRowWrong]}
          >
            <View style={resStyles.qRowHeader}>
              <Text style={resStyles.qNum}>Q{idx + 1}</Text>
              <Text style={correct ? resStyles.tick : resStyles.cross}>
                {skipped ? '—' : correct ? '✓ Correct' : '✗ Incorrect'}
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
            {skipped && <Text style={resStyles.qYourAnswer}>Not answered</Text>}

            {!correct && ans.correct_option && (
              <Text style={resStyles.qCorrectAnswer}>
                ✓ Correct answer:{' '}
                <Text style={resStyles.ansCorrect}>
                  {ans.correct_option.toUpperCase()} — {optionText(ans.correct_option)}
                </Text>
              </Text>
            )}

            {/* For INCORRECT answers — always expanded reasoning */}
            {!correct && (hasReasoning || hasExplanation) && (
              <View style={resStyles.reasoningBox}>
                <Text style={resStyles.reasoningTitle}>Understanding this question</Text>
                {hasReasoning && (
                  <Text style={resStyles.reasoningText}>{ans.reasoning}</Text>
                )}
                {hasExplanation && (
                  <Text style={resStyles.explanationLine}>{ans.explanation}</Text>
                )}
              </View>
            )}

            {/* For CORRECT answers — collapsible reasoning */}
            {correct && hasReasoning && (
              <TouchableOpacity
                style={resStyles.whyCorrectToggle}
                onPress={() => toggleCorrect(ans.question_id)}
                accessibilityRole="button"
                accessibilityLabel={isExpanded ? 'Collapse explanation' : 'Why is this correct?'}
              >
                <Text style={resStyles.whyCorrectToggleText}>
                  {isExpanded ? '▲ Hide explanation' : '▼ Why is this correct?'}
                </Text>
              </TouchableOpacity>
            )}
            {correct && hasReasoning && isExpanded && (
              <View style={resStyles.reasoningBox}>
                <Text style={resStyles.reasoningText}>{ans.reasoning}</Text>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

// ── Post-mortem summary ────────────────────────────────────────────────────────

function PostMortemSummary({
  mcqAnswers,
  timeTakenSeconds,
  testTitle,
}: {
  mcqAnswers: ResultAnswer[];
  timeTakenSeconds: number | null;
  testTitle: string;
}) {
  const total   = mcqAnswers.length;
  const correct = mcqAnswers.filter((a) => a.is_correct).length;
  const skipped = mcqAnswers.filter((a) => a.selected_option == null).length;
  const wrong   = total - correct - skipped;
  const scorePct = total > 0 ? Math.round((correct / total) * 100) : 0;
  const avgTimePerQ =
    timeTakenSeconds !== null && total > 0
      ? Math.round(timeTakenSeconds / total)
      : null;

  const ringColor = scorePct >= 75 ? '#22C55E' : scorePct >= 50 ? '#F59E0B' : '#EF4444';

  let verdict = ''; let verdictEmoji = '';
  if (scorePct >= 90)      { verdict = 'Outstanding!';      verdictEmoji = '🏆'; }
  else if (scorePct >= 75) { verdict = 'Great work!';       verdictEmoji = '🎉'; }
  else if (scorePct >= 50) { verdict = 'Good effort!';      verdictEmoji = '👍'; }
  else if (scorePct >= 30) { verdict = 'Keep practising';   verdictEmoji = '💪'; }
  else                     { verdict = 'Needs improvement'; verdictEmoji = '📚'; }

  const statItems = [
    { label: 'Correct', value: String(correct), color: '#22C55E', bg: '#F0FDF4' },
    { label: 'Wrong',   value: String(wrong),   color: '#EF4444', bg: '#FEF2F2' },
    { label: 'Skipped', value: String(skipped), color: '#9CA3AF', bg: '#F3F4F6' },
    ...(avgTimePerQ !== null
      ? [{ label: 'Avg/Q', value: `${avgTimePerQ}s`, color: '#6366F1', bg: '#EEF2FF' }]
      : []),
  ];

  return (
    <View style={pmStyles.container}>
      <View style={pmStyles.ringWrap}>
        <View style={[pmStyles.ring, { borderColor: ringColor }]}>
          <Text style={[pmStyles.ringPct, { color: ringColor }]}>{scorePct}%</Text>
          <Text style={pmStyles.ringLabel}>{correct}/{total} correct</Text>
        </View>
        <Text style={pmStyles.verdict}>{verdictEmoji} {verdict}</Text>
        <Text style={pmStyles.testName}>{testTitle}</Text>
      </View>
      <View style={pmStyles.statRow}>
        {statItems.map((s) => (
          <View key={s.label} style={[pmStyles.statCard, { backgroundColor: s.bg }]}>
            <Text style={[pmStyles.statValue, { color: s.color }]}>{s.value}</Text>
            <Text style={pmStyles.statLabel}>{s.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const pmStyles = StyleSheet.create({
  container: { marginBottom: 24 },
  ringWrap: { alignItems: 'center', marginBottom: 20 },
  ring: {
    width: 140, height: 140, borderRadius: 70, borderWidth: 8,
    justifyContent: 'center', alignItems: 'center', marginBottom: 12,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.08, shadowRadius: 10, elevation: 4,
  },
  ringPct: { fontSize: 36, fontWeight: '800' },
  ringLabel: { fontSize: 12, color: '#6B7280', marginTop: 2, fontWeight: '500' },
  verdict: { fontSize: 20, fontWeight: '700', color: '#111827', marginBottom: 4 },
  testName: { fontSize: 13, color: '#9CA3AF', textAlign: 'center' },
  statRow: { flexDirection: 'row', gap: 10 },
  statCard: {
    flex: 1, borderRadius: 12, paddingVertical: 14, alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 3, elevation: 1,
  },
  statValue: { fontSize: 22, fontWeight: '800' },
  statLabel: { fontSize: 11, color: '#6B7280', fontWeight: '500', marginTop: 3 },
});

// ── Results screen ────────────────────────────────────────────────────────────

function ResultsScreen({
  testTitle,
  results,
  integrityResult,
  timeTakenSeconds,
  onBack,
}: {
  testTitle: string;
  results: ResultData;
  integrityResult: IntegrityApiResult | null;
  timeTakenSeconds: number | null;
  onBack: () => void;
}) {
  const mcqAnswers   = results.answers.filter((a) => a.question_type === 'mcq');
  const theoryAnswers = results.answers.filter((a) => a.question_type === 'theory');
  const totalMcqMarks = mcqAnswers.reduce((s, a) => s + a.marks, 0);
  const correctCount  = mcqAnswers.filter((a) => a.is_correct).length;

  // Entrance animation
  const fadeAnim  = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;

  useEffect(() => {
    // Haptic feedback based on score
    const scorePct = totalMcqMarks > 0
      ? Math.round(((results.mcq_score ?? 0) / totalMcqMarks) * 100)
      : 0;
    if (scorePct >= 75) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else if (scorePct >= 50) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } else {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    // Fade + slide in
    Animated.parallel([
      Animated.timing(fadeAnim,  { toValue: 1, duration: 400, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 400, useNativeDriver: true }),
    ]).start();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Animated.ScrollView
      style={[resStyles.container, { opacity: fadeAnim }]}
      contentContainerStyle={resStyles.content}
    >
      <Animated.View style={{ transform: [{ translateY: slideAnim }] }}>
        <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />

        {/* Post-mortem ring + stat cards */}
        {mcqAnswers.length > 0 && (
          <PostMortemSummary
            mcqAnswers={mcqAnswers}
            timeTakenSeconds={timeTakenSeconds}
            testTitle={testTitle}
          />
        )}

        {/* Theory score card (only shown when theory exists alongside MCQ) */}
        {theoryAnswers.length > 0 && (
          <View style={resStyles.scoreCard}>
            <View style={resStyles.scoreBlock}>
              <Text style={resStyles.scoreLabel}>MCQ Score</Text>
              <Text style={resStyles.scoreValue}>
                {results.mcq_score ?? 0}
                <Text style={resStyles.scoreMax}> / {totalMcqMarks}</Text>
              </Text>
              <Text style={resStyles.scoreSubtext}>{correctCount} of {mcqAnswers.length} correct</Text>
            </View>
            <View style={resStyles.scoreDivider} />
            <View style={resStyles.scoreBlock}>
              <Text style={resStyles.scoreLabel}>Theory</Text>
              <Text style={[resStyles.scoreValue, resStyles.scorePending]}>
                {results.total_score_pending ? 'Pending' : results.total_score ?? '—'}
              </Text>
              <Text style={resStyles.scoreSubtext}>Awaiting teacher review</Text>
            </View>
          </View>
        )}

        {/* Integrity score card */}
        {integrityResult !== null && (
          <>
            <View style={resStyles.integrityCard}>
              <View style={resStyles.integrityRow}>
                <Text style={resStyles.integrityLabel}>Integrity Score</Text>
                <Text style={[
                  resStyles.integrityScore,
                  integrityResult.integrity_score >= 80 ? resStyles.integrityGreen
                    : integrityResult.integrity_score >= 60 ? resStyles.integrityAmber
                    : resStyles.integrityRed,
                ]}>
                  {integrityResult.integrity_score}/100
                </Text>
              </View>
              <View style={resStyles.integritySub}>
                <Text style={resStyles.integritySubText}>
                  Exits: {integrityResult.exit_count} · Time outside: {integrityResult.total_exit_duration_seconds}s
                </Text>
              </View>
            </View>
            {integrityResult.is_suspicious && (
              <View style={resStyles.integrityWarning}>
                <Text style={resStyles.integrityWarningText}>
                  ⚠️ Your activity during this test has been flagged for teacher review.
                </Text>
              </View>
            )}
          </>
        )}

        {/* MCQ per-question breakdown */}
        {mcqAnswers.length > 0 && <MCQBreakdown mcqAnswers={mcqAnswers} />}

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
      </Animated.View>
    </Animated.ScrollView>
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
  // Reasoning / explanation boxes
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
  whyCorrectToggle: { marginTop: 8, alignSelf: 'flex-start' },
  whyCorrectToggleText: { fontSize: 13, fontWeight: '600', color: '#1D4ED8' },
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

  // Integrity score
  integrityCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  integrityRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  integrityLabel: { fontSize: 14, color: '#6B7280', fontWeight: '600' },
  integrityScore: { fontSize: 20, fontWeight: '800' },
  integrityGreen: { color: '#15803D' },
  integrityAmber: { color: '#D97706' },
  integrityRed:   { color: '#DC2626' },
  integritySub: {},
  integritySubText: { fontSize: 12, color: '#9CA3AF' },
  integrityWarning: {
    backgroundColor: '#FEF3C7',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderLeftWidth: 4,
    borderLeftColor: '#D97706',
  },
  integrityWarningText: { fontSize: 13, color: '#92400E', fontWeight: '600', lineHeight: 19 },
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
  const [showPlatformModal, setShowPlatformModal] = useState(false);
  const [results, setResults] = useState<ResultData | null>(null);
  const [integrityResult, setIntegrityResult] = useState<IntegrityApiResult | null>(null);
  const [timeTakenSeconds, setTimeTakenSeconds] = useState<number | null>(null);
  const testStartWallTime = useRef<number | null>(null);

  // ── Integrity tracking ──────────────────────────────────────────────────────
  const { startTracking, finaliseTracking } = useTestIntegrity();

  // ── Timer ───────────────────────────────────────────────────────────────────
  const hasTimeLimit = test.time_limit_minutes > 0;

  // handleSubmitRef and phaseRef are declared below, but useRef values are
  // stable objects — the .current assignment happens before any effect fires,
  // so reading them inside the onExpire callback (which fires asynchronously)
  // always gets the latest values.
  const handleSubmitRef = useRef<(auto?: boolean) => Promise<void>>(async () => {});
  const phaseRef = useRef<Phase>('pre');

  const { secondsLeft, setSecondsLeft } = useCountdown(
    null,
    () => {
      // Only auto-submit if the test is actually active (ref is always current).
      if (phaseRef.current === 'active') {
        void handleSubmitRef.current(true);
      }
    }
  );

  // Keep a ref to answers for use in AppState handler without stale closure
  const answersRef = useRef<Answer[]>([]);
  const attemptIdRef = useRef<string | null>(null);
  const currentIndexRef = useRef(0);
  const secondsLeftRef = useRef<number | null>(null);
  // Wall-clock time when the timer was last set, paired with seconds_remaining
  // at that moment — used by the AppState foreground handler to recompute
  // elapsed time using the device's own monotonic clock (not server clock).
  const startedAtRef = useRef<string | null>(null);
  const timeLimitSecondsRef = useRef<number | null>(null);
  const timerSetAtRef = useRef<number | null>(null);
  const timerSecondsAtSetRef = useRef<number | null>(null);

  useEffect(() => { answersRef.current = answers; }, [answers]);
  useEffect(() => { attemptIdRef.current = attemptId; }, [attemptId]);
  useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);
  useEffect(() => { secondsLeftRef.current = secondsLeft; }, [secondsLeft]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // ── AppState: correct timer on foreground; save progress on background ──────
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'background' || state === 'inactive') {
        // Save progress when leaving
        const aid = attemptIdRef.current;
        if (aid && phaseRef.current === 'active') {
          saveProgress(
            test.id,
            aid,
            answersRef.current,
            currentIndexRef.current,
            null
          ).catch(() => {/* silent */});
        }
      } else if (state === 'active') {
        // App came back to foreground.
        // Recompute remaining time using the device's own clock (timerSetAtRef),
        // NOT the server's started_at — avoids server/client clock skew issues.
        if (
          phaseRef.current === 'active' &&
          timerSetAtRef.current !== null &&
          timerSecondsAtSetRef.current !== null
        ) {
          const elapsedSinceSet = Math.floor((Date.now() - timerSetAtRef.current) / 1000);
          const remaining = timerSecondsAtSetRef.current - elapsedSinceSet;
          if (remaining <= 0) {
            // Time ran out in background — submit now
            void handleSubmitRef.current(true);
          } else {
            setSecondsLeft(remaining);
            // Update baseline so next foreground return computes from here
            timerSetAtRef.current = Date.now();
            timerSecondsAtSetRef.current = remaining;
          }
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
        // Fetch results directly by test id — never show the pre/start screen for completed tests.
        // Try /results/by-test/:testId first (preferred — no attempt_id needed).
        // If that fails, fall back to /results/:attemptId via the 409 from attempt/start.
        // Under NO circumstances should we set phase='pre' for a completed test.
        try {
          const resResponse = await apiClient.get(`/api/tests/results/by-test/${test.id}`);
          const resultData = resResponse.data.data as ResultData;
          setResults(resultData);
          setLoadingResults(false);
          setPhase('results');
          return;
        } catch {
          // /results/by-test/ failed — try to get the attempt_id via the start endpoint (returns 409)
        }

        try {
          // This will 409 for a submitted test, giving us the attempt_id
          await apiClient.post('/api/tests/attempt/start', { test_id: test.id });
          // If start actually succeeded (shouldn't happen for completed tests),
          // do NOT drop to pre-screen — still show error to avoid confusing the student.
          setLoadingResults(false);
          setPhase('error' as Phase);
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
              // fall through to error state
            }
          }
          // All fetches failed — show error, never pre-screen for a completed test
          setLoadingResults(false);
          setPhase('error' as Phase);
        }
        return;
      }

      // Not completed — no resume logic needed (server always resets to fresh start)
    };

    void checkAttemptStatus();
  }, [test.id, test.attempt_status]);

  const handleStart = useCallback(async (platform: 'mobile' | 'web' = 'mobile') => {
    setStarting(true);
    try {
      const res = await apiClient.post('/api/tests/attempt/start', { test_id: test.id, platform });
      const payload = res.data.data as {
        attempt_id: string;
        time_limit_minutes: number;
        started_at: string;
        seconds_remaining: number | null;
        resumed: boolean;
        questions: Question[];
      };

      const qs = payload.questions;
      setQuestions(qs);
      setAttemptId(payload.attempt_id);

      // Initialise answer slots (one per question, empty)
      setAnswers(qs.map((q) => ({ question_id: q.id })));

      // The server always resets the attempt to a fresh start.
      // Clear any stale local progress.
      await clearProgress(test.id);

      // Use seconds_remaining from the server — computed server-side so it is
      // not affected by client clock skew. A phone with a wrong clock computing
      // elapsed from started_at would get remaining ≈ 0 and instantly auto-submit.
      if (hasTimeLimit) {
        const safeSeconds = Math.max(30, payload.seconds_remaining ?? payload.time_limit_minutes * 60);
        // Record the device wall-clock time paired with safeSeconds so the
        // AppState foreground handler can recompute elapsed using the device's
        // own monotonic clock (no server clock comparison needed).
        timerSetAtRef.current = Date.now();
        timerSecondsAtSetRef.current = safeSeconds;
        setSecondsLeft(safeSeconds);
      }

      setPhase('integrity_warning');
      testStartWallTime.current = Date.now();
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
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

  // ── Integrity warning acknowledged — begin monitoring and enter test ────────
  const handleIntegrityAcknowledge = useCallback(() => {
    startTracking();
    setPhase('active');
  }, [startTracking]);

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

      if (testStartWallTime.current !== null) {
        setTimeTakenSeconds(Math.round((Date.now() - testStartWallTime.current) / 1000));
      }

      // ── Call integrity API after successful submission ──────────────────────
      try {
        const integrityData = finaliseTracking();
        const intRes = await apiClient.post('/api/tests/student/test-integrity', {
          daily_test_attempt_id:       attemptId,
          exit_count:                  integrityData.exit_count,
          return_count:                integrityData.return_count,
          total_exit_duration_seconds: integrityData.total_exit_duration_seconds,
          longest_single_exit_seconds: integrityData.longest_single_exit_seconds,
        });
        setIntegrityResult(intRes.data.data as IntegrityApiResult);
      } catch {
        // Integrity logging is non-critical — don't block showing results
      }

      setPhase('results');
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? (err instanceof Error ? err.message : 'Submission failed. Please retry.');
      setSubmitError(msg);
      setPhase('active'); // return to active so student can retry
    }
  }, [attemptId, test.id]);

  // Keep handleSubmitRef always pointing at the latest handleSubmit.
  handleSubmitRef.current = handleSubmit;

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

  // ── Render: error loading results for a completed test ───────────────────────
  if (phase === 'error') {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F9FAFB', padding: 24 }}>
        <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
        <Text style={{ fontSize: 40, marginBottom: 16 }}>⚠️</Text>
        <Text style={{ fontSize: 16, fontWeight: '700', color: '#111827', marginBottom: 8, textAlign: 'center' }}>
          Could not load results
        </Text>
        <Text style={{ fontSize: 14, color: '#6B7280', textAlign: 'center', marginBottom: 24 }}>
          There was a problem fetching your results. Please go back and try again.
        </Text>
        <TouchableOpacity
          style={{ backgroundColor: '#1D4ED8', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 32 }}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text style={{ color: '#FFFFFF', fontWeight: '700', fontSize: 15 }}>← Back to Tests</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Render: pre-test ────────────────────────────────────────────────────────
  // Safety guard: never show the start/pre screen for a completed test even if
  // state is somehow inconsistent — show loading spinner while results fetch resolves.
  if (phase === 'pre') {
    if (test.attempt_status === 'completed') {
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
    return (
      <>
        <PreTestScreen
          test={test}
          onStart={() => {
            // Show platform choice modal only if web is allowed AND not already in-progress
            if (test.allow_web_attempt && test.attempt_status !== 'in_progress') {
              setShowPlatformModal(true);
            } else {
              // Phone-only test or resuming — go straight to mobile attempt
              handleStart('mobile');
            }
          }}
          starting={starting}
          isResume={hasActiveAttempt}
        />
        <PlatformChoiceModal
          visible={showPlatformModal}
          onPhone={() => {
            setShowPlatformModal(false);
            handleStart('mobile');
          }}
          onWeb={() => {
            setShowPlatformModal(false);
            Linking.openURL('https://eduvo.vercel.app/student/login').catch(() =>
              Alert.alert('Could not open browser', 'Please open https://eduvo.vercel.app/student/login manually.')
            );
          }}
        />
      </>
    );
  }

  // ── Render: integrity warning modal (shown before test begins) ──────────────
  if (phase === 'integrity_warning') {
    return (
      <View style={{ flex: 1, backgroundColor: '#F9FAFB' }}>
        <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
        <IntegrityWarningModal visible onConfirm={handleIntegrityAcknowledge} />
      </View>
    );
  }

  // ── Render: results ─────────────────────────────────────────────────────────
  if (phase === 'results' && results) {
    return (
      <ResultsScreen
        testTitle={test.title}
        results={results}
        integrityResult={integrityResult}
        timeTakenSeconds={timeTakenSeconds}
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
