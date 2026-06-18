'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { studentTestsApi, type TestRecord } from '@/lib/studentApi';
import { getStudentToken, getStudentUser, clearStudentSession } from '@/lib/studentSession';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const isPlain = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const d = isPlain
    ? (() => { const [y, m, day] = iso.split('-').map(Number); return new Date(y, m - 1, day); })()
    : new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

type TabKey = 'current' | 'upcoming' | 'completed';

function parseLocalDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function filterTests(tests: TestRecord[], tab: TabKey): TestRecord[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return tests
    .filter((t) => {
      const testDay = parseLocalDate(t.date);
      const isFuture = testDay ? testDay > todayStart : false;
      const status = t.attempt_status ?? 'not_started';
      switch (tab) {
        case 'current':   return !isFuture && (status === 'not_started' || status === 'in_progress');
        case 'upcoming':  return isFuture && status !== 'completed';
        case 'completed': return status === 'completed';
        default:          return true;
      }
    })
    .sort((a, b) => {
      const da = parseLocalDate(a.date);
      const db = parseLocalDate(b.date);
      return (db?.getTime() ?? 0) - (da?.getTime() ?? 0);
    });
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

type WindowState = 'before' | 'open' | 'closed' | 'no_window';

function getWindowState(from: string | null | undefined, until: string | null | undefined): WindowState {
  if (!from && !until) return 'no_window';
  const now = new Date();
  const nowHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const nowMins   = toMinutes(nowHHMM);
  const fromMins  = from ? toMinutes(from) : null;
  const untilMins = until ? toMinutes(until) : null;
  const isOvernight = fromMins !== null && untilMins !== null && untilMins < fromMins;
  if (isOvernight) {
    if (fromMins !== null && nowMins >= fromMins) return 'open';
    if (untilMins !== null && nowMins <= untilMins) return 'open';
    return 'before';
  }
  if (fromMins !== null && nowMins < fromMins) return 'before';
  const effUntil = (until && until !== from) ? until : null;
  if (effUntil && nowMins > toMinutes(effUntil)) return 'closed';
  return 'open';
}

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  not_started: { label: 'Not Started', cls: 'bg-gray-100 text-gray-600' },
  in_progress:  { label: 'In Progress', cls: 'bg-amber-100 text-amber-700' },
  completed:    { label: 'Completed',   cls: 'bg-green-100 text-green-700' },
} as const;

// ── Test card ─────────────────────────────────────────────────────────────────

