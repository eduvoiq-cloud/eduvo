'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { notificationsApi, usersApi, studentsApi, type Teacher, type Student } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import FormField, { inputClass } from '@/components/FormField';

// ── Types ─────────────────────────────────────────────────────────────────────

type AudienceType = 'all' | 'teachers' | 'parents' | 'custom';
type NotifType = 'announcement' | 'alert' | 'reminder';

interface ComposeForm {
  title: string;
  body: string;
  type: NotifType;
  audience: AudienceType;
  custom_ids: string[];
}

const EMPTY_FORM: ComposeForm = {
  title: '', body: '', type: 'announcement', audience: 'all', custom_ids: [],
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AnnouncementsPage() {
  const { user } = useAuth();

  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  const [form, setForm] = useState<ComposeForm>(EMPTY_FORM);

  // ── Fetch recipients ──────────────────────────────────────────────────────

  const fetchRecipients = useCallback(async () => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    setLoading(true);
    try {
      const [tRes, sRes] = await Promise.all([
        usersApi.list(token, { role: 'teacher', school_id: user.school_id }),
        studentsApi.list(token, user.school_id),
      ]);
      setTeachers(tRes.data);
      setStudents((sRes.data as unknown as Student[]) ?? []);
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { fetchRecipients(); }, [fetchRecipients]);

  // ── Resolve recipient IDs ─────────────────────────────────────────────────

  function resolveRecipientIds(): string[] {
    switch (form.audience) {
      case 'all':
        // teachers + parents (students with parent_id)
        return [
          ...teachers.map((t) => t.id),
          ...students.filter((s) => s.parent_id).map((s) => s.parent_id as string),
        ];
      case 'teachers':
        return teachers.map((t) => t.id);
      case 'parents':
        return students.filter((s) => s.parent_id).map((s) => s.parent_id as string);
      case 'custom':
        return form.custom_ids;
      default:
        return [];
    }
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!form.title.trim() || !form.body.trim()) {
      setError('Title and message are required.');
      return;
    }

    const recipient_ids = [...new Set(resolveRecipientIds())]; // deduplicate
    if (recipient_ids.length === 0) {
      setError('No recipients found for the selected audience. Make sure teachers or parents are registered.');
      return;
    }

    const token = getToken();
    if (!token) return;
    setSending(true);
    try {
      await notificationsApi.send(token, {
        title: form.title.trim(),
        body: form.body.trim(),
        type: form.type,
        recipient_ids,
      });
      setSuccess(`Announcement sent to ${recipient_ids.length} recipient${recipient_ids.length !== 1 ? 's' : ''}.`);
      setForm(EMPTY_FORM);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to send announcement');
    } finally {
      setSending(false);
    }
  }

  // ── Toggle custom recipient ───────────────────────────────────────────────

  function toggleCustomId(id: string) {
    setForm((f) => ({
      ...f,
      custom_ids: f.custom_ids.includes(id)
        ? f.custom_ids.filter((x) => x !== id)
        : [...f.custom_ids, id],
    }));
  }

  const recipientCount = [...new Set(resolveRecipientIds())].length;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader
        title="Announcements"
        description="Send notifications to teachers and parents"
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
          <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
        )}

        <form onSubmit={handleSend} className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">

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
              id="ann-title" type="text" className={inputClass}
              placeholder="e.g. School closed on Friday"
              value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              required
            />
          </FormField>

          {/* Body */}
          <FormField label="Message" htmlFor="ann-body" required>
            <textarea
              id="ann-body" rows={5}
              className={`${inputClass} resize-none`}
              placeholder="Write your announcement here…"
              value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              required
            />
          </FormField>

          {/* Audience */}
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">Send To</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {([
                { value: 'all', label: 'Everyone' },
                { value: 'teachers', label: 'Teachers only' },
                { value: 'parents', label: 'Parents only' },
                { value: 'custom', label: 'Select teachers' },
              ] as { value: AudienceType; label: string }[]).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, audience: opt.value, custom_ids: [] }))}
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
          </div>

          {/* Custom teacher picker */}
          {form.audience === 'custom' && (
            <div>
              <p className="text-xs text-gray-500 mb-2">Select individual teachers:</p>
              {loading ? (
                <p className="text-xs text-gray-400">Loading teachers…</p>
              ) : teachers.length === 0 ? (
                <p className="text-xs text-gray-400">No teachers found.</p>
              ) : (
                <div className="space-y-1.5 max-h-48 overflow-y-auto border border-gray-200 rounded-lg p-2">
                  {teachers.map((t) => (
                    <label key={t.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.custom_ids.includes(t.id)}
                        onChange={() => toggleCustomId(t.id)}
                        className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm text-gray-700">{t.name}</span>
                      <span className="text-xs text-gray-400 ml-auto">{t.email}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Recipient count preview */}
          <div className="flex items-center justify-between pt-2 border-t border-gray-100">
            <p className="text-xs text-gray-500">
              {recipientCount > 0
                ? `Will be sent to ${recipientCount} recipient${recipientCount !== 1 ? 's' : ''}`
                : 'No recipients selected'}
            </p>
            <button
              type="submit"
              disabled={sending || recipientCount === 0}
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
      </div>
    </>
  );
}
