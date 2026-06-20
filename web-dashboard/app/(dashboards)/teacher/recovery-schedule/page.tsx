'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import FormField, { inputClass } from '@/components/FormField';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RecoveryCycle {
  id: string;
  class: string;
  section: string;
  status: 'generating_pack' | 'pack_ready' | 'generating_tests' | 'tests_ready' | 'completed' | 'pack_failed';
  pack_generated_at: string | null;
  test_generated_at: string | null;
  lockout_until: string | null;
  created_at: string;
}

interface CycleStatus {
  cycle: RecoveryCycle | null;
  pack_progress: { total: number; completed: number; failed: number };
  test_progress: { total: number; completed: number; failed: number };
  lockout_until: string | null;
  days_remaining: number;
  is_locked: boolean;
}

interface SubjectConfig {
  subject: string;
  time_limit_minutes: number;
  shuffle_questions: boolean;
  shuffle_options: boolean;
  available_from: string;
  available_until: string;
  require_camera: boolean;
}

interface TestResult {
  student_id: string;
  full_name: string;
  score: number | null;
  total_questions: number | null;
  percentage: number | null;
  submitted_at: string | null;
  status: 'submitted' | 'not_given';
}

interface TeacherAssignment {
  class_name: string;
  section: string;
  subject: string;
}

// ── Toggle (matches tests/create/page.tsx) ────────────────────────────────────

function Toggle({ checked, onChange, id }: { checked: boolean; onChange: (v: boolean) => void; id: string }) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 ${
        checked ? 'bg-purple-600' : 'bg-gray-300'
      }`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
        checked ? 'translate-x-6' : 'translate-x-1'
      }`} />
    </button>
  );
}

// ── Toast hook ────────────────────────────────────────────────────────────────

interface Toast { id: number; message: string; type: 'success' | 'error' }
let toastId = 0;

function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    const id = ++toastId;
    setToasts((p) => [...p, { id, message, type }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 4000);
  }, []);
  return { toasts, show };
}

// ── Percentage colour ─────────────────────────────────────────────────────────

function pctColor(pct: number | null): string {
  if (pct === null) return 'text-gray-400';
  if (pct >= 75) return 'text-green-600 font-semibold';
  if (pct >= 50) return 'text-amber-600 font-semibold';
  return 'text-red-600 font-semibold';
}

// ── Countdown helper ──────────────────────────────────────────────────────────

function formatCountdown(until: string): string {
  const diff = new Date(until).getTime() - Date.now();
  if (diff <= 0) return '0 days';
  const days  = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  return `${days}d ${hours}h`;
}

// ── Test Config Modal ─────────────────────────────────────────────────────────

interface TestConfigModalProps {
  subjects: string[];
  onConfirm: (configs: SubjectConfig[]) => void;
  onClose: () => void;
  submitting: boolean;
}

