'use client';

/**
 * /admin/premium-insights
 *
 * Admin view: per-student weak topics + latest AI monthly report.
 * Accessible to schooladmin and superadmin.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

interface StudentSub {
  id: string;
  full_name: string;
  class_name: string;
  section: string;
}

interface MonthlyReport {
  month_start_date: string;
  report_text: string;
  generated_at: string;
}

interface Streak {
  current: number;
  longest: number;
}

interface InsightsData {
  latest_report: MonthlyReport | null;
  past_reports: MonthlyReport[];
  weak_topics: string[];
  streak: Streak | null;
  marks_summary: Record<string, number>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function avgBarColor(avg: number): string {
  if (avg >= 75) return 'bg-green-500';
  if (avg >= 50) return 'bg-yellow-500';
  return 'bg-red-500';
}

function formatDate(iso: string): string {
  const d = (iso && !iso.endsWith('Z') && !iso.includes('+') && !/\d{2}:\d{2}$/.test(iso))
    ? new Date(iso + 'Z') : new Date(iso);
  return d.toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function formatMonthYear(iso: string): string {
  const d = (iso && !iso.endsWith('Z') && !iso.includes('+') && !/\d{2}:\d{2}$/.test(iso))
    ? new Date(iso + 'Z') : new Date(iso);
  return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function InsightsSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-32 bg-gray-100 rounded-xl" />
      <div className="h-6 w-40 bg-gray-100 rounded" />
      <div className="space-y-2">
        {[1, 2, 3].map((i) => <div key={i} className="h-12 bg-gray-100 rounded-xl" />)}
      </div>
      <div className="h-6 w-48 bg-gray-100 rounded" />
      <div className="space-y-2">
        {[1, 2].map((i) => <div key={i} className="h-10 bg-gray-100 rounded" />)}
      </div>
    </div>
  );
}

// ── Collapsible Past Report Card ──────────────────────────────────────────────

function PastReportCard({ report }: { report: MonthlyReport }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between px-4 py-3 bg-white hover:bg-gray-50 transition-colors text-left"
      >
        <span className="text-sm font-medium text-gray-800">
          Month of {formatMonthYear(report.month_start_date)}
        </span>
        <span className="text-gray-400 text-sm">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="bg-blue-50 border-t border-blue-100 p-4">
          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">
            {report.report_text}
          </p>
          <p className="text-xs text-gray-400 mt-3">
            Generated: {formatDate(report.generated_at)}
          </p>
        </div>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function PremiumInsightsPage() {

  // All students in the school
  const [students, setStudents] = useState<StudentSub[]>([]);
  const [loadingStudents, setLoadingStudents] = useState(true);

  // Selected student for insights
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [insights, setInsights] = useState<InsightsData | null>(null);
  const [loadingInsights, setLoadingInsights] = useState(false);
  const [insightsError, setInsightsError] = useState<string | null>(null);

  // Search
  const [search, setSearch] = useState('');
  const [recalculating, setRecalculating] = useState(false);
  const [recalcMsg, setRecalcMsg] = useState<string | null>(null);

  // ── Load all students ────────────────────────────────────────────────────

  const loadStudents = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoadingStudents(true);
    try {
      const res = await fetch(
        `${BASE_URL}/api/admin/students?limit=500`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const json = await res.json();
      const rows = (json.data?.data ?? json.data ?? []) as Array<Record<string, unknown>>;
      const mapped: StudentSub[] = rows.map((r) => ({
        id: r.id as string,
        full_name: (r.full_name as string) ?? 'Unknown',
        class_name: (r.class_name as string) ?? '',
        section: (r.section as string) ?? '',
      }));
      setStudents(mapped);
    } catch (e) {
      console.error('[AIInsights] loadStudents error:', e);
    } finally {
      setLoadingStudents(false);
    }
  }, []);

  useEffect(() => { loadStudents(); }, [loadStudents]);

  // ── Load insights for selected student ───────────────────────────────────

  const loadInsights = useCallback(async (studentId: string) => {
    const token = getToken();
    if (!token) return;
    setLoadingInsights(true);
    setInsightsError(null);
    try {
      const res = await fetch(
        `${BASE_URL}/api/monthly-analysis/insights/${studentId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to load insights');
      setInsights(json.data ?? null);
    } catch (e) {
      setInsightsError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoadingInsights(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) {
      setInsights(null);
      loadInsights(selectedId);
    }
  }, [selectedId, loadInsights]);

  // ── Recalculate ────────────────────────────────────────────────────────────

  const handleRecalculate = async () => {
    if (!selectedId) return;
    const token = getToken();
    if (!token) return;
    setRecalculating(true);
    setRecalcMsg(null);
    try {
      const res = await fetch(
        `${BASE_URL}/api/monthly-analysis/recalculate/${selectedId}`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed');
      setRecalcMsg('Recalculation complete. Report updated.');
      // Reload insights
      await loadInsights(selectedId);
    } catch (e) {
      setRecalcMsg(e instanceof Error ? e.message : 'Recalculation failed');
    } finally {
      setRecalculating(false);
      setTimeout(() => setRecalcMsg(null), 5000);
    }
  };

  // ── Filtered students ─────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    if (!search.trim()) return students;
    const q = search.toLowerCase();
    return students.filter(
      (s) =>
        s.full_name.toLowerCase().includes(q) ||
        s.class_name.toLowerCase().includes(q)
    );
  }, [students, search]);

  const selectedStudent = students.find((s) => s.id === selectedId);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <PageHeader
        title="✨ AI Insights"
        description="Monthly AI-powered student performance reports, delivered on the 1st of each month"
        action={
          selectedId ? (
            <button
              onClick={handleRecalculate}
              disabled={recalculating || loadingInsights}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-blue-300 transition-colors"
            >
              {recalculating ? (
                <>
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Recalculating…
                </>
              ) : (
                '↻ Recalculate'
              )}
            </button>
          ) : undefined
        }
      />

      {recalcMsg && (
        <div className="px-4 py-3 bg-blue-50 border border-blue-200 rounded-xl text-sm text-blue-700">
          {recalcMsg}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Student list panel ─────────────────────────────────────────── */}
        <div className="lg:col-span-1 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">Students</h2>
            <span className="text-xs text-gray-400">{students.length} total</span>
          </div>

          <input
            type="text"
            placeholder="Search students…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />

          <div className="space-y-1 max-h-[60vh] overflow-y-auto">
            {loadingStudents ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-14 bg-gray-100 rounded-xl animate-pulse" />
              ))
            ) : filtered.length === 0 ? (
              <div className="text-center py-8 text-sm text-gray-400">
                {students.length === 0
                  ? 'No students found.'
                  : 'No students match your search.'}
              </div>
            ) : (
              filtered.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelectedId(s.id)}
                  className={`w-full text-left px-4 py-3 rounded-xl border transition-colors ${
                    selectedId === s.id
                      ? 'border-blue-300 bg-blue-50'
                      : 'border-gray-100 bg-white hover:bg-gray-50'
                  }`}
                >
                  <p className="text-sm font-semibold text-gray-900 truncate">{s.full_name}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Class {s.class_name}{s.section ? ` · ${s.section}` : ''}
                  </p>
                </button>
              ))
            )}
          </div>
        </div>

        {/* ── Insights panel ────────────────────────────────────────────── */}
        <div className="lg:col-span-2">
          {!selectedId ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
              <div className="text-4xl mb-4">👈</div>
              <p className="text-sm text-gray-500">Select a student to view their AI insights.</p>
            </div>
          ) : loadingInsights ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <InsightsSkeleton />
            </div>
          ) : insightsError ? (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
              {insightsError}
            </div>
          ) : !insights ? null : (
            <div className="space-y-5">
              {/* Student info header */}
              <div className="bg-white rounded-2xl border border-gray-200 px-6 py-4 flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center text-xl font-bold text-blue-700">
                  {selectedStudent?.full_name.charAt(0) ?? '?'}
                </div>
                <div>
                  <p className="font-semibold text-gray-900">{selectedStudent?.full_name}</p>
                  <p className="text-sm text-gray-500">
                    Class {selectedStudent?.class_name}{selectedStudent?.section ? ` · ${selectedStudent.section}` : ''}
                  </p>
                </div>

                {/* Streak badge */}
                {insights.streak && insights.streak.current > 0 && (
                  <div className="ml-auto flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-full px-4 py-1.5">
                    <span className="text-lg">🔥</span>
                    <span className="text-sm font-bold text-amber-700">
                      {insights.streak.current} day streak
                    </span>
                  </div>
                )}
              </div>

              {/* AI Monthly Report */}
              <div className="bg-white rounded-2xl border border-gray-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-gray-900">📝 Latest AI Monthly Report</h3>
                  {insights.latest_report && (
                    <span className="text-xs text-gray-400">
                      Month of {formatMonthYear(insights.latest_report.month_start_date)}
                    </span>
                  )}
                </div>

                {insights.latest_report ? (
                  <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
                    <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">
                      {insights.latest_report.report_text}
                    </p>
                    <p className="text-xs text-gray-400 mt-3">
                      Generated: {formatDate(insights.latest_report.generated_at)}
                    </p>
                  </div>
                ) : (
                  <div className="bg-gray-50 rounded-xl p-6 text-center">
                    <p className="text-sm text-gray-400">
                      No report generated yet. Reports are created on the 1st of each month, or you can trigger a manual recalculation above.
                    </p>
                  </div>
                )}
              </div>

              {/* Previous Monthly Reports */}
              {insights.past_reports.length > 0 && (
                <div className="bg-white rounded-2xl border border-gray-200 p-6">
                  <h3 className="text-sm font-semibold text-gray-900 mb-4">📅 Previous Monthly Reports</h3>
                  <div className="space-y-2">
                    {insights.past_reports.map((report, i) => (
                      <PastReportCard key={i} report={report} />
                    ))}
                  </div>
                </div>
              )}

              {/* Weak Topics */}
              {insights.weak_topics.length > 0 && (
                <div className="bg-white rounded-2xl border border-gray-200 p-6">
                  <h3 className="text-sm font-semibold text-gray-900 mb-4">🎯 Weak Topics</h3>
                  <div className="space-y-2">
                    {insights.weak_topics.map((topic, i) => (
                      <div
                        key={i}
                        className="flex items-center px-4 py-3 rounded-xl bg-gray-50 border border-gray-100"
                      >
                        <p className="text-sm font-medium text-gray-900">{topic}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Subject Performance Chart */}
              {Object.keys(insights.marks_summary).length > 0 && (
                <div className="bg-white rounded-2xl border border-gray-200 p-6">
                  <h3 className="text-sm font-semibold text-gray-900 mb-4">📊 Subject Performance</h3>
                  <div className="space-y-3">
                    {Object.entries(insights.marks_summary)
                      .sort(([, a], [, b]) => b - a)
                      .map(([subject, avg]) => (
                        <div key={subject} className="flex items-center gap-3">
                          <span className="text-sm text-gray-700 w-28 shrink-0 truncate">
                            {subject}
                          </span>
                          <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className={`h-3 rounded-full transition-all ${avgBarColor(avg)}`}
                              style={{ width: `${Math.min(avg, 100)}%` }}
                            />
                          </div>
                          <span
                            className={`text-sm font-bold w-12 text-right ${
                              avg >= 75
                                ? 'text-green-600'
                                : avg >= 50
                                ? 'text-yellow-600'
                                : 'text-red-600'
                            }`}
                          >
                            {avg}%
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* Streak stats */}
              {insights.streak && (
                <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6">
                  <h3 className="text-sm font-semibold text-gray-900 mb-3">🔥 Study Streak</h3>
                  <div className="grid grid-cols-2 gap-4 text-center">
                    {[
                      { label: 'Current', value: insights.streak.current, unit: 'days', color: 'text-amber-600' },
                      { label: 'Best', value: insights.streak.longest, unit: 'days', color: 'text-amber-700' },
                    ].map(({ label, value, unit, color }) => (
                      <div key={label}>
                        <p className={`text-3xl font-extrabold ${color}`}>{value}</p>
                        <p className="text-xs text-gray-500 mt-1">{unit}</p>
                        <p className="text-xs font-medium text-gray-600">{label}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
