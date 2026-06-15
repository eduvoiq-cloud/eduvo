'use client';

/**
 * StreakLeaderboard.tsx
 *
 * Shared component used by both:
 *   /admin/streak-leaderboard   (school admin — school-wide view)
 *   /teacher/streak-leaderboard (teacher   — their class/section)
 *
 * Features:
 *  - Class + section selector
 *  - Top-5 students per class by current_streak
 *  - Flame icons for top 3
 *  - Refresh button
 *  - School-wide summary for admins
 */

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { getToken } from '@/lib/session';
import { assignmentsApi, TeacherAssignment } from '@/lib/api';
import PageHeader from '@/components/PageHeader';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LeaderboardEntry {
  rank: number;
  student_id: string;
  student_name: string;
  class_name: string;
  section: string;
  current_streak: number;
  longest_streak: number;
  total_active_days: number;
}

// school-wide: Record<"7 A", LeaderboardEntry[]>
type SchoolLeaderboard = Record<string, LeaderboardEntry[]>;

// ── Helpers ───────────────────────────────────────────────────────────────────

const RANK_MEDAL = ['🥇', '🥈', '🥉'];

function flameColor(streak: number): string {
  if (streak >= 30) return 'text-red-500';
  if (streak >= 14) return 'text-orange-500';
  if (streak >= 7)  return 'text-yellow-500';
  return 'text-gray-400';
}

function FlameCount({ streak }: { streak: number }) {
  return (
    <span className={`flex items-center gap-1 font-bold text-lg ${flameColor(streak)}`}>
      🔥 {streak}
      <span className="text-xs font-normal text-gray-500 ml-0.5">
        day{streak !== 1 ? 's' : ''}
      </span>
    </span>
  );
}

