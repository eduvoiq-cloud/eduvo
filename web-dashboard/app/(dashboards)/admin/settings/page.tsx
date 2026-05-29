'use client';

import { useEffect, useState, useCallback } from 'react';
import { settingsApi, type SchoolSettings } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import FormField, { inputClass } from '@/components/FormField';

const TIMEZONES = [
  'UTC', 'Africa/Lagos', 'Africa/Nairobi', 'Africa/Accra', 'Africa/Cairo',
  'America/New_York', 'America/Chicago', 'America/Los_Angeles',
  'Europe/London', 'Europe/Paris', 'Asia/Dubai', 'Asia/Kolkata',
  'Asia/Singapore', 'Australia/Sydney',
];

export default function SettingsPage() {
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
      )}
    </>
  );
}
