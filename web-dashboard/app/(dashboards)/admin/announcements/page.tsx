'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import FormField, { inputClass } from '@/components/FormField';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

type AudienceType = 'everyone' | 'teachers' | 'students';
type NotifType = 'announcement' | 'alert' | 'reminder';

interface ComposeForm {
  title: string;
  message: string;
  type: NotifType;
  audience: AudienceType;
}

const EMPTY_FORM: ComposeForm = {
  title: '',
  message: '',
  type: 'announcement',
  audience: 'everyone',
};

interface AnnouncementRecord {
  id: string;
  title: string;
  message: string;
  target_audience: string;
  created_at: string;
  sender_role: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} minute${mins !== 1 ? 's' : ''} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs !== 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} day${days !== 1 ? 's' : ''} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months !== 1 ? 's' : ''} ago`;
}

const AUDIENCE_LABELS: Record<AudienceType, string> = {
  everyone: 'Everyone',
  teachers: 'Teachers only',
  students: 'Students only',
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AnnouncementsPage() {
  useAuth(); // keep context subscription for future use

  const [form, setForm] = useState<ComposeForm>(EMPTY_FORM);
  const [sending, setSending] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  const [announcements, setAnnouncements] = useState<AnnouncementRecord[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // ── Fetch previously sent announcements ────────────────────────────────────

  const fetchAnnouncements = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoadingList(true);
    setListError('');
    try {
      const res = await fetch(`${BASE_URL}/api/announcements/school`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to load announcements');
      setAnnouncements(json.data ?? []);
    } catch (err: unknown) {
      setListError(err instanceof Error ? err.message : 'Failed to load announcements');
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    fetchAnnouncements();
  }, [fetchAnnouncements]);

  // ── Send ──────────────────────────────────────────────────────────────────

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!form.title.trim() || !form.message.trim()) {
      setError('Title and message are required.');
      return;
    }

    const token = getToken();
    if (!token) return;
    setSending(true);
    try {
      const res = await fetch(`${BASE_URL}/api/announcements/admin`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: form.title.trim(),
          message: form.message.trim(),
          audience: form.audience,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to send announcement');
      const count = json.data?.recipient_count ?? 0;
      setSuccess(`Announcement sent to ${count} recipient${count !== 1 ? 's' : ''}.`);
      setForm(EMPTY_FORM);
      fetchAnnouncements();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send announcement');
    } finally {
      setSending(false);
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete(id: string) {
    const token = getToken();
    if (!token) return;
    setDeletingId(id);
    try {
      const res = await fetch(`${BASE_URL}/api/announcements/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Delete failed');
      setAnnouncements((prev) => prev.filter((a) => a.id !== id));
    } catch {
      // non-fatal, just refresh
      fetchAnnouncements();
    } finally {
      setDeletingId(null);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader
        title="Announcements"
        description="Send notifications to teachers, parents, and students"
      />

      <div className="max-w-2xl">
        {/* Success */}
        {success && (
          <div className="mb-4 px-4 py-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700 flex items-center gap-2">
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {success}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        <form onSubmit={handleSend} className="bg-white rounded-xl border border-gray-200 p-6 space-y-5 mb-8">

          {/* Type */}
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">Notification Type</p>
            <div className="flex gap-2">
              {(['announcement', 'alert', 'reminder'] as NotifType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, type: t }))}
                  className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors capitalize ${
                    form.type === t
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'text-gray-600 border-gray-300 hover:border-blue-400 hover:text-blue-600'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Title */}
          <FormField label="Title" htmlFor="ann-title" required>
            <input
              id="ann-title"
              type="text"
              className={inputClass}
              placeholder="e.g. School closed on Friday"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              required
            />
          </FormField>

          {/* Message */}
          <FormField label="Message" htmlFor="ann-body" required>
            <textarea
              id="ann-body"
              rows={5}
              className={`${inputClass} resize-none`}
              placeholder="Write your announcement here…"
              value={form.message}
              onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
              required
            />
          </FormField>

          {/* Audience */}
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">Send To</p>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { value: 'everyone', label: 'Everyone' },
                  { value: 'teachers', label: 'Teachers only' },
                  { value: 'students', label: 'Students only' },
                ] as { value: AudienceType; label: string }[]
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, audience: opt.value }))}
                  className={`px-3 py-2 text-xs font-medium rounded-lg border transition-colors text-center ${
                    form.audience === opt.value
                      ? 'bg-blue-50 text-blue-700 border-blue-300'
                      : 'text-gray-600 border-gray-200 hover:border-blue-300 hover:text-blue-600'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-gray-400">
              {form.audience === 'everyone' && 'All teachers and students in your school will see this.'}
              {form.audience === 'teachers' && 'Only teachers in your school will see this.'}
              {form.audience === 'students' && 'Only students will see this in their announcements feed.'}
            </p>
          </div>

          <div className="pt-2 border-t border-gray-100">
            <button
              type="submit"
              disabled={sending}
              className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {sending ? (
                <>
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Sending…
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                  Send Announcement
                </>
              )}
            </button>
          </div>
        </form>

        {/* ── Previously Sent ──────────────────────────────────────────────── */}
        <div>
          <h2 className="text-base font-semibold text-gray-900 mb-4">Previously Sent</h2>

          {loadingList ? (
            <div className="space-y-3">
              {[1, 2].map((i) => (
                <div key={i} className="bg-white rounded-xl border border-gray-200 p-5 animate-pulse space-y-3">
                  <div className="h-4 w-1/3 bg-gray-200 rounded" />
                  <div className="h-3 bg-gray-200 rounded w-full" />
                  <div className="h-3 bg-gray-200 rounded w-2/3" />
                </div>
              ))}
            </div>
          ) : listError ? (
            <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {listError}
            </div>
          ) : announcements.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center bg-white rounded-xl border border-gray-200">
              <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mb-3">
                <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
                </svg>
              </div>
              <p className="text-sm text-gray-500">No announcements sent yet</p>
            </div>
          ) : (
            <div className="space-y-3">
              {announcements.map((ann) => (
                <AdminAnnouncementCard
                  key={ann.id}
                  announcement={ann}
                  deleting={deletingId === ann.id}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Announcement Card ─────────────────────────────────────────────────────────

function AdminAnnouncementCard({
  announcement,
  deleting,
  onDelete,
}: {
  announcement: AnnouncementRecord;
  deleting: boolean;
  onDelete: (id: string) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const audienceLabel =
    AUDIENCE_LABELS[(announcement.target_audience as AudienceType) ?? 'everyone'] ?? 'Everyone';

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-gray-900 leading-snug mb-1">
            {announcement.title}
          </h3>
          <p className="text-sm text-gray-600 line-clamp-2 mb-3">
            {announcement.message}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
              📢 {audienceLabel}
            </span>
            <span className="text-xs text-gray-400 ml-auto">
              {timeAgo(announcement.created_at)}
            </span>
          </div>
        </div>

        <div className="shrink-0">
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              aria-label="Delete announcement"
              disabled={deleting}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500 mr-1">Sure?</span>
              <button
                onClick={() => { onDelete(announcement.id); setConfirmDelete(false); }}
                disabled={deleting}
                className="px-2.5 py-1 text-xs font-medium text-white bg-red-600 hover:bg-red-700 disabled:bg-red-400 rounded-md transition-colors"
              >
                {deleting ? '…' : 'Yes'}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-2.5 py-1 text-xs font-medium text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
              >
                No
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
