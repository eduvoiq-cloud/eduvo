'use client';

import { useEffect, useState, useCallback, Suspense } from 'react';
import { useAuth } from '@/context/AuthContext';
import { complaintsApi, type Complaint } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';
import FormField, { inputClass } from '@/components/FormField';

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<Complaint['status'], { badge: string; dot: string }> = {
  pending:  { badge: 'bg-yellow-100 text-yellow-700', dot: 'bg-yellow-400' },
  reviewed: { badge: 'bg-blue-100 text-blue-700',    dot: 'bg-blue-400'   },
  resolved: { badge: 'bg-green-100 text-green-700',  dot: 'bg-green-500'  },
};

/**
 * Parse an ISO timestamp as UTC. Supabase may return timestamptz values without
 * a timezone designator, which JavaScript would interpret as local time.
 */
function parseUtcDate(iso: string): Date {
  if (iso && !iso.endsWith('Z') && !iso.includes('+') && !/\d{2}:\d{2}$/.test(iso)) {
    return new Date(iso + 'Z');
  }
  return new Date(iso);
}

function timeAgo(iso: string): string {
  const diff = Date.now() - parseUtcDate(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Inner component ───────────────────────────────────────────────────────────

function ComplaintsPageInner() {
  const { user } = useAuth();
  void user;

  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [success, setSuccess] = useState('');

  // Update status modal
  const [updateTarget, setUpdateTarget] = useState<Complaint | null>(null);
  const [newStatus, setNewStatus] = useState<Complaint['status']>('reviewed');
  const [resolutionNote, setResolutionNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const fetchComplaints = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const res = await complaintsApi.list(token, {
        status: filterStatus || undefined,
        role: 'schooladmin',
      });
      setComplaints(res.data ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load complaints');
    } finally {
      setLoading(false);
    }
  }, [filterStatus]);

  useEffect(() => { fetchComplaints(); }, [fetchComplaints]);

  function openUpdate(complaint: Complaint) {
    setUpdateTarget(complaint);
    setNewStatus(complaint.status === 'pending' ? 'reviewed' : 'resolved');
    setResolutionNote('');
    setFormError('');
  }

  async function handleUpdateStatus(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    setSuccess('');
    if (!updateTarget) return;
    const token = getToken();
    if (!token) return;
    setSubmitting(true);
    try {
      await complaintsApi.updateStatus(token, updateTarget.id, {
        status: newStatus,
        resolution_note: resolutionNote.trim() || undefined,
      });
      setSuccess('Complaint status updated.');
      setUpdateTarget(null);
      await fetchComplaints();
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : 'Failed to update status');
    } finally {
      setSubmitting(false);
    }
  }

  const counts = {
    all: complaints.length,
    pending:  complaints.filter((c) => c.status === 'pending').length,
    reviewed: complaints.filter((c) => c.status === 'reviewed').length,
    resolved: complaints.filter((c) => c.status === 'resolved').length,
  };

  const TABS = [
    { value: '',         label: 'All',      count: counts.all      },
    { value: 'pending',  label: 'Pending',  count: counts.pending  },
    { value: 'reviewed', label: 'Reviewed', count: counts.reviewed },
    { value: 'resolved', label: 'Resolved', count: counts.resolved },
  ];

  return (
    <>
      <PageHeader
        title="Complaints"
        description="Student complaints submitted to school administration"
      />

      {/* Status filter tabs */}
      <div className="flex items-center gap-2 mb-5 flex-wrap">
        {TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setFilterStatus(tab.value)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
              filterStatus === tab.value
                ? 'bg-blue-600 text-white border-blue-600'
                : 'text-gray-600 border-gray-300 hover:border-blue-400 hover:text-blue-600'
            }`}
          >
            {tab.label}
            <span className={`px-1.5 py-0.5 rounded-full text-xs ${
              filterStatus === tab.value
                ? 'bg-white/20 text-white'
                : 'bg-gray-100 text-gray-500'
            }`}>
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {/* Feedback */}
      {success && (
        <div className="mb-4 px-4 py-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700 flex items-center gap-2">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {success}
        </div>
      )}
      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : complaints.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 text-center py-16">
          <p className="text-2xl mb-2">📋</p>
          <p className="text-sm text-gray-400">No complaints found.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {complaints.map((c) => {
            const styles = STATUS_STYLES[c.status];
            const messageText = c.message ?? c.body ?? '';
            return (
              <div key={c.id} className="bg-white rounded-xl border border-gray-200 p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    {/* Header row */}
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${styles.badge}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${styles.dot}`} />
                        {c.status.charAt(0).toUpperCase() + c.status.slice(1)}
                      </span>
                      {c.recipient_type && (
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                          {c.recipient_type === 'school_admin' ? 'School Admin' : 'Subject Teacher'}
                        </span>
                      )}
                      <span className="text-xs text-gray-400">{timeAgo(c.created_at)}</span>
                    </div>

                    {/* Subject */}
                    {c.subject ? (
                      <p className="font-semibold text-gray-900 text-sm mb-1">{c.subject}</p>
                    ) : (
                      <p className="font-semibold text-gray-400 text-sm mb-1 italic">No subject</p>
                    )}

                    {/* Message */}
                    {messageText && (
                      <p className="text-sm text-gray-600 line-clamp-2 mb-2">{messageText}</p>
                    )}

                    {/* Student info */}
                    {c.student_name && (
                      <p className="text-xs text-gray-400">
                        From:{' '}
                        <span className="font-medium text-gray-600">{c.student_name}</span>
                        {c.class_name && (
                          <> · {c.class_name}{c.section ? ` ${c.section}` : ''}</>
                        )}
                      </p>
                    )}

                    {/* Resolution note */}
                    {c.resolution_note && (
                      <div className="mt-3 px-3 py-2 bg-green-50 rounded-lg border border-green-100">
                        <p className="text-xs text-green-700 font-medium mb-0.5">Response</p>
                        <p className="text-xs text-gray-700">{c.resolution_note}</p>
                      </div>
                    )}
                  </div>

                  {/* Action */}
                  {c.status !== 'resolved' && (
                    <button
                      onClick={() => openUpdate(c)}
                      className="shrink-0 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors"
                    >
                      Respond
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Update Status Modal ──────────────────────────────────────────────── */}
      <Modal
        open={!!updateTarget}
        onClose={() => setUpdateTarget(null)}
        title="Respond to Complaint"
      >
        <form onSubmit={handleUpdateStatus} className="space-y-4">
          {formError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {formError}
            </div>
          )}

          {updateTarget && (
            <div className="px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg">
              <p className="text-xs text-gray-500 font-medium mb-1">Complaint from</p>
              <p className="text-sm font-semibold text-gray-900">
                {updateTarget.student_name ?? 'Unknown student'}
                {updateTarget.class_name && (
                  <span className="text-gray-500 font-normal">
                    {' '}· {updateTarget.class_name}{updateTarget.section ? ` ${updateTarget.section}` : ''}
                  </span>
                )}
              </p>
              {updateTarget.subject && (
                <p className="text-xs text-gray-600 mt-0.5">{updateTarget.subject}</p>
              )}
            </div>
          )}

          <FormField label="Update Status" htmlFor="c-status" required>
            <select
              id="c-status"
              className={inputClass}
              value={newStatus}
              onChange={(e) => setNewStatus(e.target.value as Complaint['status'])}
            >
              <option value="reviewed">Reviewed</option>
              <option value="resolved">Resolved</option>
            </select>
          </FormField>

          <FormField label="Response / Resolution Note" htmlFor="c-note">
            <textarea
              id="c-note"
              rows={4}
              className={`${inputClass} resize-none`}
              placeholder="Describe what action was taken or your response to the student…"
              value={resolutionNote}
              onChange={(e) => setResolutionNote(e.target.value)}
            />
          </FormField>

          <div className="flex justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={() => setUpdateTarget(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors"
            >
              {submitting ? 'Saving…' : 'Save Response'}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}

export default function AdminComplaintsPage() {
  return (
    <Suspense>
      <ComplaintsPageInner />
    </Suspense>
  );
}
