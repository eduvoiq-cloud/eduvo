/**
 * RecoveryTestAttemptScreen
 *
 * Same flow as TestAttemptScreen but uses /api/recovery/attempt/* endpoints.
 * Reuses exported components from TestAttemptScreen to stay DRY.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  ActivityIndicator, StatusBar, Alert, KeyboardAvoidingView, Platform, Animated,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import apiClient from '../../api/client';
import { StudentStackParamList } from '../../navigation/AppNavigator';
import {
  IntegrityWarningModal,
  useTestIntegrity,
} from '../main/TestAttemptScreen';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Question {
  question: string;
  options: string[];
  difficulty: string;
  topic: string;
}

type OptionKey = 'a' | 'b' | 'c' | 'd';
const OPTION_KEYS: OptionKey[] = ['a', 'b', 'c', 'd'];
const OPTION_DISPLAY: Record<OptionKey, string> = { a: 'A', b: 'B', c: 'C', d: 'D' };

interface Answer { question_index: number; selected_option: OptionKey | null }

interface ResultData {
  score: number;
  total_questions: number;
  percentage: number;
}

type Phase = 'pre' | 'integrity_warning' | 'active' | 'submitting' | 'results' | 'error';

// ── Navigation types ──────────────────────────────────────────────────────────

interface Props {
  navigation: StackNavigationProp<StudentStackParamList, 'MonthlyRecoveryTestAttempt'>;
  route: RouteProp<StudentStackParamList, 'MonthlyRecoveryTestAttempt'>;
}

// ── Progress key ──────────────────────────────────────────────────────────────

const progressKey = (testId: string) => `eduvo_recovery_progress_${testId}`;

// ── Countdown hook (simple) ───────────────────────────────────────────────────

function useCountdown(onExpire: () => void) {
  const [secondsLeft, setSecondsLeftState] = useState<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  const stop = useCallback(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  }, []);

  const setSecondsLeft = useCallback((n: number | null) => {
    stop();
    if (!n || n <= 0) { setSecondsLeftState(null); return; }
    setSecondsLeftState(n);
    intervalRef.current = setInterval(() => {
      setSecondsLeftState((prev) => {
        if (!prev || prev <= 1) { stop(); setTimeout(() => onExpireRef.current(), 0); return 0; }
        return prev - 1;
      });
    }, 1000);
  }, [stop]);

  useEffect(() => () => stop(), [stop]);
  return { secondsLeft, setSecondsLeft };
}

function formatTime(s: number): string {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ── Results screen ────────────────────────────────────────────────────────────

function ResultsView({ result, onBack }: { result: ResultData; onBack: () => void }) {
  const pct = result.percentage;
  const ringColor = pct >= 75 ? '#22C55E' : pct >= 50 ? '#F59E0B' : '#EF4444';
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (pct >= 75) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }).start();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Animated.ScrollView style={[resStyles.container, { opacity: fadeAnim }]} contentContainerStyle={resStyles.content}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
      <View style={resStyles.ringWrap}>
        <View style={[resStyles.ring, { borderColor: ringColor }]}>
          <Text style={[resStyles.ringPct, { color: ringColor }]}>{pct}%</Text>
          <Text style={resStyles.ringLabel}>{result.score}/{result.total_questions}</Text>
        </View>
        <Text style={resStyles.title}>Recovery Test Complete</Text>
      </View>
      <TouchableOpacity style={resStyles.backBtn} onPress={onBack} accessibilityRole="button">
        <Text style={resStyles.backBtnText}>← Back</Text>
      </TouchableOpacity>
    </Animated.ScrollView>
  );
}

const resStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  content: { padding: 24, paddingBottom: 48, alignItems: 'center' },
  ringWrap: { alignItems: 'center', marginBottom: 32, marginTop: 20 },
  ring: {
    width: 140, height: 140, borderRadius: 70, borderWidth: 8,
    justifyContent: 'center', alignItems: 'center', marginBottom: 16,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.08, shadowRadius: 10, elevation: 4,
  },
  ringPct: { fontSize: 36, fontWeight: '800' },
  ringLabel: { fontSize: 12, color: '#6B7280', marginTop: 2 },
  title: { fontSize: 20, fontWeight: '700', color: '#111827' },
  backBtn: { width: '100%', backgroundColor: '#1D4ED8', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  backBtnText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
});

// ── Main component ────────────────────────────────────────────────────────────

export default function RecoveryTestAttemptScreen({ route, navigation }: Props) {
  const { testId } = route.params;

  const [phase, setPhase] = useState<Phase>('pre');
  const [starting, setStarting] = useState(false);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [timeLimitMinutes, setTimeLimitMinutes] = useState<number | null>(null);
  const [result, setResult] = useState<ResultData | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const testStartWall = useRef<number | null>(null);

  const { startTracking } = useTestIntegrity();
  const submitRef = useRef<(auto?: boolean) => Promise<void>>(async () => {});
  const phaseRef = useRef<Phase>('pre');
  const answersRef = useRef<Answer[]>([]);

  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { answersRef.current = answers; }, [answers]);

  const hasTimeLimit = (timeLimitMinutes ?? 0) > 0;
  const { secondsLeft, setSecondsLeft } = useCountdown(() => {
    if (phaseRef.current === 'active') void submitRef.current(true);
  });

  // ── Start test ────────────────────────────────────────────────────────────

  const handleStart = useCallback(async () => {
    setStarting(true);
    try {
      const res = await apiClient.post('/api/recovery/attempt/start', { recovery_test_id: testId });
      const payload = res.data.data as {
        attempt_id: string; time_limit_minutes: number | null;
        questions: Question[];
      };
      setQuestions(payload.questions);
      setAttemptId(payload.attempt_id);
      setTimeLimitMinutes(payload.time_limit_minutes ?? null);
      setAnswers(payload.questions.map((_, i) => ({ question_index: i, selected_option: null })));
      await AsyncStorage.removeItem(progressKey(testId));
      if (payload.time_limit_minutes && payload.time_limit_minutes > 0) {
        setSecondsLeft(payload.time_limit_minutes * 60);
      }
      setPhase('integrity_warning');
      testStartWall.current = Date.now();
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch (err: unknown) {
      Alert.alert('Could not start test', (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Failed to start test');
    } finally {
      setStarting(false);
    }
  }, [testId, setSecondsLeft]);

  // ── Submit ────────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async (_auto = false) => {
    if (!attemptId) return;
    setShowSubmitConfirm(false);
    setPhase('submitting');
    setSubmitError(null);

    const currentAnswers = answersRef.current;
    const payload = currentAnswers.map((a) => ({
      question_id: String(a.question_index),
      selected_option: a.selected_option ?? undefined,
    }));

    try {
      const res = await apiClient.post('/api/recovery/attempt/submit', {
        attempt_id: attemptId,
        answers: payload,
      });
      const r = res.data.data as ResultData;
      setResult(r);
      await AsyncStorage.removeItem(progressKey(testId));
      setPhase('results');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Submission failed';
      setSubmitError(msg);
      setPhase('active');
    }
  }, [attemptId, testId]);

  submitRef.current = handleSubmit;

  const answeredCount = answers.filter((a) => a.selected_option !== null).length;
  const timerWarn = secondsLeft !== null && secondsLeft <= 60;
  const timerCritical = secondsLeft !== null && secondsLeft <= 30;

  // ── Phase renders ─────────────────────────────────────────────────────────

  if (phase === 'results' && result) {
    return <ResultsView result={result} onBack={() => navigation.goBack()} />;
  }

  if (phase === 'integrity_warning') {
    return (
      <View style={{ flex: 1, backgroundColor: '#F9FAFB' }}>
        <IntegrityWarningModal visible onConfirm={() => { startTracking(); setPhase('active'); }} />
      </View>
    );
  }

  if (phase === 'submitting') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1D4ED8" />
        <Text style={styles.submittingText}>Submitting…</Text>
      </View>
    );
  }

  if (phase === 'pre') {
    return (
      <ScrollView style={styles.preContainer} contentContainerStyle={styles.preContent}>
        <StatusBar barStyle="dark-content" backgroundColor="#F9FAFB" />
        <View style={styles.iconWrap}><Text style={styles.icon}>📝</Text></View>
        <Text style={styles.preTitle}>Recovery Test</Text>
        <View style={styles.detailsCard}>
          <View style={styles.detailRow}><Text style={styles.detailLabel}>Time Limit</Text><Text style={styles.detailValue}>{timeLimitMinutes ? `${timeLimitMinutes} min` : 'No limit'}</Text></View>
        </View>
        <TouchableOpacity
          style={[styles.startBtn, starting && styles.startBtnDisabled]}
          onPress={handleStart}
          disabled={starting}
          accessibilityRole="button"
        >
          {starting ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.startBtnText}>Start Test →</Text>}
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // ── Active test ────────────────────────────────────────────────────────────

  const q = questions[currentIndex];
  if (!q) return null;

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar barStyle="light-content" backgroundColor="#1D4ED8" />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Text style={styles.headerTitle} numberOfLines={1}>Recovery Test</Text>
          {secondsLeft !== null && (
            <View style={[styles.timerBadge, timerWarn && styles.timerWarn, timerCritical && styles.timerCritical]}>
              <Text style={[styles.timerText, timerWarn && styles.timerTextWarn]}>⏱ {formatTime(secondsLeft)}</Text>
            </View>
          )}
        </View>
        <Text style={styles.progress}>Question {currentIndex + 1} of {questions.length}</Text>
      </View>

      {/* Question pills */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pillsScroll} contentContainerStyle={styles.pillsContent}>
        {questions.map((_, i) => {
          const answered = answers[i]?.selected_option !== null;
          const current = i === currentIndex;
          return (
            <TouchableOpacity key={i} style={[styles.pill, answered && styles.pillAnswered, current && styles.pillCurrent]}
              onPress={() => setCurrentIndex(i)} accessibilityRole="button">
              <Text style={[styles.pillText, (answered || current) && styles.pillTextActive]}>{i + 1}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Error banner */}
      {submitError && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>⚠️ {submitError}</Text>
          <TouchableOpacity onPress={() => handleSubmit()} accessibilityRole="button">
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Question body */}
      <ScrollView style={styles.questionScroll} contentContainerStyle={styles.questionScrollContent}>
        <View style={styles.qContainer}>
          <Text style={styles.qText}>{q.question}</Text>
          <View style={styles.optionsContainer}>
            {q.options.map((opt, oi) => {
              const key = OPTION_KEYS[oi];
              const selected = answers[currentIndex]?.selected_option === key;
              return (
                <TouchableOpacity
                  key={oi}
                  style={[styles.optionBtn, selected && styles.optionBtnSelected]}
                  onPress={() => setAnswers((prev) => prev.map((a, ai) => ai === currentIndex ? { ...a, selected_option: key } : a))}
                  activeOpacity={0.75}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                >
                  <View style={[styles.optionBadge, selected && styles.optionBadgeSelected]}>
                    <Text style={[styles.optionBadgeText, selected && styles.optionBadgeTextSelected]}>{OPTION_DISPLAY[key]}</Text>
                  </View>
                  <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{opt}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </ScrollView>

      {/* Footer */}
      <View style={styles.footer}>
        <TouchableOpacity style={[styles.navBtn, currentIndex === 0 && styles.navBtnDisabled]}
          disabled={currentIndex === 0} onPress={() => setCurrentIndex((i) => Math.max(0, i - 1))} accessibilityRole="button">
          <Text style={[styles.navBtnText, currentIndex === 0 && styles.navBtnTextDisabled]}>← Prev</Text>
        </TouchableOpacity>

        {currentIndex === questions.length - 1 ? (
          <TouchableOpacity style={styles.submitBtn} onPress={() => setShowSubmitConfirm(true)} accessibilityRole="button">
            <Text style={styles.submitBtnText}>Submit</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.navBtn} onPress={() => setCurrentIndex((i) => Math.min(questions.length - 1, i + 1))} accessibilityRole="button">
            <Text style={styles.navBtnText}>Next →</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Submit confirm */}
      {showSubmitConfirm && (
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Submit Test?</Text>
            <Text style={styles.modalBody}>{answeredCount} of {questions.length} answered.</Text>
            {answeredCount < questions.length && <Text style={styles.modalHint}>Unanswered questions receive 0 marks.</Text>}
            <View style={styles.modalBtns}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setShowSubmitConfirm(false)} accessibilityRole="button">
                <Text style={styles.modalCancelText}>Go Back</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirm} onPress={() => handleSubmit()} accessibilityRole="button">
                <Text style={styles.modalConfirmText}>Submit</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F9FAFB' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F9FAFB', gap: 16 },
  submittingText: { fontSize: 16, color: '#6B7280', fontWeight: '500' },

  // Pre-test
  preContainer: { flex: 1, backgroundColor: '#F9FAFB' },
  preContent: { padding: 24, paddingBottom: 48, alignItems: 'center' },
  iconWrap: { width: 88, height: 88, borderRadius: 44, backgroundColor: '#DBEAFE', justifyContent: 'center', alignItems: 'center', marginBottom: 20 },
  icon: { fontSize: 40 },
  preTitle: { fontSize: 24, fontWeight: '800', color: '#111827', marginBottom: 24 },
  detailsCard: { width: '100%', backgroundColor: '#FFFFFF', borderRadius: 14, padding: 16, marginBottom: 28, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  detailLabel: { fontSize: 14, color: '#6B7280', fontWeight: '500' },
  detailValue: { fontSize: 14, color: '#111827', fontWeight: '700' },
  startBtn: { width: '100%', backgroundColor: '#1D4ED8', borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  startBtnDisabled: { opacity: 0.6 },
  startBtnText: { fontSize: 17, fontWeight: '700', color: '#FFFFFF' },

  // Active header
  header: { backgroundColor: '#1D4ED8', paddingTop: 16, paddingBottom: 12, paddingHorizontal: 16 },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  headerTitle: { fontSize: 16, fontWeight: '700', color: '#FFFFFF', flex: 1, marginRight: 12 },
  timerBadge: { backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  timerWarn: { backgroundColor: '#FEF3C7' },
  timerCritical: { backgroundColor: '#FEE2E2' },
  timerText: { fontSize: 14, fontWeight: '700', color: '#FFFFFF' },
  timerTextWarn: { color: '#92400E' },
  progress: { fontSize: 13, color: 'rgba(255,255,255,0.75)', fontWeight: '500' },

  // Pills
  pillsScroll: { maxHeight: 52, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  pillsContent: { paddingHorizontal: 16, paddingVertical: 8, gap: 8, flexDirection: 'row' },
  pill: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#E5E7EB', justifyContent: 'center', alignItems: 'center' },
  pillAnswered: { backgroundColor: '#22C55E' },
  pillCurrent: { backgroundColor: '#1D4ED8' },
  pillText: { fontSize: 13, fontWeight: '600', color: '#6B7280' },
  pillTextActive: { color: '#FFFFFF' },

  // Error
  errorBanner: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#FEE2E2', paddingHorizontal: 16, paddingVertical: 10 },
  errorText: { fontSize: 13, color: '#DC2626', flex: 1 },
  retryText: { fontSize: 13, fontWeight: '700', color: '#DC2626', marginLeft: 12 },

  // Question
  questionScroll: { flex: 1 },
  questionScrollContent: { flexGrow: 1, paddingBottom: 16 },
  qContainer: { flex: 1, padding: 20 },
  qText: { fontSize: 18, fontWeight: '600', color: '#111827', lineHeight: 28, marginBottom: 24 },
  optionsContainer: { gap: 12 },
  optionBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 12, borderWidth: 2, borderColor: '#E5E7EB', padding: 14, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 3, elevation: 1 },
  optionBtnSelected: { borderColor: '#1D4ED8', backgroundColor: '#EFF6FF' },
  optionBadge: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#F3F4F6', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  optionBadgeSelected: { backgroundColor: '#1D4ED8' },
  optionBadgeText: { fontSize: 13, fontWeight: '700', color: '#6B7280' },
  optionBadgeTextSelected: { color: '#FFFFFF' },
  optionText: { fontSize: 15, color: '#374151', flex: 1, lineHeight: 22 },
  optionTextSelected: { color: '#1E3A8A', fontWeight: '600' },

  // Footer
  footer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: '#FFFFFF', borderTopWidth: 1, borderTopColor: '#F3F4F6', gap: 12 },
  navBtn: { flex: 1, backgroundColor: '#F3F4F6', borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  navBtnDisabled: { opacity: 0.4 },
  navBtnText: { fontSize: 15, fontWeight: '600', color: '#374151' },
  navBtnTextDisabled: { color: '#9CA3AF' },
  submitBtn: { flex: 1, backgroundColor: '#1D4ED8', borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  submitBtnText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },

  // Submit confirm modal
  modalOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalCard: { width: '100%', backgroundColor: '#FFFFFF', borderRadius: 16, padding: 24, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 12, elevation: 8 },
  modalTitle: { fontSize: 20, fontWeight: '800', color: '#111827', marginBottom: 12 },
  modalBody: { fontSize: 15, color: '#374151', lineHeight: 22, marginBottom: 8 },
  modalHint: { fontSize: 13, color: '#6B7280', marginBottom: 20 },
  modalBtns: { flexDirection: 'row', gap: 12 },
  modalCancel: { flex: 1, backgroundColor: '#F3F4F6', borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  modalConfirm: { flex: 1, backgroundColor: '#1D4ED8', borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  modalCancelText: { fontSize: 15, fontWeight: '600', color: '#374151' },
  modalConfirmText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
});
