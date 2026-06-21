'use client';

/**
 * /teacher/report-cards
 *
 * Generate report cards for a class. Only accessible to teachers who are
 * class admins for at least one class.
 */

import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import FormField, { inputClass } from '@/components/FormField';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Constants ─────────────────────────────────────────────────────────────────

const TERMS = [
  'Term 1',
  'Term 2',
  'Term 3',
  'Annual',
  'Semester 1',
  'Semester 2',
];

const EXAM_TYPES = [
  { value: 'unit_test',  label: 'Unit Test' },
  { value: 'mid_term',   label: 'Mid Term' },
  { value: 'final',      label: 'Final' },
  { value: 'quarterly',  label: 'Quarterly' },
  { value: 'half_yearly',label: 'Half Yearly' },
  { value: 'annual',     label: 'Annual' },
];

// ── Types ─────────────────────────────────────────────────────────────────────

interface AdminClass {
  class_name: string;
  section: string;
  appointed_at: string | null;
}

interface MissingEntry {
  teacher_name: string;
  subject: string;
}

interface ReadinessResult {
  total_teachers: number;
  uploaded: number;
  missing: MissingEntry[];
  all_uploaded: boolean;
}

interface ExistingCardEntry {
  id: string;
  student_id: string;
  student_name: string;
  roll_number: string | null;
  grand_total: number;
  grand_max: number;
  percentage: number;
  grade: string;
  generated_at: string;
}

interface ExistingCardsResult {
  exists: boolean;
  count: number;
  generated_at: string | null;
  generated_by_name: string | null;
  cards: ExistingCardEntry[];
}

type PageState = 'idle' | 'checking' | 'ready' | 'generating' | 'done' | 'notifying' | 'notified';

// ── Component ─────────────────────────────────────────────────────────────────

