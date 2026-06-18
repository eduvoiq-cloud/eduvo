'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { studentTestsApi, type Question, type AttemptResultResponse, type ResultAnswer } from '@/lib/studentApi';
import { getStudentToken, clearStudentSession } from '@/lib/studentSession';
import { useWebIntegrity } from '@/hooks/useWebIntegrity';

// ── Types ─────────────────────────────────────────────────────────────────────
type Phase = 'checking' | 'camera' | 'pre' | 'integrity_warning' | 'active' | 'submitting' | 'results' | 'error';
type OptionKey = 'a' | 'b' | 'c' | 'd';

interface Answer {
  question_id: string;
  selected_option?: OptionKey;
  theory_answer?: string;
}

interface SavedProgress {
  attempt_id: string;
  answers: Answer[];
  currentIndex: number;
  secondsLeft: number | null;
  savedAt: string;
}

const progressKey = (testId: string) => `eduvo_test_progress_${testId}`;

function saveProgress(testId: string, p: SavedProgress) {
  localStorage.setItem(progressKey(testId), JSON.stringify(p));
}
function loadProgress(testId: string): SavedProgress | null {
  try {
    const raw = localStorage.getItem(progressKey(testId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function clearProgress(testId: string) {
  localStorage.removeItem(progressKey(testId));
}

// ── Timer hook ────────────────────────────────────────────────────────────────
function useCountdown(onExpire: () => void) {
  const [secondsLeft, setSecondsLeftState] = useState<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  const isPausedRef = useRef(false);

  function stopInterval() {
    if (intervalRef.current !== null) { clearInterval(intervalRef.current); intervalRef.current = null; }
  }

  const setSecondsLeft = useCallback((n: number | null) => {
    stopInterval();
    if (n === null || n <= 0) { setSecondsLeftState(null); return; }
    setSecondsLeftState(n);
    intervalRef.current = setInterval(() => {
      if (isPausedRef.current) return;
      setSecondsLeftState((prev) => {
        if (prev === null || prev <= 1) {
          stopInterval();
          setTimeout(() => onExpireRef.current(), 0);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const setPaused = useCallback((paused: boolean) => { isPausedRef.current = paused; }, []);

  useEffect(() => () => stopInterval(), []);
  return { secondsLeft, setSecondsLeft, setPaused };
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── Camera / face-detection hook ──────────────────────────────────────────────
interface UseFaceDetectionProps {
  enabled: boolean;
  onFaceAbsent: () => void;
  onFacePresent: () => void;
  onMultipleFaces: () => void;
}

interface FaceViolation {
  type: 'absent' | 'multiple';
  message: string;
}

function useFaceDetection({ enabled, onFaceAbsent, onFacePresent, onMultipleFaces }: UseFaceDetectionProps) {
  const videoRef    = useRef<HTMLVideoElement | null>(null);
  const canvasRef   = useRef<HTMLCanvasElement | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const consecutiveAbsentRef = useRef(0);
  const [violation, setViolation] = useState<FaceViolation | null>(null);
  const [modelLoaded, setModelLoaded] = useState(false);
  const faceapiRef  = useRef<typeof import('face-api.js') | null>(null);

  const startDetection = useCallback(async (videoEl: HTMLVideoElement, canvasEl: HTMLCanvasElement) => {
    if (!enabled) return;
    videoRef.current  = videoEl;
    canvasRef.current = canvasEl;

    // Lazy-load face-api.js (client-only, large library)
    if (!faceapiRef.current) {
      const faceapi = await import('face-api.js');
      faceapiRef.current = faceapi;
      await faceapi.nets.tinyFaceDetector.loadFromUri('/models');
      setModelLoaded(true);
    }

    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(async () => {
      const faceapi = faceapiRef.current;
      const video   = videoRef.current;
      if (!faceapi || !video || video.readyState < 2) return;
      try {
        const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions());
        const count = detections.length;
        if (count === 0) {
          consecutiveAbsentRef.current += 1;
          if (consecutiveAbsentRef.current >= 3) { // 3 × 2s = 6s absent threshold
            onFaceAbsent();
            setViolation({ type: 'absent', message: '👤 Face not detected. Please stay in frame. This has been recorded.' });
          }
        } else if (count >= 2) {
          consecutiveAbsentRef.current = 0;
          onFacePresent();
          onMultipleFaces();
          setViolation({ type: 'multiple', message: '👥 Multiple people detected. This has been recorded.' });
          setTimeout(() => setViolation(null), 5000);
        } else {
          consecutiveAbsentRef.current = 0;
          onFacePresent();
          setViolation(null);
        }
      } catch { /* detection error — skip frame */ }
    }, 2000);
  }, [enabled, onFaceAbsent, onFacePresent, onMultipleFaces]);

  const stopDetection = useCallback(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  }, []);

  useEffect(() => () => stopDetection(), [stopDetection]);

  return { startDetection, stopDetection, violation, modelLoaded };
}

// ── Camera permission phase ───────────────────────────────────────────────────
function CameraPermissionScreen({
  onGranted,
  onDenied,
  streamRef,
}: {
  onGranted: (stream: MediaStream) => void;
  onDenied: () => void;
  streamRef: React.MutableRefObject<MediaStream | null>;
}) {
  const [status, setStatus] = useState<'idle' | 'requesting' | 'denied'>('idle');
  const previewRef = useRef<HTMLVideoElement>(null);

  async function requestCamera() {
    setStatus('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      streamRef.current = stream;
      if (previewRef.current) { previewRef.current.srcObject = stream; }
      setStatus('idle');
      onGranted(stream);
    } catch {
      setStatus('denied');
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-sm w-full bg-white rounded-2xl shadow-sm border border-gray-200 p-8 text-center">
        <div className="w-16 h-16 bg-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-5">
          <span className="text-3xl" role="img" aria-label="camera">📷</span>
        </div>
        <h2 className="text-lg font-bold text-gray-900 mb-2">Camera Access Required</h2>
        <p className="text-sm text-gray-500 mb-6">
          This test requires camera access for proctoring. Your webcam feed will be visible during the test and face detection will monitor for suspicious activity.
        </p>

        {status === 'denied' && (
          <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700" role="alert">
            Camera access was denied. You must allow camera access to proceed with this test.
          </div>
        )}

        <video
          ref={previewRef}
          autoPlay
          muted
          playsInline
          className={`w-full h-36 object-cover rounded-xl bg-black mb-5 ${status === 'idle' && !streamRef.current ? 'hidden' : ''}`}
          aria-label="Camera preview"
        />

        {status === 'denied' ? (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">Please allow camera access in your browser settings and reload.</p>
            <button onClick={requestCamera} className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition-colors">
              Try Again
            </button>
          </div>
        ) : (
          <button
            onClick={requestCamera}
            disabled={status === 'requesting'}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            {status === 'requesting' ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Requesting access…
              </span>
            ) : 'Allow Camera Access'}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Pre-test screen ───────────────────────────────────────────────────────────
function PreTestScreen({
  title,
  questionCount,
  timeLimit,
  instructions,
  isResume,
  starting,
  onStart,
}: {
  title: string;
  questionCount: number;
  timeLimit: number;
  instructions?: string | null;
  isResume: boolean;
  starting: boolean;
  onStart: () => void;
}) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-lg w-full space-y-5">
        {/* Hero card */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
          <div className="w-20 h-20 bg-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-5">
            <span className="text-4xl" role="img" aria-label="test">📝</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900 mb-4">{title}</h1>
          <div className="flex items-center justify-center gap-6 text-sm">
            <div className="text-center">
              <p className="font-bold text-gray-900 text-lg">{questionCount}</p>
              <p className="text-gray-500 text-xs">Questions</p>
            </div>
            <div className="w-px h-8 bg-gray-200" />
            <div className="text-center">
              <p className="font-bold text-gray-900 text-lg">{timeLimit > 0 ? `${timeLimit} min` : '∞'}</p>
              <p className="text-gray-500 text-xs">Time Limit</p>
            </div>
          </div>
        </div>

        {/* Resume banner */}
        {isResume && (
          <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-800 font-medium">
            ⏸ You have an attempt in progress. Press below to start fresh.
          </div>
        )}

        {/* Instructions */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
          <h2 className="text-sm font-bold text-gray-800 mb-3">Instructions</h2>
          <ul className="space-y-2">
            {[
              'Read each question carefully before answering.',
              'MCQ: click an option to select it. You can change your answer before submitting.',
              'Theory: type your answer in the text box provided.',
              timeLimit > 0 ? `You have ${timeLimit} minutes. The test auto-submits when time runs out.` : 'There is no time limit for this test.',
              'Use the numbered pills to jump between questions.',
              'You must confirm before final submission.',
              'The test runs in fullscreen mode. Exiting fullscreen will be recorded.',
              'Leaving or switching tabs will be recorded and reported.',
            ].map((line, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-gray-600">
                <span className="text-blue-500 mt-0.5 shrink-0">•</span>
                {line}
              </li>
            ))}
          </ul>
          {instructions && (
            <div className="mt-4 bg-blue-50 border-l-4 border-blue-500 rounded-r-lg px-4 py-3">
              <p className="text-xs font-bold text-blue-800 mb-1">Teacher&apos;s Note</p>
              <p className="text-xs text-blue-700">{instructions}</p>
            </div>
          )}
        </div>

        <button
          onClick={onStart}
          disabled={starting}
          className="w-full py-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-bold rounded-xl transition-colors text-base"
        >
          {starting ? (
            <span className="flex items-center justify-center gap-2">
              <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Starting…
            </span>
          ) : isResume ? 'Resume Test →' : 'Start Test →'}
        </button>
      </div>
    </div>
  );
}

// ── Integrity warning modal ───────────────────────────────────────────────────
function IntegrityWarningModal({ visible, hasCamera, onConfirm }: { visible: boolean; hasCamera: boolean; onConfirm: () => void }) {
  if (!visible) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Test integrity monitoring"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
    >
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-8 text-center">
        <div className="text-5xl mb-5">🔒</div>
        <h2 className="text-lg font-bold text-gray-900 mb-3">Test Integrity Monitoring Active</h2>
        <p className="text-sm text-gray-600 mb-2">
          This test is being monitored. The following actions will be recorded and shown to your teacher:
        </p>
        <ul className="text-left text-sm text-gray-600 space-y-1 mb-4 mx-auto max-w-xs">
          <li className="flex gap-2"><span className="text-red-500">•</span>Switching tabs or leaving this window</li>
          <li className="flex gap-2"><span className="text-red-500">•</span>Exiting fullscreen mode</li>
          {hasCamera && <li className="flex gap-2"><span className="text-red-500">•</span>Face absent from camera</li>}
          {hasCamera && <li className="flex gap-2"><span className="text-red-500">•</span>Multiple faces detected</li>}
        </ul>
        <button
          onClick={onConfirm}
          className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-xl transition-colors"
        >
          I Understand — Start Test
        </button>
      </div>
    </div>
  );
}

// ── Question pills ────────────────────────────────────────────────────────────
function QuestionPills({ total, current, answers, onJump }: { total: number; current: number; answers: Answer[]; onJump: (i: number) => void }) {
  return (
    <div className="flex gap-1.5 overflow-x-auto py-2 px-1 scrollbar-hide" role="tablist" aria-label="Question navigation">
      {Array.from({ length: total }, (_, i) => {
        const ans = answers[i];
        const isAnswered = !!(ans?.selected_option || (ans?.theory_answer && ans.theory_answer.trim().length > 0));
        const isCurrent  = i === current;
        return (
          <button
            key={i}
            role="tab"
            aria-selected={isCurrent}
            aria-label={`Question ${i + 1}${isAnswered ? ', answered' : ', unanswered'}`}
            onClick={() => onJump(i)}
            className={`shrink-0 w-8 h-8 rounded-full text-xs font-bold transition-colors ${
              isCurrent    ? 'bg-blue-600 text-white ring-2 ring-blue-300' :
              isAnswered   ? 'bg-green-500 text-white' :
                             'bg-gray-200 text-gray-600 hover:bg-gray-300'
            }`}
          >
            {i + 1}
          </button>
        );
      })}
    </div>
  );
}

// ── MCQ question view ─────────────────────────────────────────────────────────
const OPTION_LETTERS: OptionKey[] = ['a', 'b', 'c', 'd'];
const OPTION_LABELS  = ['A', 'B', 'C', 'D'];

function MCQQuestion({ question, selected, onSelect }: { question: Question; selected?: OptionKey; onSelect: (o: OptionKey) => void }) {
  const options: Array<{ key: OptionKey; text: string | null }> = OPTION_LETTERS.map((k, i) => ({
    key: k,
    text: question[`option_${k}` as 'option_a'] ?? null,
  })).filter((o) => o.text);

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-gray-900 leading-relaxed">{question.question_text}</p>
      <div className="space-y-2">
        {options.map((opt, i) => {
          const isSelected = selected === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => onSelect(opt.key)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left text-sm transition-colors border-2 ${
                isSelected
                  ? 'bg-blue-50 border-blue-500 text-blue-900 font-medium'
                  : 'bg-white border-gray-200 text-gray-700 hover:border-blue-300 hover:bg-blue-50/40'
              }`}
              aria-pressed={isSelected}
              aria-label={`Option ${OPTION_LABELS[i]}: ${opt.text}`}
            >
              <span className={`w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-xs font-bold ${
                isSelected ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
              }`}>
                {OPTION_LABELS[i]}
              </span>
              {opt.text}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Theory question view ──────────────────────────────────────────────────────
function TheoryQuestion({ question, value, onChange }: { question: Question; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-gray-900 leading-relaxed">{question.question_text}</p>
      <textarea
        rows={6}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Write your answer here…"
        aria-label="Theory answer"
        className="w-full px-4 py-3 border border-gray-300 rounded-xl text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
      />
    </div>
  );
}

// ── Submit modal ──────────────────────────────────────────────────────────────
function SubmitModal({ visible, answeredCount, totalCount, onConfirm, onCancel, loading }: {
  visible: boolean; answeredCount: number; totalCount: number;
  onConfirm: () => void; onCancel: () => void; loading: boolean;
}) {
  if (!visible) return null;
  const unanswered = totalCount - answeredCount;
  return (
    <div role="dialog" aria-modal="true" aria-label="Submit test" className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-7 text-center">
        <div className="text-4xl mb-4">📋</div>
        <h2 className="text-base font-bold text-gray-900 mb-2">Submit Test?</h2>
        <p className="text-sm text-gray-600 mb-1"><span className="font-semibold text-green-700">{answeredCount}</span> answered</p>
        {unanswered > 0 && (
          <p className="text-sm text-amber-600 mb-4 font-medium">⚠️ {unanswered} unanswered = 0 marks</p>
        )}
        <div className="flex gap-3 mt-5">
          <button onClick={onCancel} disabled={loading}
            className="flex-1 py-2.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-xl hover:bg-gray-50 transition-colors">
            Go Back
          </button>
          <button onClick={onConfirm} disabled={loading}
            className="flex-1 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-xl transition-colors">
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Submitting…
              </span>
            ) : 'Yes, Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Fullscreen exit overlay ───────────────────────────────────────────────────
function FullscreenExitOverlay({ onReenter }: { onReenter: () => void }) {
  return (
    <div role="alert" className="fixed inset-0 z-50 flex items-center justify-center bg-red-900/90 p-4">
      <div className="bg-white rounded-2xl p-8 text-center max-w-sm w-full shadow-xl">
        <p className="text-4xl mb-4">⚠️</p>
        <h2 className="text-lg font-bold text-red-700 mb-2">You left fullscreen!</h2>
        <p className="text-sm text-gray-600 mb-6">This has been recorded. Please return to fullscreen to continue the test. The timer is paused.</p>
        <button onClick={onReenter} className="w-full py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl transition-colors">
          Return to Fullscreen
        </button>
      </div>
    </div>
  );
}

// ── Results screen ────────────────────────────────────────────────────────────
function ResultsScreen({ result, onBack }: { result: AttemptResultResponse; onBack: () => void }) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const mcqAnswers    = result.answers.filter((a) => a.question_type === 'mcq');
  const theoryAnswers = result.answers.filter((a) => a.question_type === 'theory');
  const correct       = mcqAnswers.filter((a) => a.is_correct).length;

  function toggleExpand(id: string) {
    setExpandedIds((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={onBack} className="p-2 rounded-lg hover:bg-gray-100 transition-colors text-gray-600" aria-label="Back to tests">
            ← Back
          </button>
          <h1 className="text-base font-bold text-gray-900">Test Results</h1>
        </div>
      </header>
      <main className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        {/* Score card */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 text-center">
          {result.mcq_score !== null ? (
            <>
              <p className="text-4xl font-bold text-blue-600 mb-1">{result.mcq_score}</p>
              <p className="text-sm text-gray-500">MCQ Score · {correct} of {mcqAnswers.length} correct</p>
            </>
          ) : (
            <p className="text-sm text-gray-500">Score pending</p>
          )}
          {theoryAnswers.length > 0 && (
            <div className="mt-3 px-4 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700 font-medium">
              ⏳ Theory questions are pending teacher review
            </div>
          )}
        </div>

        {/* MCQ Breakdown */}
        {mcqAnswers.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-bold text-gray-700 px-1">MCQ Breakdown</h2>
            {mcqAnswers.map((ans: ResultAnswer, idx) => {
              const isCorrect = ans.is_correct === true;
              const isExpanded = expandedIds.has(ans.question_id);
              return (
                <div key={ans.question_id} className={`bg-white rounded-xl border shadow-sm overflow-hidden ${isCorrect ? 'border-green-200' : 'border-red-200'}`}>
                  <button type="button" onClick={() => { if (!isCorrect || ans.explanation || ans.reasoning) toggleExpand(ans.question_id); }}
                    className="w-full text-left p-4">
                    <div className="flex items-start gap-3">
                      <span className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${isCorrect ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {isCorrect ? '✓' : '✗'}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 leading-snug">
                          <span className="text-gray-400 mr-1">Q{idx + 1}.</span>{ans.question_text}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {ans.selected_option && (
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${isCorrect ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                              Your answer: {ans.selected_option.toUpperCase()}
                            </span>
                          )}
                          {!isCorrect && ans.correct_option && (
                            <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-blue-100 text-blue-700">
                              Correct: {ans.correct_option.toUpperCase()}
                            </span>
                          )}
                          {!ans.selected_option && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">Not answered</span>
                          )}
                        </div>
                      </div>
                      {(ans.explanation || ans.reasoning) && (
                        <span className="text-xs text-gray-400 shrink-0">{isExpanded ? '▲' : '▼'}</span>
                      )}
                    </div>
                  </button>
                  {(isExpanded || !isCorrect) && (ans.explanation || ans.reasoning) && (
                    <div className="px-4 pb-4 pt-0 space-y-2 border-t border-gray-100">
                      {ans.explanation && <p className="text-xs text-gray-600"><span className="font-semibold">Explanation:</span> {ans.explanation}</p>}
                      {ans.reasoning && <p className="text-xs text-gray-500 italic">{ans.reasoning}</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Theory answers */}
        {theoryAnswers.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-bold text-gray-700 px-1">Theory Questions</h2>
            {theoryAnswers.map((ans: ResultAnswer, idx) => (
              <div key={ans.question_id} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-2">
                <p className="text-sm font-medium text-gray-900"><span className="text-gray-400 mr-1">Q{idx + 1}.</span>{ans.question_text}</p>
                <div className="px-3 py-2 bg-gray-50 rounded-lg text-sm text-gray-700 min-h-10">
                  {ans.theory_answer || <span className="text-gray-400 italic">No answer provided</span>}
                </div>
                <p className="text-xs text-amber-600">
                  {ans.marks_awarded === 'pending' ? '⏳ Pending teacher review' : `Marks: ${ans.marks_awarded} / ${ans.marks}`}
                </p>
              </div>
            ))}
          </div>
        )}

        <button onClick={onBack} className="w-full py-3 border border-gray-300 text-sm font-medium text-gray-700 rounded-xl hover:bg-gray-50 transition-colors">
          ← Back to Tests
        </button>
      </main>
    </div>
  );
}

// ── Main page component ───────────────────────────────────────────────────────
export default function TestAttemptPage() {
  const params   = useParams();
  const router   = useRouter();
  const testId   = params.testId as string;

  const [phase, setPhase]                 = useState<Phase>('checking');
  const [testMeta, setTestMeta]           = useState<{ title: string; question_count: number; time_limit_minutes: number; available_from?: string | null; available_until?: string | null; instructions?: string | null; require_camera?: boolean } | null>(null);
  const [questions, setQuestions]         = useState<Question[]>([]);
  const [answers, setAnswers]             = useState<Answer[]>([]);
  const [currentIndex, setCurrentIndex]   = useState(0);
  const [attemptId, setAttemptId]         = useState('');
  const [starting, setStarting]           = useState(false);
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [submitting, setSubmitting]       = useState(false);
  const [errorMsg, setErrorMsg]           = useState('');
  const [result, setResult]               = useState<AttemptResultResponse | null>(null);
  const [savedProgress, setSavedProgress] = useState<SavedProgress | null>(null);

  // Camera
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const videoRef        = useRef<HTMLVideoElement>(null);
  const hiddenCanvasRef = useRef<HTMLCanvasElement>(null);
  const [cameraGranted, setCameraGranted] = useState(false);
  const [faceWarning, setFaceWarning]     = useState<string | null>(null);
  const requireCamera = testMeta?.require_camera ?? false;

  const integrity = useWebIntegrity();
  const { secondsLeft, setSecondsLeft, setPaused } = useCountdown(() => doSubmit(true));

  // Sync timer pause with fullscreen exit
  useEffect(() => {
    setPaused(integrity.isTimerPaused);
  }, [integrity.isTimerPaused, setPaused]);

  // Face detection
  const faceDetection = useFaceDetection({
    enabled: requireCamera,
    onFaceAbsent: () => {
      integrity.recordFaceAbsent();
      setFaceWarning('👤 Face not detected. Please stay in frame. This has been recorded.');
    },
    onFacePresent: () => {
      integrity.recordFacePresent();
      setFaceWarning(null);
    },
    onMultipleFaces: () => {
      integrity.recordMultipleFaces();
      setFaceWarning('👥 Multiple people detected. This has been recorded.');
    },
  });

  // ── Auth guard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const token = getStudentToken();
    if (!token) { router.replace('/student/login'); return; }

    // Load test meta from test list (we'll reload after starting attempt)
    const saved = loadProgress(testId);
    if (saved) setSavedProgress(saved);

    // Fetch the test record to get meta
    studentTestsApi.list(token).then((res) => {
      const t = res.data.find((x) => x.id === testId);
      if (!t) { setErrorMsg('Test not found or not available for your class.'); setPhase('error'); return; }
      setTestMeta({
        title: t.title,
        question_count: t.question_count,
        time_limit_minutes: t.time_limit_minutes,
        available_from: t.available_from,
        available_until: t.available_until,
        require_camera: (t as TestRecord & { require_camera?: boolean }).require_camera ?? false,
      });

      if (t.attempt_status === 'completed') {
        // Load results directly
        studentTestsApi.getResultsByTest(token, testId).then((rRes) => {
          setResult(rRes.data);
          setPhase('results');
        }).catch(() => { setPhase('pre'); });
        return;
      }

      // Camera gate
      if ((t as TestRecord & { require_camera?: boolean }).require_camera) {
        setPhase('camera');
      } else {
        setPhase('pre');
      }
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to load test';
      if (msg.includes('401')) { clearStudentSession(); router.replace('/student/login'); return; }
      setErrorMsg(msg);
      setPhase('error');
    });
  }, [testId, router]);

  // ── Start attempt ────────────────────────────────────────────────────────────
  async function handleStart() {
    const token = getStudentToken();
    if (!token) { router.replace('/student/login'); return; }
    setStarting(true);
    try {
      const res = await studentTestsApi.startAttempt(token, testId);
      const { attempt_id, questions: qs, seconds_remaining } = res.data;
      setAttemptId(attempt_id);
      setQuestions(qs);
      // Build blank answer array aligned with questions
      setAnswers(qs.map((q) => ({ question_id: q.id })));
      setCurrentIndex(0);
      if (seconds_remaining !== null && seconds_remaining !== undefined) {
        setSecondsLeft(seconds_remaining);
      }
      setPhase('integrity_warning');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to start test';
      setErrorMsg(msg);
      setPhase('error');
    } finally {
      setStarting(false);
    }
  }

  // ── Confirm integrity warning → go active ────────────────────────────────────
  function handleIntegrityConfirm() {
    // Enter fullscreen
    const el = document.documentElement;
    const req = el.requestFullscreen?.bind(el)
      ?? (el as unknown as { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen?.bind(el);
    if (req) req().catch(() => {/* not fatal */});

    integrity.startTracking();
    setPhase('active');

    // Start camera face detection if enabled
    if (requireCamera && videoRef.current && hiddenCanvasRef.current) {
      faceDetection.startDetection(videoRef.current, hiddenCanvasRef.current);
    }
  }

  // ── Answer change ─────────────────────────────────────────────────────────────
  function handleAnswer(qId: string, update: Partial<Answer>) {
    setAnswers((prev) => {
      const next = prev.map((a) => a.question_id === qId ? { ...a, ...update } : a);
      // Auto-save to localStorage
      if (attemptId) {
        saveProgress(testId, {
          attempt_id: attemptId,
          answers: next,
          currentIndex,
          secondsLeft: secondsLeft,
          savedAt: new Date().toISOString(),
        });
      }
      return next;
    });
  }

  // ── Submit ────────────────────────────────────────────────────────────────────
  const doSubmit = useCallback(async (auto = false) => {
    if (!auto) setShowSubmitModal(false);
    setPhase('submitting');
    setSubmitting(true);

    const token = getStudentToken();
    if (!token) { router.replace('/student/login'); return; }

    // Exit fullscreen gracefully
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
    } catch {/* ignore */}

    // Finalise integrity
    const integrityData = integrity.finaliseTracking();
    faceDetection.stopDetection();

    // Stop camera
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((t) => t.stop());
      cameraStreamRef.current = null;
    }

    try {
      const payload = {
        attempt_id: attemptId,
        answers: answers
          .filter((a) => a.selected_option || (a.theory_answer && a.theory_answer.trim()))
          .map((a) => ({
            question_id: a.question_id,
            ...(a.selected_option ? { selected_option: a.selected_option } : {}),
            ...(a.theory_answer ? { theory_answer: a.theory_answer } : {}),
          })),
        integrity: integrityData,
      };

      // Ensure at least one answer (backend requires min 1)
      if (payload.answers.length === 0 && questions.length > 0) {
        payload.answers = [{ question_id: questions[0].id }];
      }

      await studentTestsApi.submitAttempt(token, payload);
      clearProgress(testId);

      // Fetch results
      const resData = await studentTestsApi.getResultsByTest(token, testId);
      setResult(resData.data);
      setPhase('results');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Submission failed';
      setErrorMsg(msg);
      setPhase('error');
    } finally {
      setSubmitting(false);
    }
  }, [attemptId, answers, questions, testId, router, integrity, faceDetection]);

  // Wire camera stream to video element when stream is set
  useEffect(() => {
    if (cameraStreamRef.current && videoRef.current) {
      videoRef.current.srcObject = cameraStreamRef.current;
    }
  }, [cameraGranted]);

  // ── Computed values ───────────────────────────────────────────────────────────
  const answeredCount = answers.filter((a) => a.selected_option || (a.theory_answer && a.theory_answer.trim().length > 0)).length;
  const currentQuestion = questions[currentIndex];
  const currentAnswer   = answers[currentIndex];

  // ── Render ────────────────────────────────────────────────────────────────────
  if (phase === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="max-w-sm w-full text-center bg-white rounded-2xl border border-gray-200 p-8 shadow-sm">
          <p className="text-4xl mb-4">⚠️</p>
          <h2 className="text-base font-bold text-gray-900 mb-2">Something went wrong</h2>
          <p className="text-sm text-gray-500 mb-6">{errorMsg}</p>
          <button onClick={() => router.replace('/student/tests')} className="w-full py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors">
            Back to Tests
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'results' && result) {
    return <ResultsScreen result={result} onBack={() => router.replace('/student/tests')} />;
  }

  if (phase === 'submitting') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-sm text-gray-600">Submitting your test…</p>
        </div>
      </div>
    );
  }

  if (phase === 'camera' && testMeta) {
    return (
      <CameraPermissionScreen
        streamRef={cameraStreamRef}
        onGranted={(stream) => {
          cameraStreamRef.current = stream;
          setCameraGranted(true);
          setPhase('pre');
        }}
        onDenied={() => {
          setErrorMsg('You must allow camera access to proceed with this test.');
          setPhase('error');
        }}
      />
    );
  }

  if ((phase === 'pre' || phase === 'integrity_warning') && testMeta) {
    return (
      <>
        <PreTestScreen
          title={testMeta.title}
          questionCount={testMeta.question_count}
          timeLimit={testMeta.time_limit_minutes}
          instructions={testMeta.instructions}
          isResume={!!savedProgress}
          starting={starting}
          onStart={handleStart}
        />
        <IntegrityWarningModal
          visible={phase === 'integrity_warning'}
          hasCamera={requireCamera}
          onConfirm={handleIntegrityConfirm}
        />
      </>
    );
  }

  // ── Active test UI ────────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex flex-col bg-gray-50 overflow-hidden select-none">
      {/* Fullscreen exit overlay */}
      {integrity.isFullscreenExited && <FullscreenExitOverlay onReenter={integrity.reenterFullscreen} />}

      {/* Integrity warning modal (shown before active) */}
      <IntegrityWarningModal visible={phase === 'integrity_warning'} hasCamera={requireCamera} onConfirm={handleIntegrityConfirm} />

      {/* Submit modal */}
      <SubmitModal
        visible={showSubmitModal}
        answeredCount={answeredCount}
        totalCount={questions.length}
        onConfirm={() => doSubmit(false)}
        onCancel={() => setShowSubmitModal(false)}
        loading={submitting}
      />

      {/* Face violation banner */}
      {faceWarning && (
        <div role="alert" className="fixed top-0 left-0 right-0 z-40 bg-amber-500 text-white text-xs font-semibold text-center py-2 px-4">
          {faceWarning}
        </div>
      )}

      {/* Top bar */}
      <header className="bg-white border-b border-gray-200 shrink-0 z-20">
        <div className="flex items-center justify-between px-4 py-2 gap-2">
          <h1 className="text-sm font-bold text-gray-900 truncate flex-1">{testMeta?.title ?? 'Test'}</h1>
          <div className="flex items-center gap-3 shrink-0">
            {secondsLeft !== null && (
              <span className={`font-mono text-sm font-bold px-2 py-1 rounded-lg ${secondsLeft < 60 ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700'}`}
                aria-live="polite" aria-label={`${Math.floor(secondsLeft / 60)} minutes ${secondsLeft % 60} seconds remaining`}>
                {formatTime(secondsLeft)}
              </span>
            )}
            <span className="text-xs text-gray-500 font-medium">
              Q{currentIndex + 1}/{questions.length}
            </span>
            <button
              onClick={() => setShowSubmitModal(true)}
              className="px-3 py-1.5 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
              aria-label="Submit test"
            >
              Submit
            </button>
          </div>
        </div>

        {/* Question pills */}
        <div className="px-3 py-1 border-t border-gray-100">
          <QuestionPills
            total={questions.length}
            current={currentIndex}
            answers={answers}
            onJump={setCurrentIndex}
          />
        </div>
      </header>

      {/* Question area */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-5">
          {currentQuestion && (
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 mb-4">
              <div className="flex items-center gap-2 mb-4">
                <span className="w-7 h-7 rounded-full bg-blue-100 text-blue-700 text-xs font-bold flex items-center justify-center shrink-0">
                  {currentIndex + 1}
                </span>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${currentQuestion.question_type === 'mcq' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                  {currentQuestion.question_type === 'mcq' ? 'MCQ' : 'Theory'} · {currentQuestion.marks}m
                </span>
              </div>

              {currentQuestion.question_type === 'mcq' ? (
                <MCQQuestion
                  question={currentQuestion}
                  selected={currentAnswer?.selected_option}
                  onSelect={(opt) => handleAnswer(currentQuestion.id, { selected_option: opt })}
                />
              ) : (
                <TheoryQuestion
                  question={currentQuestion}
                  value={currentAnswer?.theory_answer ?? ''}
                  onChange={(v) => handleAnswer(currentQuestion.id, { theory_answer: v })}
                />
              )}
            </div>
          )}

          {/* Prev / Next */}
          <div className="flex gap-3">
            <button
              onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
              disabled={currentIndex === 0}
              className="flex-1 py-2.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-xl hover:bg-gray-50 disabled:opacity-40 transition-colors"
              aria-label="Previous question"
            >
              ← Previous
            </button>
            <button
              onClick={() => setCurrentIndex((i) => Math.min(questions.length - 1, i + 1))}
              disabled={currentIndex === questions.length - 1}
              className="flex-1 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded-xl transition-colors"
              aria-label="Next question"
            >
              Next →
            </button>
          </div>
        </div>
      </main>

      {/* Camera PiP — bottom-right */}
      {requireCamera && (
        <>
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="fixed bottom-4 right-4 w-40 h-30 rounded-xl border-2 border-white shadow-lg object-cover z-30"
            style={{ width: 160, height: 120 }}
            aria-label="Camera preview"
          />
          <canvas ref={hiddenCanvasRef} className="hidden" aria-hidden="true" />
        </>
      )}
    </div>
  );
}