function LeaderboardTable({ entries, title }: { entries: LeaderboardEntry[]; title: string }) {
  if (entries.length === 0) return null;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      {/* Table header */}
      <div className="px-5 py-3 bg-gradient-to-r from-orange-50 to-yellow-50 border-b border-gray-200 flex items-center gap-2">
        <span className="text-lg">🏆</span>
        <h3 className="font-bold text-gray-800 text-sm">{title}</h3>
        <span className="ml-auto text-xs text-gray-500">Top {entries.length}</span>
      </div>

      <div className="divide-y divide-gray-100">
        {entries.map((entry) => (
          <div
            key={entry.student_id}
            className={`flex items-center gap-4 px-5 py-3.5 hover:bg-gray-50 transition-colors ${
              entry.rank === 1 ? 'bg-yellow-50/50' : ''
            }`}
          >
            {/* Rank */}
            <div className="w-8 text-center flex-shrink-0">
              {entry.rank <= 3 ? (
                <span className="text-xl">{RANK_MEDAL[entry.rank - 1]}</span>
              ) : (
                <span className="text-sm font-bold text-gray-400">#{entry.rank}</span>
              )}
            </div>

            {/* Avatar */}
            <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-sm font-bold ${
              entry.rank === 1
                ? 'bg-yellow-100 text-yellow-700'
                : entry.rank === 2
                ? 'bg-gray-100 text-gray-600'
                : entry.rank === 3
                ? 'bg-orange-100 text-orange-700'
                : 'bg-blue-50 text-blue-600'
            }`}>
              {entry.student_name.charAt(0).toUpperCase()}
            </div>

            {/* Name */}
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-gray-900 text-sm truncate">{entry.student_name}</p>
              <p className="text-xs text-gray-400">
                {entry.total_active_days} active day{entry.total_active_days !== 1 ? 's' : ''} total
              </p>
            </div>

            {/* Streak */}
            <div className="flex-shrink-0 text-right">
              <FlameCount streak={entry.current_streak} />
              <p className="text-xs text-gray-400 mt-0.5">
                Best: {entry.longest_streak}d
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  /** 'admin' = school-wide overview; 'teacher' = single class filter */
  mode: 'admin' | 'teacher';
}

export default function StreakLeaderboard({ mode }: Props) {
  const { user } = useAuth();

  // Filter state (used in teacher mode or when admin selects a class)
  const [filterClass, setFilterClass] = useState('');
  const [filterSection, setFilterSection] = useState('');

  // Teacher's assigned classes (teacher mode only)
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);

  // Data
  const [schoolData, setSchoolData] = useState<SchoolLeaderboard | null>(null);
  const [singleData, setSingleData] = useState<LeaderboardEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  // ── Fetch school-wide leaderboard (admin) ─────────────────────────────────
  const fetchSchoolLeaderboard = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${BASE_URL}/api/student-progress/leaderboard/school`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to load leaderboard');
      setSchoolData(json.data ?? {});
      setLastRefreshed(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Fetch single class leaderboard ────────────────────────────────────────
  const fetchClassLeaderboard = useCallback(async (cls: string, section: string) => {
    if (!cls || !section) return;
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError(null);
    setSingleData(null);
    try {
      const params = new URLSearchParams({ class: cls, section });
      const res = await fetch(
        `${BASE_URL}/api/student-progress/leaderboard?${params}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to load leaderboard');
      setSingleData(json.data ?? []);
      setLastRefreshed(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-load on mount
  useEffect(() => {
    if (mode === 'admin') {
      fetchSchoolLeaderboard();
    }
  }, [mode, fetchSchoolLeaderboard]);

  // ── Fetch teacher's assignments (teacher mode only) ────────────────────────
  useEffect(() => {
    if (mode !== 'teacher') return;
    const token = getToken();
    if (!token || !user?.school_id) return;
    assignmentsApi
      .list(token, user.school_id)
      .then((res) => setAssignments(res.data.filter((a) => a.teacher_id === user.id)))
      .catch(() => {});
  }, [mode, user]);

  // ── Derived: teacher's own classes & sections ────────────────────────────
  const myClasses = [...new Set(assignments.map((a) => a.class_name))].sort();
  const sectionsForClass = [...new Set(
    assignments.filter((a) => a.class_name === filterClass).map((a) => a.section)
  )].sort();

  // ── Derived: sorted class keys for admin view ─────────────────────────────
  const sortedClassKeys = schoolData
    ? Object.keys(schoolData).sort((a, b) => {
        // Sort by class number first, then section
        const [aClass, aSection = ''] = a.split(' ');
        const [bClass, bSection = ''] = b.split(' ');
        const aNum = parseInt(aClass.replace(/\D/g, ''), 10) || 0;
        const bNum = parseInt(bClass.replace(/\D/g, ''), 10) || 0;
        if (aNum !== bNum) return aNum - bNum;
        return aSection.localeCompare(bSection);
      })
    : [];

  // Total active streaks across school
  const totalActiveStreaks = schoolData
    ? Object.values(schoolData).reduce((sum, arr) => sum + arr.length, 0)
    : 0;

  const highestStreak = schoolData
    ? Object.values(schoolData)
        .flat()
        .reduce((max, e) => Math.max(max, e.current_streak), 0)
    : 0;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <PageHeader
          title="🔥 Streak Leaderboard"
          description={
            mode === 'admin'
              ? 'Top 5 students by current streak in each class — great for notice boards and TV screens'
              : 'Top 5 students by current streak in your class'
          }
        />

        {/* Refresh button */}
        <button
          onClick={() => {
            if (mode === 'admin') fetchSchoolLeaderboard();
            else if (filterClass && filterSection) fetchClassLeaderboard(filterClass, filterSection);
          }}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-orange-500 hover:bg-orange-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
        >
          {loading ? (
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            <span>↻</span>
          )}
          Refresh
        </button>
      </div>

      {/* Last refreshed */}
      {lastRefreshed && (
        <p className="text-xs text-gray-400">
          Last updated: {lastRefreshed.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </p>
      )}

      {/* ── Teacher mode: class + section picker ── */}
      {mode === 'teacher' && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
          <p className="text-sm font-semibold text-gray-700 mb-4">Select Class & Section</p>
          <div className="flex flex-wrap gap-3">
            <select
              value={filterClass}
              onChange={(e) => {
                setFilterClass(e.target.value);
                setFilterSection('');
                setSingleData(null);
              }}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-40 focus:outline-none focus:ring-2 focus:ring-orange-400 bg-white"
            >
              <option value="">Select Class…</option>
              {myClasses.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <select
              value={filterSection}
              onChange={(e) => {
                setFilterSection(e.target.value);
                setSingleData(null);
              }}
              disabled={!filterClass}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-40 focus:outline-none focus:ring-2 focus:ring-orange-400 bg-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="">Select Section…</option>
              {sectionsForClass.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <button
              onClick={() => fetchClassLeaderboard(filterClass, filterSection)}
              disabled={!filterClass || !filterSection || loading}
              className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              View Leaderboard
            </button>
          </div>
        </div>
      )}

      {/* ── Admin mode: summary stats ── */}
      {mode === 'admin' && schoolData && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 text-center">
            <p className="text-2xl font-black text-orange-600">{totalActiveStreaks}</p>
            <p className="text-xs text-orange-500 font-medium mt-1">Active Streaks</p>
          </div>
          <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-center">
            <p className="text-2xl font-black text-yellow-600">{highestStreak}</p>
            <p className="text-xs text-yellow-500 font-medium mt-1">Highest Streak</p>
          </div>
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-center">
            <p className="text-2xl font-black text-blue-600">{sortedClassKeys.length}</p>
            <p className="text-xs text-blue-500 font-medium mt-1">Active Classes</p>
          </div>
        </div>
      )}

      {/* ── Admin mode: optional single-class filter ── */}
      {mode === 'admin' && (
        <details className="group">
          <summary className="cursor-pointer text-sm text-blue-600 hover:text-blue-800 font-medium list-none flex items-center gap-1">
            <span className="group-open:hidden">▶</span>
            <span className="hidden group-open:inline">▼</span>
            Filter by specific class
          </summary>
          <div className="mt-3 bg-white rounded-xl border border-gray-200 p-4 flex flex-wrap gap-3">
            <input
              type="text"
              placeholder="Class (e.g. 10)"
              value={filterClass}
              onChange={(e) => setFilterClass(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-32 focus:outline-none focus:ring-2 focus:ring-orange-400"
            />
            <input
              type="text"
              placeholder="Section (e.g. A)"
              value={filterSection}
              onChange={(e) => setFilterSection(e.target.value.toUpperCase())}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-32 focus:outline-none focus:ring-2 focus:ring-orange-400"
            />
            <button
              onClick={() => fetchClassLeaderboard(filterClass, filterSection)}
              disabled={!filterClass || !filterSection || loading}
              className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              Load Class
            </button>
          </div>

          {/* Single class result */}
          {singleData !== null && (
            <div className="mt-4">
              {singleData.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-6">
                  No active streaks in Class {filterClass} {filterSection} yet.
                </p>
              ) : (
                <LeaderboardTable
                  entries={singleData}
                  title={`Class ${filterClass} – Section ${filterSection}`}
                />
              )}
            </div>
          )}
        </details>
      )}

      {/* ── Error state ── */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
          ⚠️ {error}
        </div>
      )}

      {/* ── Loading skeleton ── */}
      {loading && (
        <div className="space-y-4 animate-pulse">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-40 bg-gray-100 rounded-2xl" />
          ))}
        </div>
      )}

      {/* ── Teacher mode: single class result ── */}
      {mode === 'teacher' && !loading && singleData !== null && (
        <div>
          {singleData.length === 0 ? (
            <div className="bg-white rounded-2xl border border-dashed border-gray-300 p-10 text-center">
              <p className="text-3xl mb-3">🔥</p>
              <p className="font-semibold text-gray-700">No active streaks yet</p>
              <p className="text-sm text-gray-400 mt-1">
                Students start building streaks when they complete tests or home activities.
              </p>
            </div>
          ) : (
            <LeaderboardTable
              entries={singleData}
              title={`Class ${filterClass} – Section ${filterSection}`}
            />
          )}
        </div>
      )}

      {/* ── Admin mode: school-wide grid ── */}
      {mode === 'admin' && !loading && schoolData && (
        <div>
          {sortedClassKeys.length === 0 ? (
            <div className="bg-white rounded-2xl border border-dashed border-gray-300 p-10 text-center">
              <p className="text-3xl mb-3">🔥</p>
              <p className="font-semibold text-gray-700">No active streaks in the school yet</p>
              <p className="text-sm text-gray-400 mt-1">
                Students build streaks by completing tests or home activities every day.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {sortedClassKeys.map((key) => (
                <LeaderboardTable
                  key={key}
                  entries={schoolData[key]}
                  title={`Class ${key}`}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── TV / notice-board tip ── */}
      {mode === 'admin' && !loading && totalActiveStreaks > 0 && (
        <p className="text-xs text-center text-gray-400 mt-2">
          💡 Tip: You can display this leaderboard on a classroom TV or notice board to motivate students.
          Refresh auto-shows the latest data.
        </p>
      )}
    </div>
  );
}
