'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  recoverySchedulesApi,
  recoveryApi,
  type RecoverySchedule,
  type PostponeReason,
  type RecoveryGenerationStatus,
  type GenerationStatusLevel,
} from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

// ── Status badge styles ───────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  pending_teacher_approval: 'bg-amber-100 text-amber-700',
  approved:                 'bg-green-100 text-green-700',
  postponed:                'bg-blue-100 text-blue-700',
  cancelled:                'bg-gray-100 text-gray-500',
  pack_generated:           'bg-indigo-100 text-indigo-700',
  test_generated:           'bg-purple-100 text-purple-700',
  completed:                'bg-emerald-100 text-emerald-700',
};

const STATUS_LABELS: Record<string, string> = {
  pending_teacher_approval: 'Pending Approval',
  approved:                 'Approved',
  postponed:                'Postponed',
  cancelled:                'Cancelled',
  pack_generated:           'Pack Generated',
  test_generated:           'Test Generated',
  completed:                'Completed',
};

const POSTPONE_REASON_OPTIONS: Array<{ value: PostponeReason; label: string }> = [
  { value: 'unit_test',      label: 'Unit Test' },
  { value: 'final_exam',     label: 'Final Exam' },
  { value: 'school_event',   label: 'School Event' },
  { value: 'teacher_choice', label: 'Teacher Choice' },
  { value: 'other',          label: 'Other' },
];

// ── Generation status badge ───────────────────────────────────────────────────

const GEN_STATUS_STYLES: Record<GenerationStatusLevel, string> = {
  none:       'bg-gray-100 text-gray-400',
  pending:    'bg-gray-100 text-gray-500',
  processing: 'bg-amber-100 text-amber-700',
  completed:  'bg-emerald-100 text-emerald-700',
  failed:     'bg-red-100 text-red-700',
};

