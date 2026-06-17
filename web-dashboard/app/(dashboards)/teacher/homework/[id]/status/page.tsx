'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import { inputClass } from '@/components/FormField';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

type SubmissionStatus = 'not_submitted' | 'submitted' | 'processing' | 'checked' | 'flagged_for_review';
type AIResult = 'correct' | 'incorrect' | 'partial' | 'needs_review' | null;

interface StudentRow {
  student_id: string;
  student_name: string;
  roll_number: string | null;
  status: SubmissionStatus;
  ai_result: AIResult;
  ai_feedback: string | null;
  ai_confidence: number | null;
  submitted_at: string | null;
  flagged_reason: string | null;
}

interface HomeworkStatusData {
  homework_id: string;
  title: string;
  subject_name: string | null;
  class_name: string;
  section: string;
  students: StudentRow[];
}

// ── Status helpers ────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<SubmissionStatus, string> = {
  not_submitted: 'Not Submitted',
  submitted: 'Submitted',
  processing: 'Processing',
  checked: 'Checked',
  flagged_for_review: 'Flagged',
};

const AI_RESULT_LABELS: Record<NonNullable<AIResult>, string> = {
  correct: 'Correct',
  incorrect: 'Incorrect',
  partial: 'Partial',
  needs_review: 'Needs Review',
};

function statusBadgeClass(status: SubmissionStatus): string {
  switch (status) {
    case 'not_submitted':    return 'bg-red-100 text-red-700';
    case 'submitted':        return 'bg-yellow-100 text-yellow-700';
    case 'processing':       return 'bg-blue-100 text-blue-700';
    case 'checked':          return 'bg-green-100 text-green-700';
    case 'flagged_for_review': return 'bg-orange-100 text-orange-700';
    default:                 return 'bg-gray-100 text-gray-600';
  }
}

