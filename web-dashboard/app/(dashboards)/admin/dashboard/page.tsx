'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import {
  authApi,
  studentsApi,
  usersApi,
  complaintsApi,
  feesApi,
  testsApi,
  adminApi,
  attendanceApi,
  onboardingApi,
  homeworkAIStatsApi,
  type Student,
  type Teacher,
  type Complaint,
  type FeeRecord,
  type Test,
  type AuditLog,
  type OnboardingProgress,
  type HomeworkAIStats,
} from '@/lib/api';
import { getToken, saveSession } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import StatCard from '@/components/StatCard';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DashboardStats {
  totalStudents: number;
  studentTrend: number | null; // delta vs last month (null = unknown)
  totalTeachers: number;
  attendancePct: number | null; // null while loading
  pendingComplaints: number;
  feeDefaulters: number;
  activeTests: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse an ISO timestamp string as UTC.
 * Supabase/PostgREST may return timestamptz values without a timezone designator
 * (e.g. "2026-06-16T04:27:00" instead of "2026-06-16T04:27:00Z"). Without the
 * suffix, JavaScript's Date constructor treats the string as LOCAL time, which
 * causes timestamps to appear shifted by the browser's UTC offset (e.g. +5:30h
 * for IST users). Appending "Z" forces UTC interpretation.
 */
function parseUtcDate(iso: string): Date {
  if (iso && !iso.endsWith('Z') && !iso.includes('+') && !/\d{2}:\d{2}$/.test(iso)) {
    return new Date(iso + 'Z');
  }
  return new Date(iso);
}