function GenStatusBadge({
  label,
  status,
  onRetry,
  retrying,
}: {
  label: string;
  status: GenerationStatusLevel;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  if (status === 'none') return <span className="text-xs text-gray-400">—</span>;

  const labelText =
    status === 'processing' ? `${label}: Generating...` :
    status === 'completed'  ? `${label}: Ready` :
    status === 'failed'     ? `${label}: Failed` :
    `${label}: Pending`;

  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${GEN_STATUS_STYLES[status]}`}>
        {status === 'processing' && (
          <span className="inline-block w-2 h-2 border border-amber-600 border-t-transparent rounded-full animate-spin mr-1" />
        )}
        {labelText}
      </span>
      {status === 'failed' && onRetry && (
        <button
          onClick={onRetry}
          disabled={retrying}
          className="px-2 py-0.5 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 disabled:opacity-50 border border-red-200 rounded-md transition-colors"
        >
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      )}
    </span>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function getMonthLabel(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
}

// ── Toast ─────────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error';
}

let toastId = 0;

function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  return { toasts, show };
}

// ── Postpone inline form ──────────────────────────────────────────────────────

interface PostponeFormProps {
  schedule: RecoverySchedule;
  onConfirm: (id: string, newDate: string, reason: PostponeReason) => Promise<void>;
  onCancel: () => void;
  loading: boolean;
}

function PostponeForm({ schedule, onConfirm, onCancel, loading }: PostponeFormProps) {
  const [newDate, setNewDate]   = useState('');
  const [reason,  setReason]    = useState<PostponeReason>('teacher_choice');
  const [error,   setError]     = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!newDate) { setError('Please select a new test date.'); return; }
    if (!reason)  { setError('Please select a reason.'); return; }
    await onConfirm(schedule.id, newDate, reason);
  }

  return (
    <div className="mt-3 p-4 bg-blue-50 border border-blue-200 rounded-lg">
      <p className="text-xs font-semibold text-blue-800 mb-3">Postpone: {schedule.subject}</p>
      <form onSubmit={handleSubmit} className="space-y-3">
        {error && (
          <p className="text-xs text-red-600 font-medium">{error}</p>
        )}
        <div className="flex gap-3 flex-wrap">
          <div className="flex-1 min-w-40">
            <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor={`date-${schedule.id}`}>
              New test date
            </label>
            <input
              id={`date-${schedule.id}`}
              type="date"
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
              required
            />
          </div>
          <div className="flex-1 min-w-44">
            <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor={`reason-${schedule.id}`}>
              Reason
            </label>
            <select
              id={`reason-${schedule.id}`}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={reason ?? ''}
              onChange={(e) => setReason(e.target.value as PostponeReason)}
              required
            >
              {POSTPONE_REASON_OPTIONS.map((o) => (
                <option key={o.value} value={o.value ?? ''}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors"
          >
            {loading ? 'Saving…' : 'Confirm Postpone'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-xs font-medium text-gray-600 border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Cancel confirm dialog ─────────────────────────────────────────────────────

interface CancelDialogProps {
  schedule: RecoverySchedule;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  loading: boolean;
}

function CancelDialog({ schedule, onConfirm, onClose, loading }: CancelDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
        <h3 className="text-base font-semibold text-gray-900 mb-2">Cancel Recovery Test</h3>
        <p className="text-sm text-gray-600 mb-1">
          Cancel recovery test for <span className="font-semibold text-gray-800">{schedule.subject}</span>
          {' '}(Class {schedule.class}{schedule.section}) this month?
        </p>
        <p className="text-xs text-red-600 font-medium mb-5">
          This will also cancel the Recovery Pack. This cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Keep It
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="px-4 py-2 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 disabled:bg-red-400 rounded-lg transition-colors"
          >
            {loading ? 'Cancelling…' : 'Yes, Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function RecoverySchedulePage() {
  const { toasts, show: showToast } = useToast();

  const [pending,   setPending]   = useState<RecoverySchedule[]>([]);
  const [allMonth,  setAllMonth]  = useState<RecoverySchedule[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');

  // Action states
  const [postponeTarget,    setPostponeTarget]    = useState<string | null>(null);
  const [cancelTarget,      setCancelTarget]      = useState<RecoverySchedule | null>(null);
  const [actionLoading,     setActionLoading]     = useState<string | null>(null); // schedule id

  // Generation status map: scheduleId → RecoveryGenerationStatus
  const [genStatusMap, setGenStatusMap] = useState<Record<string, RecoveryGenerationStatus>>({});
  const [retryingPack, setRetryingPack] = useState<string | null>(null); // schedule id
  const [retryingTest, setRetryingTest] = useState<string | null>(null);

  // ── Fetch data ──────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const [pendingRes, allRes] = await Promise.all([
        recoverySchedulesApi.listPending(token),
        recoverySchedulesApi.listAll(token),
      ]);
      setPending(pendingRes.data ?? []);
      setAllMonth(allRes.data ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load recovery schedules');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Fetch generation status for approved schedules ──────────────────────────
  const fetchGenStatus = useCallback(async (schedules: RecoverySchedule[]) => {
    const token = getToken();
    if (!token) return;

    const approvedSchedules = schedules.filter(
      (s) => !['pending_teacher_approval', 'cancelled'].includes(s.status)
    );

    const results = await Promise.allSettled(
      approvedSchedules.map((s) =>
        recoverySchedulesApi.generationStatus(token, s.id).then((res) => ({
          id: s.id,
          data: res.data,
        }))
      )
    );

    const newMap: Record<string, RecoveryGenerationStatus> = {};
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.data) {
        newMap[result.value.id] = result.value.data;
      }
    }
    setGenStatusMap(newMap);
  }, []);

  useEffect(() => {
    if (allMonth.length > 0) {
      fetchGenStatus(allMonth);
    }
  }, [allMonth, fetchGenStatus]);

  // ── Approve ─────────────────────────────────────────────────────────────────

  async function handleApprove(schedule: RecoverySchedule) {
    const token = getToken();
    if (!token) return;
    setActionLoading(schedule.id);
    try {
      await recoverySchedulesApi.approve(token, schedule.id);
      showToast(`Recovery test approved for ${schedule.subject} — Generation started`);
      await fetchData();
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Failed to approve', 'error');
    } finally {
      setActionLoading(null);
    }
  }

  // ── Postpone ────────────────────────────────────────────────────────────────

  async function handlePostpone(id: string, newDate: string, reason: PostponeReason) {
    const token = getToken();
    if (!token) return;
    setActionLoading(id);
    try {
      await recoverySchedulesApi.postpone(token, id, { new_test_date: newDate, postpone_reason: reason });
      showToast('Recovery test postponed successfully');
      setPostponeTarget(null);
      await fetchData();
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Failed to postpone', 'error');
    } finally {
      setActionLoading(null);
    }
  }

  // ── Cancel ──────────────────────────────────────────────────────────────────

  async function handleCancel() {
    if (!cancelTarget) return;
    const token = getToken();
    if (!token) return;
    setActionLoading(cancelTarget.id);
    try {
      await recoverySchedulesApi.cancel(token, cancelTarget.id);
      showToast(`Recovery test cancelled for ${cancelTarget.subject}`);
      setCancelTarget(null);
      await fetchData();
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Failed to cancel', 'error');
    } finally {
      setActionLoading(null);
    }
  }

  // ── Retry generation ────────────────────────────────────────────────────────

  async function handleRetryPack(scheduleId: string) {
    const token = getToken();
    if (!token) return;
    setRetryingPack(scheduleId);
    try {
      await recoveryApi.generatePack(token, scheduleId);
      showToast('Recovery pack generation restarted');
      // Refresh status after a short delay
      setTimeout(() => {
        fetchGenStatus(allMonth);
      }, 2000);
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Failed to retry pack generation', 'error');
    } finally {
      setRetryingPack(null);
    }
  }

  async function handleRetryTest(scheduleId: string) {
    const token = getToken();
    if (!token) return;
    setRetryingTest(scheduleId);
    try {
      await recoveryApi.generateTest(token, scheduleId);
      showToast('Recovery test generation restarted');
      setTimeout(() => {
        fetchGenStatus(allMonth);
      }, 2000);
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Failed to retry test generation', 'error');
    } finally {
      setRetryingTest(null);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  const currentMonthLabel = allMonth.length > 0
    ? getMonthLabel(allMonth[0].scheduled_month)
    : getMonthLabel(new Date().toISOString().slice(0, 10));

  return (
    <>
      <PageHeader
        title="Recovery Schedule"
        description="Review and confirm monthly recovery tests for your classes"
      />

      {/* Toast notifications */}
      <div className="fixed top-4 right-4 z-50 space-y-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`px-4 py-3 rounded-xl shadow-lg text-sm font-medium pointer-events-auto transition-all ${
              t.type === 'success'
                ? 'bg-green-600 text-white'
                : 'bg-red-600 text-white'
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>

      {/* Cancel dialog */}
      {cancelTarget && (
        <CancelDialog
          schedule={cancelTarget}
          onConfirm={handleCancel}
          onClose={() => setCancelTarget(null)}
          loading={actionLoading === cancelTarget.id}
        />
      )}

      {error && (
        <div className="mb-5 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <>
          {/* ── Section 1: Pending / Postponed ─────────────────────────────── */}
          <section className="mb-8">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-100 text-amber-700 text-xs font-bold">
                  {pending.length}
                </span>
                Awaiting Your Decision
              </h2>
            </div>

            {pending.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-200 py-12 text-center">
                <svg className="mx-auto w-10 h-10 text-gray-300 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-sm text-gray-400">No pending schedules — all caught up!</p>
              </div>
            ) : (
              <div className="space-y-3">
                {pending.map((s) => {
                  const isActioning = actionLoading === s.id;
                  const isPostponing = postponeTarget === s.id;

                  return (
                    <div
                      key={s.id}
                      className={`bg-white rounded-xl border transition-colors ${
                        s.status === 'postponed' ? 'border-blue-200' : 'border-amber-200'
                      }`}
                    >
                      <div className="p-5">
                        {/* Header row */}
                        <div className="flex items-start justify-between gap-3 flex-wrap">
                          <div>
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[s.status]}`}>
                                {STATUS_LABELS[s.status]}
                              </span>
                              <span className="text-xs text-gray-400">{getMonthLabel(s.scheduled_month)}</span>
                            </div>
                            <p className="text-base font-semibold text-gray-900">
                              Class {s.class}{s.section} — {s.subject}
                            </p>
                            <div className="mt-1.5 flex items-center gap-4 flex-wrap text-xs text-gray-500">
                              <span>
                                Test date:{' '}
                                <span className="font-medium text-gray-700">{formatDate(s.scheduled_test_date)}</span>
                              </span>
                              <span>
                                Pack ready:{' '}
                                <span className="font-medium text-gray-700">{formatDate(s.recovery_pack_date)}</span>
                              </span>
                            </div>
                          </div>

                          {/* Action buttons */}
                          {!isPostponing && (
                            <div className="flex items-center gap-2 shrink-0 flex-wrap">
                              <button
                                onClick={() => handleApprove(s)}
                                disabled={isActioning}
                                className="px-3 py-2 text-xs font-semibold text-white bg-green-600 hover:bg-green-700 disabled:bg-green-400 rounded-lg transition-colors flex items-center gap-1.5"
                              >
                                {isActioning && actionLoading === s.id ? (
                                  <span className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" />
                                ) : (
                                  <span>✓</span>
                                )}
                                Generate Now
                              </button>

                              <button
                                onClick={() => setPostponeTarget(s.id)}
                                disabled={isActioning}
                                className="px-3 py-2 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 disabled:opacity-50 rounded-lg transition-colors"
                              >
                                Postpone
                              </button>

                              <button
                                onClick={() => setCancelTarget(s)}
                                disabled={isActioning}
                                className="px-3 py-2 text-xs font-semibold text-red-600 bg-red-50 hover:bg-red-100 disabled:opacity-50 rounded-lg transition-colors"
                              >
                                Cancel This Month
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Postpone inline form */}
                        {isPostponing && (
                          <PostponeForm
                            schedule={s}
                            onConfirm={handlePostpone}
                            onCancel={() => setPostponeTarget(null)}
                            loading={isActioning}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ── Section 2: This Month's Overview (read-only) ───────────────── */}
          <section>
            <h2 className="text-sm font-semibold text-gray-900 mb-3">
              {currentMonthLabel} — All Recovery Tests
            </h2>

            {allMonth.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-200 py-10 text-center">
                <p className="text-sm text-gray-400">No recovery schedules created for this month yet.</p>
                <p className="text-xs text-gray-400 mt-1">The scheduler runs on the 1st of every month.</p>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 bg-gray-50">
                        <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Class</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Subject</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Test Date</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Pack Ready</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Decision</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Generation</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {allMonth.map((s) => {
                        const genStatus = genStatusMap[s.id];
                        const packStatus = genStatus?.pack.status ?? 'none';
                        const testStatus = genStatus?.test.status ?? 'none';
                        const availableDate = genStatus?.test.available_date;

                        return (
                          <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                            <td className="px-5 py-3 font-medium text-gray-900">
                              {s.class} {s.section}
                            </td>
                            <td className="px-4 py-3 text-gray-700">{s.subject}</td>
                            <td className="px-4 py-3 text-gray-600 text-xs">{formatDate(s.scheduled_test_date)}</td>
                            <td className="px-4 py-3 text-gray-600 text-xs">{formatDate(s.recovery_pack_date)}</td>
                            <td className="px-4 py-3">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[s.status] ?? 'bg-gray-100 text-gray-600'}`}>
                                {STATUS_LABELS[s.status] ?? s.status}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-500">
                              {s.teacher_decision === 'generate_now' && '✓ Generate Now'}
                              {s.teacher_decision === 'postpone'     && `↷ Postponed (${s.postpone_reason ?? ''})`}
                              {s.teacher_decision === 'cancel'       && '✗ Cancelled'}
                              {!s.teacher_decision                   && '—'}
                            </td>
                            <td className="px-4 py-3">
                              {s.status === 'cancelled' ? (
                                <span className="text-xs text-gray-400">—</span>
                              ) : (
                                <div className="flex flex-col gap-1.5">
                                  <GenStatusBadge
                                    label="Pack"
                                    status={packStatus}
                                    onRetry={() => handleRetryPack(s.id)}
                                    retrying={retryingPack === s.id}
                                  />
                                  <GenStatusBadge
                                    label={
                                      testStatus === 'completed' && availableDate
                                        ? `Test — Available ${formatDate(availableDate)}`
                                        : 'Test'
                                    }
                                    status={testStatus}
                                    onRetry={() => handleRetryTest(s.id)}
                                    retrying={retryingTest === s.id}
                                  />
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        </>
      )}

      {/* Back link */}
      <div className="mt-6">
        <Link
          href="/teacher/dashboard"
          className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
        >
          ← Back to Dashboard
        </Link>
      </div>
    </>
  );
}
