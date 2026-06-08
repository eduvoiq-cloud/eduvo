'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { assignmentsApi, type TeacherAssignment } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import FormField, { inputClass } from '@/components/FormField';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TargetClass {
  class: string;
  section: string;
}

interface ClassOption {
  class_name: string;
  section: string;
  subject: string;
  /** Display label e.g. "10 · A — Maths" */
  label: string;
  /** Unique key for checkbox tracking */
  key: string;
}

interface AnnouncementRecord {
  id: string;
  title: string;
  message: string;
  target_classes: TargetClass[];
  created_at: string;
}

interface AdminAnnouncementRecord {
  id: string;
  title: string;
  message: string;
  target_audience: string;
  created_at: string;
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

function classLabel(tc: TargetClass): string {
  return `${tc.class}·${tc.section}`;
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function CardSkeleton() {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 animate-pulse space-y-3">
      <div className="h-4 w-1/3 bg-gray-200 rounded" />
      <div className="h-3 bg-gray-200 rounded w-full" />
      <div className="h-3 bg-gray-200 rounded w-2/3" />
      <div className="h-3 w-1/4 bg-gray-200 rounded" />
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function TeacherAnnouncementsPage() {
  const { user } = useAuth();

  // ── Assignments ─────────────────────────────────────────────────────────────
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);

  // ── Form state ──────────────────────────────────────────────────────────────
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // ── Previous announcements ──────────────────────────────────────────────────
  const [announcements, setAnnouncements] = useState<AnnouncementRecord[]>([]);
  const [loadingAnnouncements, setLoadingAnnouncements] = useState(true);
  const [listError, setListError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');

  // ── Admin announcements (school-wide) ───────────────────────────────────────
  const [adminAnnouncements, setAdminAnnouncements] = useState<AdminAnnouncementRecord[]>([]);
  const [loadingAdmin, setLoadingAdmin] = useState(true);

  // ── Derived class options ───────────────────────────────────────────────────

  // Deduplicate by class+section+subject so each unique assignment is one checkbox
  const classOptions: ClassOption[] = (() => {
    const seen = new Set<string>();
    const result: ClassOption[] = [];
    for (const a of assignments) {
      const key = `${a.class_name}__${a.section}__${a.subject}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({
          class_name: a.class_name,
          section: a.section,
          subject: a.subject,
          label: `${a.class_name} · ${a.section} — ${a.subject}`,
          key,
        });
      }
    }
    // Sort by class, then section, then subject
    result.sort((a, b) =>
      a.class_name.localeCompare(b.class_name) ||
      a.section.localeCompare(b.section) ||
      a.subject.localeCompare(b.subject)
    );
    return result;
  })();

  const allSelected = classOptions.length > 0 && selectedKeys.size === classOptions.length;
  const someSelected = selectedKeys.size > 0 && !allSelected;

  // ── Load assignments ────────────────────────────────────────────────────────

  useEffect(() => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    setLoadingAssignments(true);
    assignmentsApi
      .list(token, user.school_id)
      .then((res) => {
        setAssignments(res.data.filter((a) => a.teacher_id === user.id));
      })
      .catch(() => {})
      .finally(() => setLoadingAssignments(false));
  }, [user]);

  // ── Load previous announcements ─────────────────────────────────────────────

  const fetchAnnouncements = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoadingAnnouncements(true);
    setListError('');
    try {
      const res = await fetch(`${BASE_URL}/api/announcements/my`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to load announcements');
      const data: AnnouncementRecord[] = json.data ?? [];
      // Sort newest first
      data.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setAnnouncements(data);
    } catch (err: unknown) {
      setListError(err instanceof Error ? err.message : 'Failed to load announcements');
    } finally {
      setLoadingAnnouncements(false);
    }
  }, []);

  useEffect(() => {
    fetchAnnouncements();
  }, [fetchAnnouncements]);

  // ── Load school admin announcements ─────────────────────────────────────────

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    setLoadingAdmin(true);
    fetch(`${BASE_URL}/api/announcements/school`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((json) => setAdminAnnouncements(json.data ?? []))
      .catch(() => {})
      .finally(() => setLoadingAdmin(false));
  }, []);

  // ── Select all toggle ───────────────────────────────────────────────────────

  function handleSelectAll() {
    if (allSelected) {
      setSelectedKeys(new Set());
    } else {
      setSelectedKeys(new Set(classOptions.map((c) => c.key)));
    }
  }

  function toggleKey(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // ── Submit ──────────────────────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError('');
    setSuccessMsg('');

    if (selectedKeys.size === 0) {
      setSubmitError('Select at least one class.');
      return;
    }
    if (!title.trim()) {
      setSubmitError('Title is required.');
      return;
    }
    if (!message.trim()) {
      setSubmitError('Message is required.');
      return;
    }

    const token = getToken();
    if (!token) { setSubmitError('Session expired. Please log in again.'); return; }

    // Build unique target_classes from selected keys (deduplicate class+section)
    const targetClassMap = new Map<string, TargetClass>();
    for (const key of selectedKeys) {
      const opt = classOptions.find((c) => c.key === key);
      if (opt) {
        const ck = `${opt.class_name}__${opt.section}`;
        if (!targetClassMap.has(ck)) {
          targetClassMap.set(ck, { class: opt.class_name, section: opt.section });
        }
      }
    }
    const target_classes = Array.from(targetClassMap.values());

    setSubmitting(true);
    try {
      const res = await fetch(`${BASE_URL}/api/announcements/teacher`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: title.trim(),
          message: message.trim(),
          target_classes,
          school_id: user?.school_id,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to send announcement');

      const count = json.data?.sent_to_count ?? target_classes.length;
      setSuccessMsg(`Announcement sent to ${count} class${count !== 1 ? 'es' : ''}!`);

      // Clear form
      setTitle('');
      setMessage('');
      setSelectedKeys(new Set());

      // Refresh list
      fetchAnnouncements();
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to send announcement');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete(id: string) {
    const token = getToken();
    if (!token) return;
    setDeletingId(id);
    setDeleteError('');
    try {
      const res = await fetch(`${BASE_URL}/api/announcements/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Delete failed');
      setAnnouncements((prev) => prev.filter((a) => a.id !== id));
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeletingId(null);
    }
  }

  // ── Form validity ───────────────────────────────────────────────────────────

  const formValid = selectedKeys.size > 0 && title.trim().length > 0 && message.trim().length > 0;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader
        title="Announcements"
        description="Send announcements to your assigned classes"
      />

      {/* ── Create Announcement ────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <h2 className="text-base font-semibold text-gray-900 mb-5">
          Send Announcement to Your Classes
        </h2>

        {successMsg && (
          <div className="mb-4 flex items-center gap-2 px-4 py-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700 font-medium">
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {successMsg}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Class selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Select Classes <span className="text-red-500">*</span>
            </label>

            {loadingAssignments ? (
              <div className="flex items-center gap-2 text-sm text-gray-500 py-2">
                <span className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                Loading your classes…
              </div>
            ) : classOptions.length === 0 ? (
              <p className="text-sm text-gray-500 py-2">No classes assigned to you yet.</p>
            ) : (
              <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 overflow-hidden">
                {/* Select All row */}
                <label className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50 bg-gray-50/60">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected;
                    }}
                    onChange={handleSelectAll}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm font-medium text-gray-700">
                    Select All My Classes
                  </span>
                  {selectedKeys.size > 0 && (
                    <span className="ml-auto text-xs text-gray-500">
                      {selectedKeys.size} of {classOptions.length} selected
                    </span>
                  )}
                </label>

                {/* Individual class checkboxes */}
                <div className="divide-y divide-gray-100">
                  {classOptions.map((opt) => (
                    <label
                      key={opt.key}
                      className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-blue-50/40"
                    >
                      <input
                        type="checkbox"
                        checked={selectedKeys.has(opt.key)}
                        onChange={() => toggleKey(opt.key)}
                        className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span
                        className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${
                          selectedKeys.has(opt.key)
                            ? 'bg-blue-100 text-blue-700'
                            : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {opt.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Title */}
          <FormField label="Title" htmlFor="ann-title" required>
            <input
              id="ann-title"
              type="text"
              className={inputClass}
              placeholder="e.g. Important Notice About Tomorrow's Class"
              maxLength={100}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <p className="mt-1 text-xs text-gray-400 text-right">{title.length}/100</p>
          </FormField>

          {/* Message */}
          <FormField label="Message" htmlFor="ann-message" required>
            <textarea
              id="ann-message"
              className={`${inputClass} resize-none`}
              rows={4}
              placeholder="Write your announcement here…"
              maxLength={500}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <p className="mt-1 text-xs text-gray-400 text-right">{message.length}/500</p>
          </FormField>

          {submitError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {submitError}
            </div>
          )}

          <button
            type="submit"
            disabled={!formValid || submitting}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
          >
            {submitting && (
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            )}
            {submitting ? 'Sending…' : 'Send Announcement'}
          </button>
        </form>
      </div>

      {/* ── Previous Announcements ─────────────────────────────────────────── */}
      <div>
        <h2 className="text-base font-semibold text-gray-900 mb-4">Previously Sent</h2>

        {deleteError && (
          <div className="mb-4 px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {deleteError}
          </div>
        )}

        {loadingAnnouncements ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => <CardSkeleton key={i} />)}
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
              <AnnouncementCard
                key={ann.id}
                announcement={ann}
                deleting={deletingId === ann.id}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── School Admin Announcements ─────────────────────────────────────── */}
      <div className="mt-8">
        <h2 className="text-base font-semibold text-gray-900 mb-1">From School Admin</h2>
        <p className="text-xs text-gray-500 mb-4">School-wide announcements sent to you by the school admin.</p>

        {loadingAdmin ? (
          <div className="space-y-3">
            {[1, 2].map((i) => <CardSkeleton key={i} />)}
          </div>
        ) : adminAnnouncements.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center bg-white rounded-xl border border-gray-200">
            <p className="text-sm text-gray-500">No school admin announcements yet</p>
          </div>
        ) : (
          <div className="space-y-3">
            {adminAnnouncements.map((ann) => (
              <div key={ann.id} className="bg-white rounded-xl border border-blue-100 p-5 border-l-4 border-l-blue-500">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                        📢 School Admin
                      </span>
                    </div>
                    <h3 className="text-sm font-semibold text-gray-900 leading-snug mb-1 mt-2">
                      {ann.title}
                    </h3>
                    <p className="text-sm text-gray-600 line-clamp-2 mb-2">
                      {ann.message}
                    </p>
                    <span className="text-xs text-gray-400">{timeAgo(ann.created_at)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ── Announcement Card ─────────────────────────────────────────────────────────

function AnnouncementCard({
  announcement,
  deleting,
  onDelete,
}: {
  announcement: AnnouncementRecord;
  deleting: boolean;
  onDelete: (id: string) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const classTags = announcement.target_classes ?? [];

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          {/* Title */}
          <h3 className="text-sm font-semibold text-gray-900 leading-snug mb-1">
            {announcement.title}
          </h3>

          {/* Message preview — 2 lines */}
          <p className="text-sm text-gray-600 line-clamp-2 mb-3">
            {announcement.message}
          </p>

          {/* Metadata row */}
          <div className="flex flex-wrap items-center gap-3">
            {/* Sent to classes */}
            {classTags.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs text-gray-500">Sent to:</span>
                {classTags.map((tc, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700"
                  >
                    {classLabel(tc)}
                  </span>
                ))}
              </div>
            )}

            {/* Time ago */}
            <span className="text-xs text-gray-400 ml-auto">
              {timeAgo(announcement.created_at)}
            </span>
          </div>
        </div>

        {/* Delete button / confirm */}
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