function aiResultBadgeClass(result: AIResult): string {
  if (!result) return '';
  switch (result) {
    case 'correct':      return 'bg-green-100 text-green-700';
    case 'incorrect':    return 'bg-red-100 text-red-700';
    case 'partial':      return 'bg-yellow-100 text-yellow-700';
    case 'needs_review': return 'bg-orange-100 text-orange-700';
    default:             return 'bg-gray-100 text-gray-600';
  }
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = (iso && !iso.endsWith('Z') && !iso.includes('+') && !/\d{2}:\d{2}$/.test(iso))
    ? new Date(iso + 'Z') : new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function StatusSkeleton() {
  return (
    <div className="space-y-2">
      {[1,2,3,4,5].map((i) => (
        <div key={i} className="bg-white rounded-xl border border-gray-200 p-4 animate-pulse">
          <div className="flex items-center gap-4">
            <div className="h-4 w-6 bg-gray-200 rounded" />
            <div className="h-4 w-32 bg-gray-200 rounded flex-1" />
            <div className="h-5 w-24 bg-gray-200 rounded-full" />
            <div className="h-4 w-20 bg-gray-200 rounded" />
            <div className="h-4 w-16 bg-gray-200 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Stats bar ─────────────────────────────────────────────────────────────────

function StatsBar({ students }: { students: StudentRow[] }) {
  const total = students.length;
  const notSubmitted = students.filter((s) => s.status === 'not_submitted').length;
  const submitted = students.filter((s) => s.status === 'submitted').length;
  const checked = students.filter((s) => s.status === 'checked').length;
  const flagged = students.filter((s) => s.status === 'flagged_for_review').length;

  const pct = (n: number) => total > 0 ? Math.round((n / total) * 100) : 0;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
      <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-center">
        <p className="text-2xl font-bold text-red-700">{notSubmitted}</p>
        <p className="text-xs text-red-600 mt-0.5">Not Submitted</p>
        <p className="text-xs text-red-400 mt-0.5">{pct(notSubmitted)}%</p>
      </div>
      <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-center">
        <p className="text-2xl font-bold text-yellow-700">{submitted}</p>
        <p className="text-xs text-yellow-600 mt-0.5">Submitted</p>
        <p className="text-xs text-yellow-400 mt-0.5">{pct(submitted)}%</p>
      </div>
      <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
        <p className="text-2xl font-bold text-green-700">{checked}</p>
        <p className="text-xs text-green-600 mt-0.5">Checked</p>
        <p className="text-xs text-green-400 mt-0.5">{pct(checked)}%</p>
      </div>
      <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 text-center">
        <p className="text-2xl font-bold text-orange-700">{flagged}</p>
        <p className="text-xs text-orange-600 mt-0.5">Flagged</p>
        <p className="text-xs text-orange-400 mt-0.5">{pct(flagged)}%</p>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function HomeworkStatusPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const homeworkId = params.id;

  const [data, setData] = useState<HomeworkStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // Filters
  const [showNotSubmittedOnly, setShowNotSubmittedOnly] = useState(false);
  const [search, setSearch] = useState('');

  const fetchStatus = useCallback(async () => {
    const token = getToken();
    if (!token || !homeworkId) return;
    try {
      const res = await fetch(`${BASE_URL}/api/homework/${homeworkId}/submissions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to load');
      setData(json.data as HomeworkStatusData);
      setLastRefresh(new Date());
      setError('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load submission status');
    } finally {
      setLoading(false);
    }
  }, [homeworkId]);

  // Initial load + poll every 30 seconds
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Derived list
  const displayedStudents = (data?.students ?? []).filter((s) => {
    if (showNotSubmittedOnly && s.status !== 'not_submitted') return false;
    if (search) {
      const q = search.toLowerCase();
      if (!s.student_name.toLowerCase().includes(q) && !(s.roll_number ?? '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // Sort: not_submitted first, then by roll number / name
  const sorted = [...displayedStudents].sort((a, b) => {
    const order: Record<SubmissionStatus, number> = { not_submitted: 0, submitted: 1, processing: 2, checked: 3, flagged_for_review: 4 };
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    if (a.roll_number && b.roll_number) return a.roll_number.localeCompare(b.roll_number, undefined, { numeric: true });
    return a.student_name.localeCompare(b.student_name);
  });

  if (loading) {
    return (
      <>
        <PageHeader title="Homework Status" description="Loading…" />
        <StatusSkeleton />
      </>
    );
  }

  if (error) {
    return (
      <>
        <PageHeader title="Homework Status" description="" />
        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={data?.title ?? 'Homework Status'}
        description={data ? `${data.class_name} · ${data.section}${data.subject_name ? ` · ${data.subject_name}` : ''}` : ''}
        action={
          <div className="flex items-center gap-2">
            <button onClick={() => router.push('/teacher/homework')}
              className="px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              ← Back
            </button>
            {data && data.students.some((s) => s.status === 'flagged_for_review') && (
              <button onClick={() => router.push(`/teacher/homework/${homeworkId}/review`)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 rounded-lg transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                </svg>
                Review Flagged ({data.students.filter((s) => s.status === 'flagged_for_review').length})
              </button>
            )}
            <button onClick={() => { setLoading(true); fetchStatus(); }}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Refresh
            </button>
          </div>
        }
      />

      {/* Stats */}
      {data && <StatsBar students={data.students} />}

      {/* Controls */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4 flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="flex-1 min-w-[160px]">
          <input
            type="text"
            className={inputClass}
            placeholder="Search by name or roll no…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Not submitted only toggle */}
        <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-gray-700">
          <div
            role="switch"
            aria-checked={showNotSubmittedOnly}
            onClick={() => setShowNotSubmittedOnly((v) => !v)}
            className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
              showNotSubmittedOnly ? 'bg-red-500' : 'bg-gray-200'
            }`}
          >
            <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition duration-200 ${
              showNotSubmittedOnly ? 'translate-x-4' : 'translate-x-0'
            }`} />
          </div>
          Show Not Submitted Only
        </label>

        {/* Last refresh */}
        {lastRefresh && (
          <span className="text-xs text-gray-400 ml-auto">
            Updated {lastRefresh.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {' · '}auto-refreshes every 30s
          </span>
        )}
      </div>

      {/* Table */}
      {sorted.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm text-gray-500">
            {showNotSubmittedOnly ? 'All students have submitted! 🎉' : 'No students found'}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {/* Header */}
          <div className="grid grid-cols-12 gap-2 px-4 py-2.5 bg-gray-50 border-b border-gray-200 text-xs font-medium text-gray-500 uppercase tracking-wide">
            <div className="col-span-1">#</div>
            <div className="col-span-4">Student</div>
            <div className="col-span-2">Status</div>
            <div className="col-span-2">AI Result</div>
            <div className="col-span-2">Submitted</div>
            <div className="col-span-1">Conf.</div>
          </div>

          {/* Rows */}
          <div className="divide-y divide-gray-100">
            {sorted.map((s, idx) => (
              <div key={s.student_id}
                className={`grid grid-cols-12 gap-2 px-4 py-3 text-sm items-center hover:bg-gray-50 transition-colors ${
                  s.status === 'not_submitted' ? 'bg-red-50/30' : ''
                }`}>
                {/* Roll / index */}
                <div className="col-span-1 text-xs text-gray-400">{s.roll_number ?? idx + 1}</div>

                {/* Student name */}
                <div className="col-span-4">
                  <p className="font-medium text-gray-900 truncate">{s.student_name}</p>
                  {s.flagged_reason && (
                    <p className="text-xs text-orange-500 mt-0.5">⚑ {s.flagged_reason.replace(/_/g, ' ')}</p>
                  )}
                  {s.ai_feedback && s.status === 'checked' && (
                    <p className="text-xs text-gray-400 mt-0.5 line-clamp-1" title={s.ai_feedback}>
                      {s.ai_feedback}
                    </p>
                  )}
                </div>

                {/* Status */}
                <div className="col-span-2">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusBadgeClass(s.status)}`}>
                    {STATUS_LABELS[s.status]}
                  </span>
                </div>

                {/* AI Result */}
                <div className="col-span-2">
                  {s.ai_result ? (
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${aiResultBadgeClass(s.ai_result)}`}
                      title={s.ai_feedback ?? undefined}
                    >
                      {AI_RESULT_LABELS[s.ai_result]}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-300">—</span>
                  )}
                </div>

                {/* Submitted at */}
                <div className="col-span-2 text-xs text-gray-500">
                  {formatTime(s.submitted_at)}
                </div>

                {/* AI confidence */}
                <div className="col-span-1 text-xs text-gray-500">
                  {s.ai_confidence != null ? `${Math.round(s.ai_confidence * 100)}%` : '—'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

    </>
  );
}