/** Format a relative time string from an ISO timestamp. */
function timeAgo(iso: string): string {
  const diff = Date.now() - parseUtcDate(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Convert an audit log action + details into a human-readable sentence. */
function formatAuditEntry(log: AuditLog): string {
  const actor = log.users?.name ?? 'Someone';
  const d = log.details ?? {};

  switch (log.action) {
    case 'STUDENT_CREATED':
      return `${actor} added student ${d.student_name ?? ''}`;
    case 'STUDENT_UPDATED':
      return `${actor} updated student record`;
    case 'STUDENT_DELETED':
      return `${actor} removed student ${d.student_name ?? ''}`;
    case 'TEACHER_CREATED':
      return `${actor} added teacher ${d.teacher_name ?? ''}`;
    case 'TEACHER_DELETED':
      return `${actor} removed teacher ${d.teacher_name ?? ''}`;
    case 'TEACHER_ASSIGNED':
      return `${actor} assigned ${d.teacher_name ?? 'a teacher'} to ${d.class ?? ''} ${d.section ?? ''}`;
    case 'ATTENDANCE_RECORDED':
    case 'manual_attendance_batch':
      return `${actor} recorded attendance`;
    case 'attendance_corrected':
      return `${actor} corrected an attendance record`;
    case 'FEE_TOGGLED':
      return `${actor} updated fee status for ${d.student_name ?? 'a student'}`;
    case 'TEST_CREATED':
      return `${actor} created test "${d.title ?? ''}"`;
    case 'TEST_SUBMITTED':
      return `A student submitted a test`;
    case 'THEORY_MARKED':
      return `${actor} marked theory answers`;
    case 'COMPLAINT_SUBMITTED':
      return `A complaint was submitted`;
    case 'COMPLAINT_STATUS_UPDATED':
      return `${actor} updated a complaint status to ${d.new_status ?? ''}`;
    case 'ANNOUNCEMENT_CREATED':
      return `${actor} sent an announcement`;
    case 'SCHOOL_SETTINGS_UPDATED':
      return `${actor} updated school settings`;
    case 'DATA_EXPORTED':
      return `${actor} exported school data`;
    default:
      return `${actor} performed ${log.action.toLowerCase().replace(/_/g, ' ')}`;
  }
}

// ── Skeleton stat card ────────────────────────────────────────────────────────

function StatCardSkeleton() {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 animate-pulse">
      <div className="flex items-center justify-between mb-3">
        <div className="h-3 bg-gray-200 rounded w-28" />
        <div className="w-8 h-8 bg-gray-200 rounded-lg" />
      </div>
      <div className="h-7 bg-gray-200 rounded w-16 mb-2" />
      <div className="h-3 bg-gray-200 rounded w-32" />
    </div>
  );
}

// ── Skeleton activity feed ────────────────────────────────────────────────────

function ActivityFeedSkeleton() {
  return (
    <div className="divide-y divide-gray-50">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 px-6 py-3 animate-pulse">
          <div className="mt-0.5 w-7 h-7 rounded-full bg-gray-200 shrink-0" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 bg-gray-200 rounded w-3/4" />
            <div className="h-3 bg-gray-200 rounded w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SchoolAdminDashboard() {
  const { user } = useAuth();

  const [stats, setStats] = useState<DashboardStats>({
    totalStudents: 0,
    studentTrend: null,
    totalTeachers: 0,
    attendancePct: null,
    pendingComplaints: 0,
    feeDefaulters: 0,
    activeTests: 0,
  });
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [onboarding, setOnboarding] = useState<OnboardingProgress | null>(null);
  const [homeworkAIStats, setHomeworkAIStats] = useState<HomeworkAIStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [auditLoading, setAuditLoading] = useState(true);
  useEffect(() => {
    const token = getToken();
    if (!token) return;

    const today = new Date().toISOString().slice(0, 10);

    async function loadDashboard() {
      // If school_id is missing from the cached session (stale localStorage),
      // fetch the fresh profile from the server before doing anything else.
      let schoolId = user?.school_id ?? null;
      if (!schoolId) {
        try {
          const meRes = await authApi.me(token!);
          schoolId = meRes.data.user.school_id;
          if (schoolId) {
            // Persist the refreshed profile so future loads are instant
            saveSession(token!, meRes.data.user);
          }
        } catch {
          // Can't reach server — nothing to show
          setLoading(false);
          setAuditLoading(false);
          return;
        }
      }

      if (!schoolId) {
        // Still no school_id after refresh — account not linked to a school
        setLoading(false);
        setAuditLoading(false);
        return;
      }

      // Fetch all stats in parallel
      Promise.all([
        studentsApi.list(token!, { school_id: schoolId, limit: 0 }),
        usersApi.list(token!, { role: 'teacher', school_id: schoolId }),
        attendanceApi.check(token!, { class_name: '', date: today }).catch(() => null),
        complaintsApi.list(token!, { status: 'pending', role: 'schooladmin' }).catch(() => ({ data: [] as Complaint[] })),
        feesApi.list(token!),
        testsApi.list(token!),
      ])
        .then(([studentsRes, teachersRes, attendanceRes, complaintsRes, feesRes, testsRes]) => {
          // limit=0 returns a plain array; guard against paginated envelope shape
          const rawStudents = studentsRes.data;
          const students: Student[] = (Array.isArray(rawStudents)
            ? rawStudents
            : (rawStudents as unknown as { data: Student[] })?.data ?? []) as Student[];
          const teachers: Teacher[] = (teachersRes.data as unknown as {data: Teacher[]}).data ?? teachersRes.data as unknown as Teacher[] ?? [];
          const complaints: Complaint[] = complaintsRes.data ?? [];
          const feesRaw = (feesRes.data as unknown as {data: FeeRecord[]}).data ?? feesRes.data as unknown as FeeRecord[] ?? [];
          const fees: FeeRecord[] = Array.isArray(feesRaw) ? feesRaw : [];
          const tests: Test[] = testsRes.data ?? [];

          // Attendance % — use today-count endpoint data if available
          let attendancePct: number | null = null;
          if (attendanceRes) {
            const existing = attendanceRes.data?.existing ?? [];
            const total = attendanceRes.data?.students?.length ?? 0;
            if (total > 0) {
              const present = existing.filter((r) => r.status === 'present').length;
              attendancePct = Math.round((present / total) * 100);
            } else {
              attendancePct = 0;
            }
          }

          // Fee defaulters: students with fee_paid = false
          const feeDefaulters = fees.filter((f) => !f.fee_paid).length;

          // Active tests: tests scheduled today or in the future
          const activeTests = tests.filter((t) => {
            if (!t.date) return false;
            return t.date >= today;
          }).length;

          setStats({
            totalStudents: students.length,
            studentTrend: null,
            totalTeachers: teachers.length,
            attendancePct,
            pendingComplaints: complaints.length,
            feeDefaulters,
            activeTests,
          });
        })
        .catch(() => {})
        .finally(() => setLoading(false));

      // Fetch audit logs separately so stats don't wait on it
      adminApi
        .auditLogs(token!, 10)
        .then((res) => setAuditLogs(res.data ?? []))
        .catch(() => {})
        .finally(() => setAuditLoading(false));

      // Fetch onboarding status (non-blocking)
      onboardingApi
        .getStatus(token!)
        .then((res) => {
          if (!res.data.completed) {
            setOnboarding(res.data);
          }
        })
        .catch(() => {});

      // Fetch homework AI stats (non-blocking)
      homeworkAIStatsApi
        .get(token!)
        .then((res) => setHomeworkAIStats(res.data))
        .catch(() => {});
    }

    loadDashboard();
  }, [user]);

  return (
    <>
      <PageHeader
        title={`Welcome back, ${user?.name}`}
        description="School overview and quick actions"
      />

      {/* ── Onboarding banner ──────────────────────────────────────────────── */}
      {onboarding && !onboarding.completed && (
        <OnboardingBanner progress={onboarding} />
      )}

      {/* ── Stats grid ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        {loading ? (
          <>
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
          </>
        ) : (
          <>
            <StatCard
              label="Total Students"
              value={stats.totalStudents}
              sub={
                stats.studentTrend !== null
                  ? `${stats.studentTrend >= 0 ? '+' : ''}${stats.studentTrend} vs last month`
                  : 'Enrolled in your school'
              }
              icon={<StudentsIcon />}
            />
            <StatCard
              label="Total Teachers"
              value={stats.totalTeachers}
              sub="Active staff members"
              icon={<TeacherIcon />}
            />
            <StatCard
              label="Today's Attendance"
              value={stats.attendancePct === null ? '—' : `${stats.attendancePct}%`}
              sub="Present / total students"
              icon={<AttendanceIcon />}
            />
            <StatCard
              label="Pending Complaints"
              value={stats.pendingComplaints}
              sub="Awaiting review"
              icon={<ComplaintIcon />}
            />
            <StatCard
              label="Fee Defaulters"
              value={stats.feeDefaulters}
              sub="Fee not yet paid"
              icon={<FeeIcon />}
            />
            <StatCard
              label="Active Tests"
              value={stats.activeTests}
              sub="Scheduled today or upcoming"
              icon={<TestIcon />}
            />
          </>
        )}
      </div>

      {/* ── Quick actions ───────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-4">Quick Actions</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <QuickAction href="/admin/students?action=new" label="Add Student" icon={<StudentsIcon />} />
          <QuickAction href="/admin/teachers?action=new" label="Add Teacher" icon={<TeacherIcon />} />
          <QuickAction href="/admin/announcements" label="Send Announcement" icon={<AnnouncementIcon />} />
          <QuickAction href="/admin/attendance" label="View Attendance" icon={<AttendanceIcon />} />
          <QuickAction href="/admin/export" label="Export Data" icon={<ExportIcon />} />
        </div>
      </div>

      {/* ── Homework AI Stats Widget ────────────────────────────────────────── */}
      {homeworkAIStats !== null && homeworkAIStats.total_submissions_this_week > 0 && (
        <HomeworkAIStatsWidget stats={homeworkAIStats} />
      )}

      {/* ── Recent activity feed ────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200">        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">Recent Activity</h2>
          <span className="text-xs text-gray-400">Last 10 actions</span>
        </div>

        {auditLoading ? (
          <ActivityFeedSkeleton />
        ) : auditLogs.length === 0 ? (
          <div className="px-6 py-8 text-center text-sm text-gray-400">No activity recorded yet.</div>
        ) : (
          <div className="divide-y divide-gray-50">
            {auditLogs.map((log) => (
              <div key={log.id} className="flex items-start gap-3 px-6 py-3">
                <div className="mt-0.5 w-7 h-7 rounded-full bg-blue-50 flex items-center justify-center text-blue-600 shrink-0">
                  <ActivityDotIcon />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-gray-800 leading-snug">
                    {formatAuditEntry(log)}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">{timeAgo(log.created_at)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ── Homework AI Stats Widget ──────────────────────────────────────────────────

function HomeworkAIStatsWidget({ stats }: { stats: HomeworkAIStats }) {
  const totalChecked = stats.total_checked;
  const autoCheckedPct = stats.auto_checked_pct;
  const flaggedPct = stats.flagged_pct;
  const cacheHitPct = stats.total_submissions_this_week > 0
    ? Math.min(100, Math.round((stats.cache_hit_count / stats.total_submissions_this_week) * 100))
    : 0;

  return (
    <div className="bg-white rounded-xl border border-gray-200 mb-6">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <span className="flex items-center justify-center w-7 h-7 bg-violet-100 rounded-lg">
            <svg className="w-4 h-4 text-violet-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.347.416A2 2 0 0113 21H11a2 2 0 01-1.414-2.343l-.347-.416z" />
            </svg>
          </span>
          <h2 className="text-sm font-semibold text-gray-900">Homework AI Stats</h2>
          <span className="text-xs text-gray-400">— this week</span>
        </div>
        <span className="text-xs font-semibold px-2.5 py-1 bg-violet-50 text-violet-700 rounded-full">
          {stats.total_submissions_this_week} submission{stats.total_submissions_this_week !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="px-6 py-5 space-y-5">
        {/* Stat grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            {
              label: 'Total Submissions',
              value: stats.total_submissions_this_week,
              sub: 'this week',
              color: 'text-gray-900',
              bg: 'bg-gray-50 border-gray-200',
            },
            {
              label: 'Auto-Checked',
              value: `${autoCheckedPct}%`,
              sub: `${stats.auto_checked_count} submissions`,
              color: 'text-green-700',
              bg: 'bg-green-50 border-green-200',
            },
            {
              label: 'Flagged for Review',
              value: `${flaggedPct}%`,
              sub: `${stats.flagged_count} need review`,
              color: 'text-orange-700',
              bg: 'bg-orange-50 border-orange-200',
            },
            {
              label: 'Cache Hits',
              value: stats.cache_hit_count,
              sub: `~${cacheHitPct}% cost savings`,
              color: 'text-blue-700',
              bg: 'bg-blue-50 border-blue-200',
            },
          ].map((stat) => (
            <div key={stat.label} className={`rounded-xl border p-4 ${stat.bg}`}>
              <p className={`text-xl font-bold ${stat.color}`}>{stat.value}</p>
              <p className="text-xs font-medium text-gray-700 mt-0.5">{stat.label}</p>
              <p className="text-xs text-gray-400 mt-0.5">{stat.sub}</p>
            </div>
          ))}
        </div>

        {/* Progress bars */}
        <div className="space-y-2.5">
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500 w-36 shrink-0">Auto-checked</span>
            <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full bg-green-500 rounded-full" style={{ width: `${autoCheckedPct}%` }} />
            </div>
            <span className="text-xs font-medium text-gray-600 w-10 text-right shrink-0">{autoCheckedPct}%</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500 w-36 shrink-0">Flagged for review</span>
            <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full bg-orange-400 rounded-full" style={{ width: `${flaggedPct}%` }} />
            </div>
            <span className="text-xs font-medium text-gray-600 w-10 text-right shrink-0">{flaggedPct}%</span>
          </div>
        </div>

        {/* Teachers with pending reviews */}
        {stats.teachers_with_pending.length > 0 && (
          <div className="border-t border-gray-100 pt-4">
            <p className="text-xs font-semibold text-orange-600 uppercase tracking-wide mb-3">
              ⚑ Teachers with pending reviews
            </p>
            <div className="space-y-2">
              {stats.teachers_with_pending.map((t) => (
                <div key={t.teacher_id} className="flex items-center gap-3 px-3 py-2 bg-orange-50 border border-orange-100 rounded-lg">
                  <div className="w-7 h-7 rounded-full bg-orange-100 flex items-center justify-center text-xs font-bold text-orange-700 shrink-0">
                    {t.name.charAt(0).toUpperCase()}
                  </div>
                  <span className="text-sm text-gray-800 flex-1 min-w-0 truncate">{t.name}</span>
                  <span className="text-xs font-semibold px-2 py-0.5 bg-orange-200 text-orange-800 rounded-full shrink-0">
                    {t.pending_count} pending
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {totalChecked > 0 && stats.teachers_with_pending.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-100 rounded-lg px-3 py-2">
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            All flagged submissions have been reviewed. No pending reviews.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Onboarding Banner ─────────────────────────────────────────────────────────

function OnboardingBanner({ progress }: { progress: OnboardingProgress }) {
  const steps = [
    progress.school_created,
    progress.teachers_imported,
    progress.students_imported,
    progress.teachers_assigned,
  ];
  const completedCount = steps.filter(Boolean).length;
  const remaining = steps.length - completedCount;

  return (
    <div className="mb-6 flex items-center justify-between gap-4 px-5 py-4 bg-blue-50 border border-blue-200 rounded-xl">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
          <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
        </div>
        <p className="text-sm text-blue-800 font-medium truncate">
          Complete your school setup —{' '}
          <span className="font-semibold">{remaining} step{remaining !== 1 ? 's' : ''} remaining</span>
        </p>
      </div>
      <Link
        href="/admin/onboarding"
        className="shrink-0 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
      >
        Continue Setup →
      </Link>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function QuickAction({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex flex-col items-center gap-2 px-3 py-4 rounded-lg border border-gray-200 hover:border-blue-300 hover:bg-blue-50 text-center text-xs font-medium text-gray-700 hover:text-blue-700 transition-colors"
    >
      <span className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600">
        {icon}
      </span>
      {label}
    </Link>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function StudentsIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function TeacherIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
    </svg>
  );
}

function AttendanceIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
    </svg>
  );
}

function ComplaintIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
    </svg>
  );
}

function FeeIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function TestIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
    </svg>
  );
}

function AnnouncementIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
    </svg>
  );
}

function ActivityDotIcon() {
  return (
    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 8 8">
      <circle cx="4" cy="4" r="3" />
    </svg>
  );
}