function TestCard({ test, onClick }: { test: TestRecord; onClick: () => void }) {
  const status  = test.attempt_status ?? 'not_started';
  const locked  = test.is_restricted;
  const conf    = STATUS_CONFIG[status];
  const win     = getWindowState(test.available_from, test.available_until);
  const testDay = parseLocalDate(test.date);
  const today   = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const isFuture = testDay ? testDay > todayStart : false;

  // Build a blocking message if the card isn't actionable
  let blockMsg: string | null = null;
  if (locked) blockMsg = '🔒 Pay your fees to unlock this test. Contact your teacher.';
  else if (isFuture && status !== 'completed') blockMsg = `📅 This test is scheduled for ${formatDate(test.date)}.`;
  else if (win === 'before') blockMsg = `⏰ Test window opens at ${test.available_from}.`;
  else if (win === 'closed') blockMsg = `⏰ Test window closed at ${test.available_until}.`;

  const ctaLabel = status === 'completed' ? 'View Results →' : status === 'in_progress' ? 'Continue Test →' : 'Start Test →';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left bg-white rounded-2xl border ${locked ? 'border-l-4 border-l-red-500 border-gray-200 opacity-90' : 'border-gray-200 hover:border-blue-300 hover:shadow-md'} shadow-sm transition-all`}
      aria-label={`${test.title}. Status: ${locked ? 'Locked' : conf.label}`}
    >
      <div className="p-4">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <h3 className="text-sm font-bold text-gray-900 leading-snug flex-1">{test.title}</h3>
          <span className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-semibold ${locked ? 'bg-red-100 text-red-700' : conf.cls}`}>
            {locked ? 'Locked' : conf.label}
          </span>
        </div>

        {/* Block message banner */}
        {blockMsg && (
          <div className={`mb-3 text-xs font-medium px-3 py-2 rounded-lg ${locked ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>
            {blockMsg}
          </div>
        )}

        {/* Meta row */}
        <div className="flex items-center gap-4 text-xs text-gray-500 border-t border-gray-100 pt-3 mb-3">
          <span><span className="font-medium text-gray-700">{formatDate(test.date)}</span></span>
          <span>·</span>
          <span>{test.question_count} question{test.question_count !== 1 ? 's' : ''}</span>
          <span>·</span>
          <span>{test.time_limit_minutes > 0 ? `${test.time_limit_minutes} min` : 'No limit'}</span>
        </div>

        {/* Window banner */}
        {!locked && (test.available_from || test.available_until) && (
          <div className={`text-xs px-3 py-1.5 rounded-lg mb-3 ${
            win === 'open' ? 'bg-green-50 text-green-700' :
            win === 'closed' ? 'bg-gray-100 text-gray-500' :
            'bg-blue-50 text-blue-700'
          }`}>
            🕐 Window: {test.available_from ?? '—'} – {test.available_until ?? '—'}
            {win === 'open' && ' · Open now'}
            {win === 'closed' && ' · Closed'}
            {win === 'before' && ' · Not started yet'}
          </div>
        )}

        {/* CTA */}
        <div className="flex justify-end">
          <span className={`text-xs font-semibold ${locked || blockMsg ? 'text-gray-400' : 'text-blue-600'}`}>
            {locked ? '🔒 Locked' : blockMsg ? '—' : ctaLabel}
          </span>
        </div>
      </div>
    </button>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function StudentTestsPage() {
  const router = useRouter();
  const [tests, setTests]       = useState<TestRecord[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [activeTab, setActiveTab] = useState<TabKey>('current');
  const student = typeof window !== 'undefined' ? getStudentUser() : null;

  // Auth guard
  useEffect(() => {
    const token = getStudentToken();
    if (!token) router.replace('/student/login');
  }, [router]);

  const fetchTests = useCallback(async () => {
    const token = getStudentToken();
    if (!token) return;
    setError('');
    setLoading(true);
    try {
      const res = await studentTestsApi.list(token);
      setTests(res.data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load tests';
      if (msg.includes('401')) { clearStudentSession(); router.replace('/student/login'); return; }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { fetchTests(); }, [fetchTests]);

  function handleTestClick(test: TestRecord) {
    if (test.is_restricted) return; // locked — card shows message
    const win = getWindowState(test.available_from, test.available_until);
    const testDay = parseLocalDate(test.date);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const isFuture = testDay ? testDay > todayStart : false;
    if (isFuture && test.attempt_status !== 'completed') return;
    if (win === 'closed' && test.attempt_status !== 'completed') return;
    if (win === 'before' && test.attempt_status !== 'in_progress' && test.attempt_status !== 'completed') return;
    router.push(`/student/tests/${test.id}`);
  }

  function handleLogout() {
    clearStudentSession();
    router.replace('/student/login');
  }

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'current',   label: 'Current' },
    { key: 'upcoming',  label: 'Upcoming' },
    { key: 'completed', label: 'Completed' },
  ];

  const allTests      = tests;
  const visibleTests  = filterTests(allTests, activeTab);
  const tabCounts     = { current: filterTests(allTests, 'current').length, upcoming: filterTests(allTests, 'upcoming').length, completed: filterTests(allTests, 'completed').length };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top bar */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold text-sm">
              E
            </div>
            <div>
              <p className="text-sm font-bold text-gray-900 leading-none">My Tests</p>
              {student && (
                <p className="text-xs text-gray-500 mt-0.5">{student.name} · {student.class_name} {student.section}</p>
              )}
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="text-xs font-medium text-gray-500 hover:text-red-600 transition-colors px-3 py-1.5 rounded-lg hover:bg-red-50"
          >
            Sign Out
          </button>
        </div>

        {/* Tabs */}
        <div className="max-w-2xl mx-auto px-4 flex border-t border-gray-100">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              role="tab"
              aria-selected={activeTab === tab.key}
              className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
              {tabCounts[tab.key] > 0 && (
                <span className={`px-1.5 py-0.5 rounded-full text-xs font-bold ${
                  activeTab === tab.key ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'
                }`}>
                  {tabCounts[tab.key]}
                </span>
              )}
            </button>
          ))}
        </div>
      </header>

      {/* Content */}
      <main className="max-w-2xl mx-auto px-4 py-6 space-y-3">
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="text-center py-16">
            <p className="text-sm text-red-600 mb-4">⚠️ {error}</p>
            <button
              onClick={fetchTests}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
            >
              Retry
            </button>
          </div>
        ) : visibleTests.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-4xl mb-4">📝</p>
            <p className="text-sm text-gray-400">
              {activeTab === 'current' ? 'No active tests right now.' : activeTab === 'upcoming' ? 'No upcoming tests.' : 'No completed tests yet.'}
            </p>
          </div>
        ) : (
          visibleTests.map((test) => (
            <TestCard key={test.id} test={test} onClick={() => handleTestClick(test)} />
          ))
        )}
      </main>
    </div>
  );
}