export default function ReportCardsPage() {
  const { user, loading: authLoading } = useAuth();

  // ── Class admin gate ────────────────────────────────────────────────────────
  const [adminClasses, setAdminClasses] = useState<AdminClass[]>([]);
  const [isClassAdmin, setIsClassAdmin] = useState<boolean | null>(null);

  // ── Form state ──────────────────────────────────────────────────────────────
  const [selectedClass, setSelectedClass] = useState('');
  const [selectedSection, setSelectedSection] = useState('');
  const [term, setTerm] = useState('');
  const [examType, setExamType] = useState('');

  // ── Page state ──────────────────────────────────────────────────────────────
  const [pageState, setPageState] = useState<PageState>('idle');
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);
  const [existingCards, setExistingCards] = useState<ExistingCardsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Fetch class admin classes ────────────────────────────────────────────────
  useEffect(() => {
    if (authLoading) return;
    const token = getToken();
    if (!token) {
      setIsClassAdmin(false);
      return;
    }

    fetch(`${BASE_URL}/api/class-admin/my-classes`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    })
      .then((r) => r.json())
      .then((res) => {
        const classes: AdminClass[] = res?.data ?? [];
        setAdminClasses(classes);
        setIsClassAdmin(Array.isArray(classes) && classes.length > 0);

        // Pre-select the first class/section
        if (classes.length > 0) {
          setSelectedClass(classes[0].class_name);
          setSelectedSection(classes[0].section);
        }
      })
      .catch(() => setIsClassAdmin(false));
  }, [user, authLoading]);

  // ── Derive unique class names and sections for the selected class ─────────────
  const uniqueClassNames = [...new Set(adminClasses.map((c) => c.class_name))].sort();
  const sectionsForClass = adminClasses
    .filter((c) => c.class_name === selectedClass)
    .map((c) => c.section);

  // When class changes, reset section to first available
  function handleClassChange(newClass: string) {
    setSelectedClass(newClass);
    const sections = adminClasses
      .filter((c) => c.class_name === newClass)
      .map((c) => c.section);
    setSelectedSection(sections[0] ?? '');
    resetReadiness();
  }

  function resetReadiness() {
    setReadiness(null);
    setExistingCards(null);
    setPageState('idle');
    setError(null);
  }

  // ── Check Readiness ─────────────────────────────────────────────────────────
  async function handleCheckReadiness() {
    if (!selectedClass || !selectedSection || !term || !examType) {
      setError('Please fill in all fields before checking readiness.');
      return;
    }

    setError(null);
    setReadiness(null);
    setExistingCards(null);
    setPageState('checking');

    const token = getToken();
    if (!token) {
      setError('Session expired. Please log in again.');
      setPageState('idle');
      return;
    }

    try {
      const params = new URLSearchParams({
        class_name: selectedClass,
        section:    selectedSection,
        term,
        exam_type:  examType,
      });

      const [readinessRes, existingRes] = await Promise.all([
        fetch(`${BASE_URL}/api/report-cards/readiness?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        }),
        fetch(`${BASE_URL}/api/report-cards/class?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        }),
      ]);

      const readinessJson = await readinessRes.json();

      if (!readinessRes.ok) {
        setError(readinessJson?.message ?? 'Failed to check readiness.');
        setPageState('idle');
        return;
      }

      setReadiness(readinessJson.data as ReadinessResult);

      if (existingRes.ok) {
        const existingJson = await existingRes.json();
        setExistingCards(existingJson.data as ExistingCardsResult);
      }

      setPageState('ready');
    } catch {
      setError('Network error. Please try again.');
      setPageState('idle');
    }
  }

  // ── Generate Report Cards ────────────────────────────────────────────────────
  async function handleGenerate() {
    setError(null);
    setPageState('generating');

    const token = getToken();
    if (!token) {
      setError('Session expired. Please log in again.');
      setPageState('ready');
      return;
    }

    try {
      const res = await fetch(`${BASE_URL}/api/report-cards/generate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          class_name: selectedClass,
          section:    selectedSection,
          term,
          exam_type:  examType,
        }),
      });

      if (!res.ok) {
        // Try to read JSON error body
        let errMsg = 'Failed to generate report cards.';
        try {
          const json = await res.json();
          errMsg = json?.message ?? errMsg;
        } catch { /* ignore parse error */ }
        setError(errMsg);
        setPageState('ready');
        return;
      }

      // Trigger download
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeClass   = selectedClass.replace(/[^a-zA-Z0-9]/g, '');
      const safeSection = selectedSection.replace(/[^a-zA-Z0-9]/g, '');
      const safeTerm    = term.replace(/[^a-zA-Z0-9]/g, '');
      a.download = `report-cards-${safeClass}${safeSection}-${safeTerm}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setPageState('done');
    } catch {
      setError('Network error. Please try again.');
      setPageState('ready');
    }
  }

  // ── Send Notifications (re-notify without regenerating) ───────────────────
  async function handleNotify() {
    setError(null);
    setPageState('notifying');

    const token = getToken();
    if (!token) {
      setError('Session expired. Please log in again.');
      setPageState('ready');
      return;
    }

    try {
      const res = await fetch(`${BASE_URL}/api/report-cards/notify`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          class_name: selectedClass,
          section:    selectedSection,
          term,
          exam_type:  examType,
        }),
      });

      if (!res.ok) {
        let errMsg = 'Failed to send notifications.';
        try {
          const json = await res.json();
          errMsg = json?.message ?? errMsg;
        } catch { /* ignore */ }
        setError(errMsg);
        setPageState('ready');
        return;
      }

      setPageState('notified');
    } catch {
      setError('Network error. Please try again.');
      setPageState('ready');
    }
  }

  // ── Loading state (auth) ────────────────────────────────────────────────────
  if (isClassAdmin === null) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // ── Not a class admin ────────────────────────────────────────────────────────
  if (!isClassAdmin) {
    return (
      <>
        <PageHeader
          title="Generate Report Cards"
          description="Generate, download and send PDF report cards to students &amp; parents"
        />
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-6 py-8 flex flex-col items-center text-center gap-3 mt-2">
          <span className="text-3xl">📄</span>
          <p className="text-sm font-semibold text-blue-800">Class Admins Only</p>
          <p className="text-sm text-blue-700 max-w-sm">
            Report card generation is only available to teachers who are appointed as class admin
            for a class. Contact your school administrator if you think this is a mistake.
          </p>
        </div>
      </>
    );
  }

  // ── Main UI ──────────────────────────────────────────────────────────────────
  return (
    <>
      <PageHeader
        title="Generate Report Cards"
        description="Generate, download and send PDF report cards to students &amp; parents"
      />

      {/* ── Filters card ─────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-4">Select Class &amp; Exam Details</h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
          {/* Class dropdown */}
          <FormField label="Class" htmlFor="class-select" required>
            <select
              id="class-select"
              className={inputClass}
              value={selectedClass}
              onChange={(e) => handleClassChange(e.target.value)}
            >
              {uniqueClassNames.map((cn) => (
                <option key={cn} value={cn}>{cn}</option>
              ))}
            </select>
          </FormField>

          {/* Section dropdown */}
          <FormField label="Section" htmlFor="section-select" required>
            <select
              id="section-select"
              className={inputClass}
              value={selectedSection}
              onChange={(e) => { setSelectedSection(e.target.value); resetReadiness(); }}
            >
              {sectionsForClass.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </FormField>

          {/* Term dropdown */}
          <FormField label="Term" htmlFor="term-select" required>
            <select
              id="term-select"
              className={inputClass}
              value={term}
              onChange={(e) => { setTerm(e.target.value); resetReadiness(); }}
            >
              <option value="">Select term…</option>
              {TERMS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </FormField>

          {/* Exam type dropdown */}
          <FormField label="Exam Type" htmlFor="exam-type-select" required>
            <select
              id="exam-type-select"
              className={inputClass}
              value={examType}
              onChange={(e) => { setExamType(e.target.value); resetReadiness(); }}
            >
              <option value="">Select exam type…</option>
              {EXAM_TYPES.map((et) => (
                <option key={et.value} value={et.value}>{et.label}</option>
              ))}
            </select>
          </FormField>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
            <svg className="w-4 h-4 text-red-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {/* Check Readiness button */}
        {(pageState === 'idle' || pageState === 'checking') && (
          <button
            type="button"
            onClick={handleCheckReadiness}
            disabled={pageState === 'checking'}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white rounded-lg transition-colors"
          >
            {pageState === 'checking' ? (
              <>
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Checking…
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Check Readiness
              </>
            )}
          </button>
        )}
      </div>

      {/* ── Readiness result ─────────────────────────────────────────────── */}
      {(pageState === 'ready' || pageState === 'generating' || pageState === 'done') && readiness && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">

          {/* ── Already generated banner ──────────────────────────────────── */}
          {existingCards?.exists && (
            <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-5">
              <svg className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <div className="flex-1">
                <p className="text-sm font-semibold text-amber-800">
                  Report cards already generated for this selection
                </p>
                <p className="text-xs text-amber-700 mt-0.5">
                  {existingCards.count} report card{existingCards.count !== 1 ? 's' : ''} were generated
                  {existingCards.generated_by_name ? ` by ${existingCards.generated_by_name}` : ''}
                  {existingCards.generated_at
                    ? ` on ${new Date(existingCards.generated_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`
                    : ''}.
                  Generating again will overwrite them.
                </p>
              </div>
            </div>
          )}

          {/* ── Previously generated cards table ─────────────────────────── */}
          {existingCards?.exists && existingCards.cards.length > 0 && (
            <div className="mb-5">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Previously generated — {existingCards.count} student{existingCards.count !== 1 ? 's' : ''}
              </p>
              <div className="border border-gray-100 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-left">
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Student</th>
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Roll No</th>
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Total</th>
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">%</th>
                      <th className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Grade</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {existingCards.cards.map((card) => (
                      <tr key={card.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2.5 font-medium text-gray-900">{card.student_name}</td>
                        <td className="px-4 py-2.5 text-gray-500">{card.roll_number ?? '—'}</td>
                        <td className="px-4 py-2.5 text-gray-700">{card.grand_total} / {card.grand_max}</td>
                        <td className="px-4 py-2.5 text-gray-700">{card.percentage.toFixed(1)}%</td>
                        <td className="px-4 py-2.5">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${
                            card.grade === 'A+' || card.grade === 'A' ? 'bg-green-100 text-green-800' :
                            card.grade === 'B' ? 'bg-blue-100 text-blue-800' :
                            card.grade === 'C' ? 'bg-yellow-100 text-yellow-800' :
                            card.grade === 'D' ? 'bg-orange-100 text-orange-800' :
                            'bg-red-100 text-red-800'
                          }`}>
                            {card.grade}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* All uploaded banner */}
          {readiness.all_uploaded ? (
            <div className="flex items-start gap-3 bg-green-50 border border-green-200 rounded-lg px-4 py-3 mb-5">
              <svg className="w-5 h-5 text-green-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <p className="text-sm font-semibold text-green-800">All marks uploaded. Ready to generate!</p>
                <p className="text-xs text-green-700 mt-0.5">
                  All {readiness.total_teachers} subject{readiness.total_teachers !== 1 ? 's' : ''} have marks uploaded for this term.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3 bg-orange-50 border border-orange-200 rounded-lg px-4 py-3 mb-5">
              <svg className="w-5 h-5 text-orange-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <div>
                <p className="text-sm font-semibold text-orange-800">
                  {readiness.uploaded} of {readiness.total_teachers} subjects have marks uploaded
                </p>
                <p className="text-xs text-orange-700 mt-0.5">
                  Some teachers haven't entered marks yet. You can generate anyway or wait.
                </p>
              </div>
            </div>
          )}

          {/* Missing subjects list */}
          {!readiness.all_uploaded && readiness.missing.length > 0 && (
            <div className="mb-5">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Missing marks</p>
              <div className="divide-y divide-gray-50 border border-gray-100 rounded-lg overflow-hidden">
                {readiness.missing.map((m, i) => (
                  <div key={i} className="flex items-center gap-2 px-4 py-2.5 bg-white">
                    <svg className="w-3.5 h-3.5 text-orange-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v3a1 1 0 000 2h2a1 1 0 100-2h-1V7z" clipRule="evenodd" />
                    </svg>
                    <span className="text-sm text-gray-700">
                      <span className="font-medium">{m.teacher_name}</span>
                      <span className="text-gray-400"> ({m.subject})</span>
                      <span className="text-orange-600 ml-1 text-xs">— not uploaded yet</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action buttons */}
          {pageState === 'done' ? (
            <div className="space-y-3">
              <div className="flex items-start gap-3 bg-green-50 border border-green-200 rounded-lg px-4 py-3">
                <svg className="w-5 h-5 text-green-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-green-800">Report cards downloaded &amp; notifications sent!</p>
                  <p className="text-xs text-green-700 mt-0.5">
                    ZIP downloaded to your folder. Students and parents have been notified via in-app notification and push alert.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => { setPageState('ready'); setError(null); }}
                  className="ml-auto text-xs text-green-700 underline hover:no-underline shrink-0"
                >
                  Generate again
                </button>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleNotify}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                  </svg>
                  Re-send Notifications
                </button>
                <span className="text-xs text-gray-400">Remind students &amp; parents again</span>
              </div>
            </div>
          ) : pageState === 'notified' ? (
            <div className="flex items-start gap-3 bg-purple-50 border border-purple-200 rounded-lg px-4 py-3">
              <svg className="w-5 h-5 text-purple-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
              <div className="flex-1">
                <p className="text-sm font-semibold text-purple-800">Notifications sent!</p>
                <p className="text-xs text-purple-700 mt-0.5">All students and parents have been notified about their report cards.</p>
              </div>
              <button
                type="button"
                onClick={() => { setPageState('ready'); setError(null); }}
                className="ml-auto text-xs text-purple-700 underline hover:no-underline shrink-0"
              >
                Back
              </button>
            </div>
          ) : pageState === 'generating' ? (
            <div className="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
              <span className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin shrink-0" />
              <p className="text-sm font-medium text-blue-800">Generating report cards…</p>
            </div>
          ) : pageState === 'notifying' ? (
            <div className="flex items-center gap-3 bg-purple-50 border border-purple-200 rounded-lg px-4 py-3">
              <span className="w-5 h-5 border-2 border-purple-600 border-t-transparent rounded-full animate-spin shrink-0" />
              <p className="text-sm font-medium text-purple-800">Sending notifications to students &amp; parents…</p>
            </div>
          ) : (
            <div className="flex flex-wrap gap-3">
              {readiness.all_uploaded ? (
                <button
                  type="button"
                  onClick={handleGenerate}
                  className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  {existingCards?.exists ? 'Regenerate & Notify Students' : 'Generate & Notify Students'}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleGenerate}
                    className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-orange-500 hover:bg-orange-600 text-white rounded-lg transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    {existingCards?.exists ? 'Regenerate Anyway & Notify' : 'Generate Anyway & Notify'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setReadiness(null); setExistingCards(null); setPageState('idle'); setError(null); }}
                    className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg transition-colors"
                  >
                    Wait for Teachers
                  </button>
                </>
              )}

              {/* Send notifications for already-generated cards */}
              {existingCards?.exists && (
                <button
                  type="button"
                  onClick={handleNotify}
                  className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                  </svg>
                  Send Notifications
                </button>
              )}

              {/* Re-check option */}
              <button
                type="button"
                onClick={resetReadiness}
                className="text-xs text-blue-600 hover:underline self-center ml-1"
              >
                Change filters
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
