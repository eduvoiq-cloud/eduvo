'use client';

import { useEffect, useState, useCallback } from 'react';
import { requestsApi, type StudentRequest } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';
import FormField, { inputClass } from '@/components/FormField';

const STATUS_STYLES: Record<StudentRequest['status'], string> = {
  pending:  'bg-yellow-100 text-yellow-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
};

function parseUtcDate(iso: string): Date {
  if (iso && !iso.endsWith('Z') && !iso.includes('+') && !/\d{2}:\d{2}$/.test(iso)) {
    return new Date(iso + 'Z');
  }
  return new Date(iso);
}

export default function RequestsPage() {
  const [requests, setRequests] = useState<StudentRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  // Action modal
  const [actionTarget, setActionTarget] = useState<StudentRequest | null>(null);
  const [newStatus, setNewStatus] = useState<'approved' | 'rejected'>('approved');
  const [resolutionNote, setResolutionNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [success, setSuccess] = useState('');

  const fetchRequests = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const res = await requestsApi.list(token, { status: filterStatus || undefined });
      setRequests(res.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load requests');
    } finally {
      setLoading(false);
    }
  }, [filterStatus]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  function openAction(req: StudentRequest, status: 'approved' | 'rejected') {
    setActionTarget(req);
    setNewStatus(status);
    setResolutionNote('');
    setFormError('');
  }

  async function handleAction(e: React.FormEvent) {
    e.preventDefault();
    setFormError(''); setSuccess('');
    if (!actionTarget) return;
    const token = getToken();
    if (!token) return;
    setSubmitting(true);
    try {
      await requestsApi.updateStatus(token, actionTarget.id, {
        status: newStatus,
        resolution_note: resolutionNote.trim() || undefined,
      });
      setSuccess(`Request ${newStatus} successfully.`);
      setActionTarget(null);
      await fetchRequests();
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : 'Failed to update request');
    } finally {
      setSubmitting(false);
    }
  }

  const counts = {
    pending:  requests.filter((r) => r.status === 'pending').length,
    approved: requests.filter((r) => r.status === 'approved').length,
    rejected: requests.filter((r) => r.status === 'rejected').length,
  };

  return (
    <>
      <PageHeader title="Requests" description="View and respond to student requests" />

      {/* Status filter tabs */}
      <div className="flex items-center gap-2 mb-4">
        {([
          { value: '', label: 'All', count: requests.length },
          { value: 'pending', label: 'Pending', count: counts.pending },
          { value: 'approved', label: 'Approved', count: counts.approved },
          { value: 'rejected', label: 'Rejected', count: counts.rejected },
        ]).map((tab) => (
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
              filterStatus === tab.value ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'
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
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : requests.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 text-center py-16 text-sm text-gray-400">
          No requests found.
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map((r) => (
            <div key={r.id} className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[r.status]}`}>
                      {r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                    </span>
                    <span className="text-xs text-gray-400">
                      {parseUtcDate(r.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="font-medium text-gray-900 text-sm">{r.subject ?? 'No subject'}</p>
                  <p className="text-sm text-gray-600 mt-1 line-clamp-2">{r.message}</p>
                  {r.student_name && (
                    <p className="text-xs text-gray-400 mt-1.5">
                      From: <span className="font-medium text-gray-600">{r.student_name}</span>
                      {r.class_name && (
                        <> · Class {r.class_name}{r.section ? ` ${r.section}` : ''}</>
                      )}
                    </p>
                  )}
                  {r.resolution_note && (
                    <div className="mt-2 px-3 py-2 bg-gray-50 rounded-lg border border-gray-200">
                      <p className="text-xs text-gray-500 font-medium mb-0.5">Note:</p>
                      <p className="text-xs text-gray-700">{r.resolution_note}</p>
                    </div>
                  )}
                </div>

                {r.status === 'pending' && (
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={() => openAction(r, 'approved')}
                      className="px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 hover:bg-green-100 rounded-md transition-colors"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => openAction(r, 'rejected')}
                      className="px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Action Modal ─────────────────────────────────────────────────────── */}
      <Modal
        open={!!actionTarget}
        onClose={() => setActionTarget(null)}
        title={newStatus === 'approved' ? 'Approve Request' : 'Reject Request'}
      >
        <form onSubmit={handleAction} className="space-y-4">
          {formError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {formError}
            </div>
          )}

          {actionTarget && (
            <div className="px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg">
              <p className="text-xs text-gray-500 font-medium mb-0.5">Request from</p>
              <p className="text-sm font-medium text-gray-900">
                {actionTarget.student_name ?? 'Unknown Student'}
                {actionTarget.class_name && (
                  <span className="font-normal text-gray-500">
                    {' '}· Class {actionTarget.class_name}
                    {actionTarget.section ? ` ${actionTarget.section}` : ''}
                  </span>
                )}
              </p>
              {actionTarget.subject && (
                <p className="text-xs text-gray-600 mt-0.5">{actionTarget.subject}</p>
              )}
            </div>
          )}

          <FormField label="Note (optional)" htmlFor="r-note">
            <textarea
              id="r-note"
              rows={3}
              className={`${inputClass} resize-none`}
              placeholder={
                newStatus === 'approved'
                  ? 'Optional — add any instructions or remarks…'
                  : 'Optional — explain why the request is being rejected…'
              }
              value={resolutionNote}
              onChange={(e) => setResolutionNote(e.target.value)}
            />
          </FormField>

          <div className="flex justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={() => setActionTarget(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors ${
                newStatus === 'approved'
                  ? 'bg-green-600 hover:bg-green-700 disabled:bg-green-400'
                  : 'bg-red-600 hover:bg-red-700 disabled:bg-red-400'
              }`}
            >
              {submitting
                ? 'Saving…'
                : newStatus === 'approved'
                ? 'Approve Request'
                : 'Reject Request'}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