function TestConfigModal({ subjects, onConfirm, onClose, submitting }: TestConfigModalProps) {
  const [configs, setConfigs] = useState<SubjectConfig[]>(
    subjects.map((s) => ({
      subject: s,
      time_limit_minutes: 30,
      shuffle_questions: true,
      shuffle_options: true,
      available_from: '',
      available_until: '',
      require_camera: false,
    }))
  );

  function updateConfig(index: number, patch: Partial<SubjectConfig>) {
    setConfigs((prev) => prev.map((c, i) => i === index ? { ...c, ...patch } : c));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Configure Recovery Tests</h2>
            <p className="text-xs text-gray-500 mt-0.5">Set parameters per subject</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-6">
          {configs.map((cfg, idx) => (
            <div key={cfg.subject} className="border border-gray-200 rounded-xl p-4 space-y-4">
              <h3 className="text-sm font-semibold text-purple-700 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-purple-500 inline-block" />
                {cfg.subject}
              </h3>

              <FormField label="Time Limit (minutes)" htmlFor={`time-${idx}`} required>
                <input
                  id={`time-${idx}`}
                  type="number" min={5} max={180} step={5}
                  className={inputClass}
                  value={cfg.time_limit_minutes}
                  onChange={(e) => updateConfig(idx, { time_limit_minutes: parseInt(e.target.value) || 30 })}
                />
              </FormField>

              <div className="grid grid-cols-2 gap-4">
                <FormField label="Available from" htmlFor={`from-${idx}`}>
                  <input id={`from-${idx}`} type="time" className={inputClass}
                    value={cfg.available_from}
                    onChange={(e) => updateConfig(idx, { available_from: e.target.value })} />
                </FormField>
                <FormField label="Available until" htmlFor={`until-${idx}`}>
                  <input id={`until-${idx}`} type="time" className={inputClass}
                    value={cfg.available_until}
                    onChange={(e) => updateConfig(idx, { available_until: e.target.value })} />
                </FormField>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <label htmlFor={`sq-${idx}`} className="text-sm font-medium text-gray-700">Shuffle Questions</label>
                    <p className="text-xs text-gray-500">Randomise question order</p>
                  </div>
                  <Toggle id={`sq-${idx}`} checked={cfg.shuffle_questions} onChange={(v) => updateConfig(idx, { shuffle_questions: v })} />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <label htmlFor={`so-${idx}`} className="text-sm font-medium text-gray-700">Shuffle Options</label>
                    <p className="text-xs text-gray-500">Randomise MCQ option order</p>
                  </div>
                  <Toggle id={`so-${idx}`} checked={cfg.shuffle_options} onChange={(v) => updateConfig(idx, { shuffle_options: v })} />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <label htmlFor={`cam-${idx}`} className="text-sm font-medium text-gray-700">📷 Require Camera</label>
                    <p className="text-xs text-gray-500">Camera monitoring during test</p>
                  </div>
                  <Toggle id={`cam-${idx}`} checked={cfg.require_camera} onChange={(v) => updateConfig(idx, { require_camera: v })} />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            Cancel
          </button>
          <button
            onClick={() => onConfirm(configs)}
            disabled={submitting}
            className="px-5 py-2 text-sm font-semibold text-white bg-purple-600 hover:bg-purple-700 disabled:bg-purple-400 rounded-lg transition-colors flex items-center gap-2"
          >
            {submitting ? <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Generating…</> : '⚡ Generate Tests'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function RecoverySchedulePage() {
  const { user } = useAuth();
  const { toasts, show: showToast } = useToast();

  // Class+section selection
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [selectedClass, setSelectedClass] = useState('');
  const [selectedSection, setSelectedSection] = useState('');

  // Cycle state
  const [cycleStatus, setCycleStatus] = useState<CycleStatus | null>(null);
  const [cycleLoading, setCycleLoading] = useState(false);

  // Pack generation
  const [generatingPack, setGeneratingPack] = useState(false);

  // Test config modal
  const [showTestModal, setShowTestModal] = useState(false);
  const [generatingTests, setGeneratingTests] = useState(false);

  // Results
  const [resultSubject, setResultSubject] = useState('');
  const [results, setResults] = useState<TestResult[]>([]);
  const [resultsLoading, setResultsLoading] = useState(false);

  // Countdown timer ref
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch assignments ───────────────────────────────────────────────────────

  useEffect(() => {
    if (!user?.school_id) return;
    const token = getToken();
    if (!token) return;
    fetch(`${BASE_URL}/api/assignments?school_id=${user.school_id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((j) => {
        const raw: Array<Record<string, string>> = Array.isArray(j.data) ? j.data : [];
        // Normalise: DB column is `class`, interface expects `class_name`
        const all: TeacherAssignment[] = raw.map((a) => ({
          class_name: a.class_name ?? a.class ?? '',
          section: a.section ?? '',
          subject: a.subject ?? '',
        }));
        setAssignments(all);
      })
      .catch(() => {});
  }, [user]);

  // ── Derived lists ───────────────────────────────────────────────────────────

  const myClasses = [...new Set(assignments.map((a) => a.class_name))].sort();
  const sectionsForClass = [...new Set(
    assignments.filter((a) => a.class_name === selectedClass).map((a) => a.section)
  )].sort();
  const subjectsForClassSection = [...new Set(
    assignments.filter((a) => a.class_name === selectedClass && a.section === selectedSection).map((a) => a.subject)
  )].sort();

  // ── Fetch cycle status ──────────────────────────────────────────────────────

  const fetchCycleStatus = useCallback(async () => {
    if (!selectedClass || !selectedSection) return;
    const token = getToken();
    if (!token) return;
    setCycleLoading(true);
    try {
      const res = await fetch(`${BASE_URL}/api/recovery/cycle-status?class=${encodeURIComponent(selectedClass)}&section=${encodeURIComponent(selectedSection)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (res.ok) setCycleStatus(json.data as CycleStatus);
    } catch { /* silent */ }
    finally { setCycleLoading(false); }
  }, [selectedClass, selectedSection]);

  useEffect(() => {
    void fetchCycleStatus();
  }, [fetchCycleStatus]);

  // Poll while generating — use a ref for fetchCycleStatus to avoid recreating the interval
  const fetchCycleStatusRef = useRef(fetchCycleStatus);
  useEffect(() => { fetchCycleStatusRef.current = fetchCycleStatus; }, [fetchCycleStatus]);

  useEffect(() => {
    const status = cycleStatus?.cycle?.status;
    const isGenerating = status === 'generating_pack' || status === 'generating_tests';

    if (isGenerating) {
      // Only create a new interval if one isn't already running
      if (!pollRef.current) {
        pollRef.current = setInterval(() => void fetchCycleStatusRef.current(), 5000);
      }
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [cycleStatus?.cycle?.status]);

  // ── Generate pack ───────────────────────────────────────────────────────────

  async function handleGeneratePack() {
    const token = getToken();
    if (!token) return;
    setGeneratingPack(true);
    try {
      const res = await fetch(`${BASE_URL}/api/recovery/start-pack`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ class: selectedClass, section: selectedSection }),
      });
      const json = await res.json();
      if (!res.ok) { showToast(json.message ?? 'Failed to start pack', 'error'); return; }
      showToast('Recovery pack generation started!');
      await fetchCycleStatus();
    } catch { showToast('Failed to start pack generation', 'error'); }
    finally { setGeneratingPack(false); }
  }

  // ── Generate tests ──────────────────────────────────────────────────────────

  async function handleGenerateTests(configs: SubjectConfig[]) {
    const token = getToken();
    if (!token || !cycleStatus?.cycle) return;
    setGeneratingTests(true);
    try {
      const payload = {
        cycle_id: cycleStatus.cycle.id,
        subject_configs: configs.map((c) => ({
          ...c,
          available_from: c.available_from || null,
          available_until: c.available_until || null,
        })),
      };
      const res = await fetch(`${BASE_URL}/api/recovery/start-tests`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) { showToast(json.message ?? 'Failed to start tests', 'error'); return; }
      showToast('Recovery test generation started!');
      setShowTestModal(false);
      await fetchCycleStatus();
    } catch { showToast('Failed to start test generation', 'error'); }
    finally { setGeneratingTests(false); }
  }

  // ── Fetch results ───────────────────────────────────────────────────────────

  const fetchResults = useCallback(async (subject: string) => {
    if (!cycleStatus?.cycle) return;
    const token = getToken();
    if (!token) return;
    setResultsLoading(true);
    try {
      const res = await fetch(
        `${BASE_URL}/api/recovery/test-results?cycle_id=${cycleStatus.cycle.id}&subject=${encodeURIComponent(subject)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const json = await res.json();
      if (res.ok) setResults(json.data as TestResult[]);
    } catch { /* silent */ }
    finally { setResultsLoading(false); }
  }, [cycleStatus?.cycle]);

  useEffect(() => {
    if (resultSubject && cycleStatus?.cycle?.status === 'tests_ready') {
      void fetchResults(resultSubject);
    }
  }, [resultSubject, fetchResults, cycleStatus?.cycle?.status]);

  // Default result subject to first subject
  useEffect(() => {
    if (cycleStatus?.cycle?.status === 'tests_ready' && subjectsForClassSection.length > 0 && !resultSubject) {
      setResultSubject(subjectsForClassSection[0]);
    }
  }, [cycleStatus?.cycle?.status, subjectsForClassSection, resultSubject]);

  // ── Remind student (fire and forget) with per-student cooldown ──────────────

  const remindedStudents = useRef<Set<string>>(new Set());

  async function handleRemind(studentId: string) {
    if (remindedStudents.current.has(studentId)) {
      showToast('Already reminded this student recently', 'error');
      return;
    }
    const token = getToken();
    if (!token) return;
    remindedStudents.current.add(studentId);
    await fetch(`${BASE_URL}/api/notifications/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        student_id: studentId,
        title: 'Recovery Test Reminder',
        body: 'You have a recovery test waiting. Open Eduvo to attempt it!',
      }),
    }).catch(() => { remindedStudents.current.delete(studentId); });
    showToast('Reminder sent');
  }

  // ── Cycle status display ────────────────────────────────────────────────────

  const cycle = cycleStatus?.cycle;
  const isLocked = cycleStatus?.is_locked ?? false;
  const packTotal = cycleStatus?.pack_progress?.total ?? 0;
  const packDone = cycleStatus?.pack_progress?.completed ?? 0;

  return (
    <>
      <PageHeader
        title="Recovery Schedule"
        description="Generate personalised recovery packs and tests for your class"
      />

      {/* Toast notifications */}
      <div className="fixed top-4 right-4 z-50 space-y-2 pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id} className={`px-4 py-3 rounded-xl shadow-lg text-sm font-medium pointer-events-auto transition-all ${t.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>
            {t.message}
          </div>
        ))}
      </div>

      {showTestModal && cycleStatus?.cycle && (
        <TestConfigModal
          subjects={subjectsForClassSection}
          onConfirm={handleGenerateTests}
          onClose={() => setShowTestModal(false)}
          submitting={generatingTests}
        />
      )}

      {/* Class + section picker */}
      <div className="mb-6 flex gap-4 flex-wrap">
        <div className="flex-1 min-w-40">
          <FormField label="Class" htmlFor="pick-class">
            <select id="pick-class" className={inputClass} value={selectedClass}
              onChange={(e) => { setSelectedClass(e.target.value); setSelectedSection(''); setCycleStatus(null); setResults([]); setResultSubject(''); }}>
              <option value="">Select class…</option>
              {myClasses.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </FormField>
        </div>
        <div className="flex-1 min-w-40">
          <FormField label="Section" htmlFor="pick-section">
            <select id="pick-section" className={inputClass} disabled={!selectedClass} value={selectedSection}
              onChange={(e) => { setSelectedSection(e.target.value); setCycleStatus(null); setResults([]); setResultSubject(''); }}>
              <option value="">Select section…</option>
              {sectionsForClass.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </FormField>
        </div>
      </div>

      {!selectedClass || !selectedSection ? (
        <div className="bg-white rounded-xl border border-gray-200 py-16 text-center">
          <p className="text-sm text-gray-400">Select a class and section to manage recovery</p>
        </div>
      ) : cycleLoading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-purple-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-6">

          {/* ── Section 1: Cycle status card ──────────────────────────────── */}
          <section className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-4">Recovery Cycle</h2>

            {!cycle && !isLocked && (
              <div className="flex flex-col items-center gap-4 py-6">
                <div className="w-16 h-16 rounded-full bg-purple-100 flex items-center justify-center">
                  <span className="text-3xl">🔄</span>
                </div>
                <div className="text-center">
                  <p className="text-base font-semibold text-gray-800">No active recovery cycle</p>
                  <p className="text-sm text-gray-500 mt-1">Start a new cycle to generate personalised packs for all students</p>
                </div>
                <button
                  onClick={handleGeneratePack}
                  disabled={generatingPack}
                  className="flex items-center gap-2 px-6 py-3 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-400 text-white text-sm font-semibold rounded-xl transition-colors"
                >
                  {generatingPack
                    ? <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Starting…</>
                    : '⚡ Generate Recovery Pack'}
                </button>
              </div>
            )}

            {cycle?.status === 'generating_pack' && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-purple-600 border-t-transparent rounded-full animate-spin" />
                  <span className="text-sm font-medium text-gray-700">Generating packs…</span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-2">
                  <div
                    className="bg-purple-600 h-2 rounded-full transition-all"
                    style={{ width: packTotal > 0 ? `${Math.round((packDone / packTotal) * 100)}%` : '10%' }}
                  />
                </div>
                <p className="text-xs text-gray-500">{packDone} / {packTotal || '…'} students done</p>
              </div>
            )}

            {cycle?.status === 'pack_failed' && (
              <div className="flex flex-col items-center gap-4 py-6">
                <span className="text-4xl">⚠️</span>
                <div className="text-center">
                  <p className="text-base font-semibold text-red-700">Pack generation failed</p>
                  <p className="text-sm text-gray-500 mt-1">Something went wrong generating the recovery packs. You can try again.</p>
                </div>
                <button
                  onClick={handleGeneratePack}
                  disabled={generatingPack}
                  className="flex items-center gap-2 px-6 py-3 bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white text-sm font-semibold rounded-xl transition-colors"
                >
                  {generatingPack
                    ? <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Retrying…</>
                    : '↺ Retry Pack Generation'}
                </button>
              </div>
            )}

            {cycle?.status === 'pack_ready' && (
              <div className="flex items-center justify-between flex-wrap gap-4">
                <div className="flex items-center gap-3">
                  <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-700">
                    ✓ Pack Ready
                  </span>
                  <span className="text-xs text-gray-500">Generated {cycle.pack_generated_at ? new Date(cycle.pack_generated_at).toLocaleDateString() : ''}</span>
                </div>
                <button
                  onClick={() => setShowTestModal(true)}
                  className="flex items-center gap-2 px-5 py-2.5 bg-purple-600 hover:bg-purple-700 text-white text-sm font-semibold rounded-lg transition-colors"
                >
                  📋 Generate Recovery Tests
                </button>
              </div>
            )}

            {cycle?.status === 'generating_tests' && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-purple-600 border-t-transparent rounded-full animate-spin" />
                  <span className="text-sm font-medium text-gray-700">Generating tests…</span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-2">
                  <div
                    className="bg-purple-400 h-2 rounded-full transition-all"
                    style={{
                      width: cycleStatus && cycleStatus.test_progress.total > 0
                        ? `${Math.round((cycleStatus.test_progress.completed / cycleStatus.test_progress.total) * 100)}%`
                        : '10%'
                    }}
                  />
                </div>
                <p className="text-xs text-gray-500">
                  {cycleStatus && cycleStatus.test_progress.total > 0
                    ? `${cycleStatus.test_progress.completed} / ${cycleStatus.test_progress.total} tests done`
                    : 'This may take a few minutes'}
                </p>
              </div>
            )}

            {cycle?.status === 'tests_ready' && (
              <div className="flex items-center gap-3 flex-wrap">
                <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-purple-100 text-purple-700">
                  ⚡ Tests Active
                </span>
                <span className="text-xs text-gray-500">Tests generated {cycle.test_generated_at ? new Date(cycle.test_generated_at).toLocaleDateString() : ''}</span>
              </div>
            )}

            {isLocked && !cycle && (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <span className="text-4xl">🔒</span>
                <p className="text-sm font-semibold text-gray-700">Locked — cooldown period active</p>
                <p className="text-sm text-gray-500">
                  Next cycle available in{' '}
                  <span className="font-semibold text-purple-700">{formatCountdown(cycleStatus!.lockout_until!)}</span>
                </p>
                <button disabled className="px-6 py-3 bg-gray-200 text-gray-400 text-sm font-semibold rounded-xl cursor-not-allowed">
                  ⚡ Generate Recovery Pack
                </button>
              </div>
            )}

            {isLocked && cycle && (
              <div className="mt-3 flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
                🔒 Next cycle available in <span className="font-semibold ml-1">{formatCountdown(cycleStatus!.lockout_until!)}</span>
              </div>
            )}
          </section>

          {/* ── Section 3: Results ──────────────────────────────────────────── */}
          {cycle?.status === 'tests_ready' && (
            <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100">
                <h2 className="text-sm font-semibold text-gray-900">Test Results</h2>
              </div>

              {/* Subject tabs */}
              {subjectsForClassSection.length > 1 && (
                <div className="flex border-b border-gray-100 overflow-x-auto">
                  {subjectsForClassSection.map((subj) => (
                    <button
                      key={subj}
                      onClick={() => setResultSubject(subj)}
                      className={`px-5 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                        resultSubject === subj
                          ? 'border-purple-600 text-purple-700'
                          : 'border-transparent text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      {subj}
                    </button>
                  ))}
                </div>
              )}

              {resultsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="w-5 h-5 border-2 border-purple-600 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : results.length === 0 ? (
                <div className="py-12 text-center text-sm text-gray-400">No results yet for this subject</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 bg-gray-50">
                        <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Student</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Score</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Percentage</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Submitted</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                        <th className="px-4 py-3" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {results.map((r) => (
                        <tr key={r.student_id} className={`hover:bg-gray-50 transition-colors ${r.status === 'not_given' ? 'bg-amber-50' : ''}`}>
                          <td className="px-5 py-3 font-medium text-gray-900">{r.full_name}</td>
                          <td className="px-4 py-3 text-gray-700">
                            {r.status === 'submitted' ? `${r.score ?? 0} / ${r.total_questions ?? 0}` : '—'}
                          </td>
                          <td className={`px-4 py-3 ${pctColor(r.percentage)}`}>
                            {r.status === 'submitted' && r.percentage !== null ? `${r.percentage}%` : '—'}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-500">
                            {r.submitted_at ? new Date(r.submitted_at).toLocaleString() : '—'}
                          </td>
                          <td className="px-4 py-3">
                            {r.status === 'not_given' ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">Not given</span>
                            ) : (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Submitted</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {r.status === 'not_given' && (
                              <button
                                onClick={() => handleRemind(r.student_id)}
                                className="text-xs text-purple-600 hover:text-purple-800 font-medium"
                              >
                                Remind
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </>
  );
}
