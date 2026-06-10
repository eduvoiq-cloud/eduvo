'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { settingsApi, type SchoolSettings } from '@/lib/api';
import { getToken } from '@/lib/session';
import { useAuth } from '@/context/AuthContext';
import PageHeader from '@/components/PageHeader';
import FormField, { inputClass } from '@/components/FormField';

const TIMEZONES = [
  'UTC', 'Africa/Lagos', 'Africa/Nairobi', 'Africa/Accra', 'Africa/Cairo',
  'America/New_York', 'America/Chicago', 'America/Los_Angeles',
  'Europe/London', 'Europe/Paris', 'Asia/Dubai', 'Asia/Kolkata',
  'Asia/Singapore', 'Australia/Sydney',
];

export default function SettingsPage() {
  const { user, schools, refreshSchools } = useAuth();

  const [settings, setSettings] = useState<Partial<SchoolSettings>>({
    attendance_cutoff_time: '09:00',
    timezone: 'UTC',
    term_name: '',
    academic_year: '',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  // ── Data export ───────────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  // ── Medium account ────────────────────────────────────────────────────────
  const [showMediumModal, setShowMediumModal] = useState(false);
  const [addingMedium, setAddingMedium] = useState(false);
  const [mediumSuccess, setMediumSuccess] = useState('');
  const [mediumError, setMediumError] = useState('');

  // ── Delete school modal ───────────────────────────────────────────────────
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleteSending, setDeleteSending] = useState(false);
  const [deleteSuccess, setDeleteSuccess] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const deleteInputRef = useRef<HTMLInputElement>(null);

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchSettings = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    try {
      const res = await settingsApi.get(token);
      setSettings(res.data);
    } catch {
      // Use defaults if no settings exist yet
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  // ── Save ──────────────────────────────────────────────────────────────────

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');

    // Validate cutoff time format HH:MM
    if (settings.attendance_cutoff_time) {
      const timeRegex = /^\d{2}:\d{2}$/;
      if (!timeRegex.test(settings.attendance_cutoff_time)) {
        setError('Attendance cutoff time must be in HH:MM format (e.g. 09:00).');
        return;
      }
    }

    const token = getToken();
    if (!token) return;
    setSaving(true);
    try {
      const res = await settingsApi.save(token, {
        attendance_cutoff_time: settings.attendance_cutoff_time,
        timezone: settings.timezone,
        term_name: settings.term_name,
        academic_year: settings.academic_year,
      });
      setSettings(res.data);
      setSuccess('Settings saved successfully.');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  function update(key: keyof SchoolSettings, value: string) {
    setSettings((s) => ({ ...s, [key]: value }));
    setSuccess('');
  }

  // ── Export ────────────────────────────────────────────────────────────────

  async function handleExport() {
    setExportError('');
    const token = getToken();
    if (!token) return;
    setExporting(true);
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? ''}/api/admin/export`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.message ?? 'Export failed. Please try again.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${new Date().toISOString().slice(0, 10)}_DataExport.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setExportError(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  }

  // ── Delete school ─────────────────────────────────────────────────────────

  async function handleDeleteSchool() {
    setDeleteError('');
    const token = getToken();
    if (!token) return;
    setDeleteSending(true);
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? ''}/api/admin/request-deletion`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ email: user?.email }),
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.message ?? 'Failed to send deletion request.');
      }
      setDeleteSuccess('Your deletion request has been sent to the super admin. You will be contacted within 7 business days.');
    } catch (e: unknown) {
      setDeleteError(e instanceof Error ? e.message : 'Failed to send request.');
    } finally {
      setDeleteSending(false);
    }
  }

  // ── Add medium ────────────────────────────────────────────────────────────

  async function handleAddMedium() {
    setMediumError('');
    const token = getToken();
    if (!token) return;
    setAddingMedium(true);
    try {
      const res = await settingsApi.addMedium(token);
      const newMedium = (res.data as { medium: string }).medium;
      const label = newMedium.charAt(0).toUpperCase() + newMedium.slice(1);
      setMediumSuccess(
        `${label} medium account created. Use the switcher in the navbar to switch between mediums.`
      );
      setShowMediumModal(false);
      await refreshSchools();
    } catch (e: unknown) {
      setMediumError(e instanceof Error ? e.message.replace(/^\d+:\s*/, '') : 'Failed to create medium account');
    } finally {
      setAddingMedium(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader
        title="School Settings"
        description="Configure attendance rules and academic calendar"
      />

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <>
        <form onSubmit={handleSave} className="max-w-xl space-y-6">

          {/* Feedback */}
          {success && (
            <div className="px-4 py-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700 flex items-center gap-2">
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              {success}
            </div>
          )}
          {error && (
            <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
          )}

          {/* ── Attendance ─────────────────────────────────────────────────── */}
          <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
            <div className="flex items-center gap-2 mb-1">
              <div className="w-7 h-7 bg-blue-50 rounded-lg flex items-center justify-center text-blue-600">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h2 className="text-sm font-semibold text-gray-900">Attendance</h2>
            </div>

            <FormField
              label="Attendance Cutoff Time"
              htmlFor="cutoff"
              required
            >
              <div className="flex items-center gap-3">
                <input
                  id="cutoff"
                  type="time"
                  className={`${inputClass} max-w-[140px]`}
                  value={settings.attendance_cutoff_time ?? '09:00'}
                  onChange={(e) => update('attendance_cutoff_time', e.target.value)}
                  required
                />
                <p className="text-xs text-gray-500">
                  Students arriving after this time are marked <strong>late</strong>.
                </p>
              </div>
            </FormField>

            <FormField label="School Timezone" htmlFor="tz">
              <select
                id="tz"
                className={inputClass}
                value={settings.timezone ?? 'UTC'}
                onChange={(e) => update('timezone', e.target.value)}
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </FormField>
          </section>

          {/* ── Academic Calendar ──────────────────────────────────────────── */}
          <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
            <div className="flex items-center gap-2 mb-1">
              <div className="w-7 h-7 bg-blue-50 rounded-lg flex items-center justify-center text-blue-600">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <h2 className="text-sm font-semibold text-gray-900">Academic Calendar</h2>
            </div>

            <FormField label="Current Term / Semester" htmlFor="term">
              <input
                id="term"
                type="text"
                className={inputClass}
                placeholder="e.g. Term 1, Spring 2025"
                value={settings.term_name ?? ''}
                onChange={(e) => update('term_name', e.target.value)}
              />
            </FormField>

            <FormField label="Academic Year" htmlFor="year">
              <input
                id="year"
                type="text"
                className={inputClass}
                placeholder="e.g. 2024/2025"
                value={settings.academic_year ?? ''}
                onChange={(e) => update('academic_year', e.target.value)}
              />
            </FormField>
          </section>

          {/* Save button */}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {saving ? (
                <>
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Save Settings
                </>
              )}
            </button>
          </div>
        </form>

        <div className="max-w-xl mt-8 space-y-4">
          <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
            <div className="flex items-center gap-2 mb-1">
              <div className="w-7 h-7 bg-indigo-50 rounded-lg flex items-center justify-center text-indigo-600">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
              </div>
              <h2 className="text-sm font-semibold text-gray-900">Medium Accounts</h2>
            </div>

            {/* Success feedback */}
            {mediumSuccess && (
              <div className="px-4 py-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700 flex items-center gap-2">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                {mediumSuccess}
              </div>
            )}

            {/* Current mediums */}
            <div className="flex flex-wrap gap-2">
              {schools.length === 0 ? (
                <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-100">
                  English Medium
                </span>
              ) : (
                schools.map((s) => (
                  <span
                    key={s.id}
                    className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium border ${
                      s.medium === 'gujarati'
                        ? 'bg-orange-50 text-orange-700 border-orange-100'
                        : 'bg-blue-50 text-blue-700 border-blue-100'
                    }`}
                  >
                    {s.medium.charAt(0).toUpperCase() + s.medium.slice(1)} Medium
                  </span>
                ))
              )}
            </div>

            {schools.length >= 2 ? (
              <p className="text-sm text-gray-500">Both mediums are active.</p>
            ) : (
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    Add {schools.length > 0 && schools[0].medium === 'english' ? 'Gujarati' : 'English'} Medium Account
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Creates a separate, isolated account for the other medium. Starts completely empty.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => { setMediumError(''); setShowMediumModal(true); }}
                  className="shrink-0 flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Add Medium
                </button>
              </div>
            )}
          </section>

          <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
            <div className="flex items-center gap-2 mb-1">
              <div className="w-7 h-7 bg-purple-50 rounded-lg flex items-center justify-center text-purple-600">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
              </div>
              <h2 className="text-sm font-semibold text-gray-900">Data &amp; Privacy</h2>
            </div>

            {/* Export */}
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-gray-900">Download All School Data</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Export all students, attendance, marks, and settings as a JSON file.
                </p>
                {exportError && (
                  <p className="text-xs text-red-600 mt-1">{exportError}</p>
                )}
              </div>
              <button
                type="button"
                onClick={handleExport}
                disabled={exporting}
                className="shrink-0 flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 disabled:opacity-50 text-gray-700 text-sm font-medium rounded-lg transition-colors"
              >
                {exporting ? (
                  <>
                    <span className="w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
                    Exporting…
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Export Data
                  </>
                )}
              </button>
            </div>

            <hr className="border-gray-100" />

            {/* Delete school */}
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-gray-900">Delete School Account</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Permanently delete all school data. This cannot be undone.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowDeleteModal(true);
                  setDeleteConfirmName('');
                  setDeleteError('');
                  setDeleteSuccess('');
                  setTimeout(() => deleteInputRef.current?.focus(), 100);
                }}
                className="shrink-0 px-4 py-2 bg-red-50 hover:bg-red-100 text-red-700 text-sm font-medium rounded-lg border border-red-200 transition-colors"
              >
                Delete Account
              </button>
            </div>

            <hr className="border-gray-100" />

            {/* Policy links */}
            <div className="flex flex-wrap gap-4 text-sm">
              <Link
                href="/privacy-policy"
                target="_blank"
                className="text-blue-600 hover:underline flex items-center gap-1"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                Privacy Policy
              </Link>
              <Link
                href="/terms-of-service"
                target="_blank"
                className="text-blue-600 hover:underline flex items-center gap-1"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                Terms of Service
              </Link>
            </div>
          </section>
        </div>
        </>
      )}

      {/* ── Add Medium Modal ────────────────────────────────────────────────── */}
      {showMediumModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="medium-modal-title"
        >
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-indigo-100 rounded-full flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
              </div>
              <div>
                <h3 id="medium-modal-title" className="text-base font-semibold text-gray-900">
                  Add {schools.length > 0 && schools[0].medium === 'english' ? 'Gujarati' : 'English'} Medium Account
                </h3>
                <p className="text-xs text-gray-500">One subscription — two isolated mediums</p>
              </div>
            </div>

            <p className="text-sm text-gray-600 mb-4">
              This will create a separate{' '}
              <strong>
                {schools.length > 0 && schools[0].medium === 'english' ? 'Gujarati' : 'English'}
              </strong>{' '}
              medium account for your school. It will start completely empty — no students, teachers, or classes.
              You can switch between mediums from the top navbar.
            </p>

            {mediumError && (
              <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 mb-4">
                {mediumError}
              </div>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowMediumModal(false)}
                disabled={addingMedium}
                className="flex-1 py-2.5 bg-gray-100 hover:bg-gray-200 disabled:opacity-50 text-gray-700 text-sm font-medium rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAddMedium}
                disabled={addingMedium}
                className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {addingMedium ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Creating…
                  </>
                ) : (
                  'Continue'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete School Modal ─────────────────────────────────────────────── */}
      {showDeleteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-modal-title"
        >
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div>
                <h3 id="delete-modal-title" className="text-base font-semibold text-gray-900">
                  Delete School Account
                </h3>
                <p className="text-xs text-gray-500">This action cannot be undone</p>
              </div>
            </div>

            {deleteSuccess ? (
              <div className="space-y-4">
                <div className="px-4 py-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
                  {deleteSuccess}
                </div>
                <button
                  type="button"
                  onClick={() => setShowDeleteModal(false)}
                  className="w-full py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium rounded-lg transition-colors"
                >
                  Close
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-gray-600">
                  This will permanently delete all school data including students, attendance records,
                  marks, and teacher accounts. <strong>This cannot be undone.</strong>
                </p>

                <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-xs text-red-800">
                  A deletion request will be sent to the super admin. Your account will remain active
                  until the request is reviewed and approved.
                </div>

                <div>
                  <label htmlFor="confirm-name" className="block text-sm font-medium text-gray-700 mb-1.5">
                    Type your school name to confirm
                  </label>
                  <input
                    id="confirm-name"
                    ref={deleteInputRef}
                    type="text"
                    placeholder="School name"
                    value={deleteConfirmName}
                    onChange={(e) => { setDeleteConfirmName(e.target.value); setDeleteError(''); }}
                    className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-lg bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
                  />
                </div>

                {deleteError && (
                  <p className="text-sm text-red-600">{deleteError}</p>
                )}

                <div className="flex gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowDeleteModal(false)}
                    className="flex-1 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={deleteConfirmName.trim().length < 2 || deleteSending}
                    onClick={handleDeleteSchool}
                    className="flex-1 py-2.5 bg-red-600 hover:bg-red-700 disabled:bg-red-300 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    {deleteSending ? (
                      <>
                        <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        Sending…
                      </>
                    ) : (
                      'Send Deletion Request'
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
