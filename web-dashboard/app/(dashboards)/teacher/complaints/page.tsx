'use client';

import { useEffect, useState, useCallback } from 'react';
import { complaintsApi, type Complaint } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';
import FormField, { inputClass } from '@/components/FormField';

const STATUS_STYLES: Record<Complaint['status'], string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  reviewed: 'bg-blue-100 text-blue-700',
  resolved: 'bg-green-100 text-green-700',
};

export default function ComplaintsPage() {
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  // Update status modal
  const [updateTarget, setUpdateTarget] = useState<Complaint | null>(null);
  const [newStatus, setNewStatus] = useState<Complaint['status']>('reviewed');
  const [resolutionNote, setResolutionNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [success, setSuccess] = useState('');

  const fetchComplaints = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const res = await complaintsApi.list(token, { status: filterStatus || undefined });
      setComplaints(res.data);
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
    setFormError(''); setSuccess('');
    if (!updateTarget) return;
    const token = getToken();
    if (!token) return;
    setSubmitting(true);
    try {
      await complaintsApi.updateStatus(token, updateTarget.id, {
        status: newStatus,
        resolution_note: resolutionNote.trim() || undefined,
      });
      setSuccess('Status updated successfully.');
      setUpdateTarget(null);
      await fetchComplaints();
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : 'Failed to update status');
    } finally {
      setSubmitting(false);
    }
  }

  const counts = {
    pending: complaints.filter((c) => c.status === 'pending').length,
    reviewed: complaints.filter((c) => c.status === 'reviewed').length,
    resolved: complaints.filter((c) => c.status === 'resolved').length,
  };

  return (
    <>
      <PageHeader title="Complaints" description="View and respond to parent complaints" />

      {/* Status filter tabs */}
      <div className="flex items-center gap-2 mb-4">
        {([
          { value: '', label: 'All', count: complaints.length },
          { value: 'pending', label: 'Pending', count: counts.pending },
          { value: 'reviewed', label: 'Reviewed', count: counts.reviewed },
          { value: 'resolved', label: 'Resolved', count: counts.resolved },
        ]).map((tab) => (
          <button key={tab.value} onClick={() => setFilterStatus(tab.value)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
              filterStatus === tab.value
                ? 'bg-blue-600 text-white border-blue-600'
                : 'text-gray-600 border-gray-300 hover:border-blue-400 hover:text-blue-600'
            }`}>
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
      {error && <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : complaints.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 text-center py-16 text-sm text-gray-400">
          No complaints found.
        </div>
      ) : (
        <div className="space-y-3">
          {complaints.map((c) => (
            <div key={c.id} className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[c.status]}`}>
                      {c.status.charAt(0).toUpperCase() + c.status.slice(1)}
                    </span>
                    <span className="text-xs text-gray-400">
                      {new Date(c.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="font-medium text-gray-900 text-sm">{c.subject}</p>
                  <p className="text-sm text-gray-600 mt-1 line-clamp-2">{c.body}</p>
                  {c.users && (
                    <p className="text-xs text-gray-400 mt-1.5">
                      From: <span className="font-medium text-gray-600">{c.users.name}</span> · {c.users.email}
                    </p>
                  )}
                  {c.resolution_note && (
                    <div className="mt-2 px-3 py-2 bg-gray-50 rounded-lg border border-gray-200">
                      <p className="text-xs text-gray-500 font-medium mb-0.5">Resolution note:</p>
                      <p className="text-xs text-gray-700">{c.resolution_note}</p>
                    </div>
                  )}
                </div>

                {c.status !== 'resolved' && (
                  <button onClick={() => openUpdate(c)}
                    className="shrink-0 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors">
                    Update Status
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Update Status Modal ────────────────────────────────────────────── */}
      <Modal open={!!updateTarget} onClose={() => setUpdateTarget(null)} title="Update Complaint Status">
        <form onSubmit={handleUpdateStatus} className="space-y-4">
          {formError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{formError}</div>
          )}

          {updateTarget && (
            <div className="px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg">
              <p className="text-xs text-gray-500 font-medium mb-0.5">Complaint</p>
              <p className="text-sm font-medium text-gray-900">{updateTarget.subject}</p>
            </div>
          )}

          <FormField label="New Status" htmlFor="c-status" required>
            <select id="c-status" className={inputClass}
              value={newStatus} onChange={(e) => setNewStatus(e.target.value as Complaint['status'])}>
              <option value="reviewed">Reviewed</option>
              <option value="resolved">Resolved</option>
            </select>
          </FormField>

          <FormField label="Resolution Note" htmlFor="c-note">
            <textarea id="c-note" rows={3} className={`${inputClass} resize-none`}
              placeholder="Optional — describe the action taken…"
              value={resolutionNote} onChange={(e) => setResolutionNote(e.target.value)} />
          </FormField>

          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={() => setUpdateTarget(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors">
              {submitting ? 'Saving…' : 'Save Status'}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
