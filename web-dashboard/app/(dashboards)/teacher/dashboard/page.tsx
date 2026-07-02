'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import { complaintsApi, testsApi, type TeacherAssignment, type Student, type SuspiciousActivityRow } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import StatCard from '@/components/StatCard';

interface ReadyPackAlert {
  class_name: string;
  section: string;
  student_count: number;
}

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

interface ClassAdminEntry {
  class_name: string;
  section: string;
  appointed_at: string | null;
}

export default function TeacherDashboard() {
  const { user, loading: authLoading } = useAuth();
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [pendingComplaints, setPendingComplaints] = useState(0);
  const [testsThisMonth, setTestsThisMonth] = useState(0);
  const [suspiciousActivity, setSuspiciousActivity] = useState<SuspiciousActivityRow[]>([]);
  const [myAdminClasses, setMyAdminClasses] = useState<ClassAdminEntry[]>([]);
  const [readyPackAlerts, setReadyPackAlerts] = useState<ReadyPackAlert[]>([]);
  // Classes where the lockout has expired (or never started) — eligible to generate a new pack
  const [eligibleRecoveryClasses, setEligibleRecoveryClasses] = useState<ClassAdminEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;

    const token = getToken();
    if (!token) {
      setLoading(false);
      return;
    }

    async function fetchDashboard() {
      try {
        let schoolId = user?.school_id ?? null;
        if (!schoolId) {
          try {
            const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            }).then(r => r.json());
            schoolId = meRes?.data?.school_id ?? null;
          } catch { /* ignore */ }
        }

        if (!schoolId) {
          setLoading(false);
          return;
        }

        const [classesRes, complaintsRes, testsRes, suspiciousRes, adminClassesRes, readyPacksRes] = await Promise.all([
          fetch(`${BASE_URL}/api/teacher/my-classes`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          }).then((r) => r.json()).catch(() => ({ data: [] })),
          complaintsApi.list(token!, { status: 'pending', role: user!.role }).catch(() => ({ data: [] })),
          testsApi.list(token!).catch(() => ({ data: [] })),
          testsApi.getSuspiciousActivity(token!).catch(() => ({ data: [] })),
          fetch(`${BASE_URL}/api/class-admin/my-classes`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          }).then((r) => r.json()).catch(() => ({ data: [] })),
          fetch(`${BASE_URL}/api/recovery/ready-packs`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          }).then((r) => r.json()).catch(() => ({ data: [] })),
        ]);

        const myAssignments: TeacherAssignment[] = classesRes?.data ?? [];
        setAssignments(myAssignments);

        let uniqueStudents: Student[] = [];

        const classKeys = [
          ...new Map(
            myAssignments.map((a) => {
              const cn = (a.class_name ?? (a as unknown as Record<string, string>).class) as string;
              return [`${cn}||${a.section}`, { ...a, class_name: cn }];
            })
          ).values(),
        ];

        if (classKeys.length > 0) {
          const studentResults = await Promise.all(
            classKeys.map((a) =>
              fetch(
                `${BASE_URL}/api/teacher/students?class=${encodeURIComponent(a.class_name)}&section=${encodeURIComponent(a.section)}`,
                { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
              ).then((r) => r.json())
            )
          );

          const allStudents: Student[] = studentResults.flatMap((r) => r?.data ?? []);
          uniqueStudents = [...new Map(allStudents.map((s) => [s.id, s])).values()];
        }

        const adminClasses: ClassAdminEntry[] = Array.isArray(adminClassesRes.data) ? adminClassesRes.data : [];

        setStudents(uniqueStudents);
        setPendingComplaints(complaintsRes.data.length);
        setTestsThisMonth((testsRes.data ?? []).length);
        setSuspiciousActivity(Array.isArray(suspiciousRes.data) ? suspiciousRes.data : []);
        setMyAdminClasses(adminClasses);
        setReadyPackAlerts(Array.isArray(readyPacksRes.data) ? readyPacksRes.data : []);

        // For each class where this teacher is admin, check if recovery pack generation is available
        if (adminClasses.length > 0) {
          const cycleStatuses = await Promise.all(
            adminClasses.map((ac) =>
              fetch(
                `${BASE_URL}/api/recovery/cycle-status?class=${encodeURIComponent(ac.class_name)}&section=${encodeURIComponent(ac.section)}`,
                { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
              )
                .then((r) => r.json())
                .catch(() => null)
            )
          );

          const eligible = adminClasses.filter((ac, i) => {
            const result = cycleStatuses[i] as { data?: { is_locked?: boolean; cycle?: unknown } } | null;
            // Eligible if: API failed (null), no cycle ever ran (cycle is null), or lockout expired
            if (!result?.data) return true;
            return result.data.is_locked === false;
          });

          setEligibleRecoveryClasses(eligible);
        }
      } catch (err) {
        console.error('[TeacherDashboard] fetch error:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchDashboard();
  }, [user, authLoading]);

  const uniqueClasses = [...new Set(assignments.map((a) => {
    const cn = a.class_name ?? (a as unknown as Record<string, string>).class;
    return `${cn} ${a.section}`;
  }))];

  // Build a Set of "class_name||section" for O(1) lookup
  const adminClassKeys = new Set(myAdminClasses.map((c) => `${c.class_name}||${c.section}`));
  const isAdminOf = (className: string, section: string) =>
    adminClassKeys.has(`${className}||${section}`);

  // Classes where THIS teacher is the admin (deduplicated from assignments)
  const adminAssignments = myAdminClasses; // already scoped to current teacher by the API
  function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m === 0) return `${s}s`;
    return `${m}m ${s}s`;
  }

  return (
    <>
      <PageHeader
        title={user?.name ? `Welcome back, ${user.name}` : 'Welcome back'}
        description="Your classes and student overview"
      />

      {/* Recovery Pack Ready alerts — shown when a cycle has pack_ready status */}
      {!loading && readyPackAlerts.length > 0 && readyPackAlerts.map((alert) => (
        <div
          key={`${alert.class_name}||${alert.section}`}
          className="bg-purple-50 border border-purple-200 rounded-xl px-6 py-4 mb-4 flex items-center justify-between gap-4"
        >
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-purple-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-sm font-semibold text-purple-800">Recovery Pack Ready — {alert.class_name} · {alert.section}</p>
              <p className="text-xs text-purple-700 mt-0.5">
                Packs are ready for {alert.student_count} student{alert.student_count !== 1 ? 's' : ''}. Generate recovery tests now.
              </p>
            </div>
          </div>
          <Link
            href={`/teacher/recovery-schedule?class=${encodeURIComponent(alert.class_name)}&section=${encodeURIComponent(alert.section)}`}
            className="shrink-0 px-4 py-2 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors whitespace-nowrap"
          >
            View Recovery →
          </Link>
        </div>
      ))}

      {/* Recovery pack available — shown to class admins whose lockout has expired */}
      {!loading && eligibleRecoveryClasses.length > 0 && (
        <div className="bg-green-50 border border-green-200 rounded-xl px-6 py-4 mb-6">
          <div className="flex items-center gap-3 mb-3">
            <svg className="w-5 h-5 text-green-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm font-semibold text-green-800">
              Recovery Pack Available — {eligibleRecoveryClasses.length} class{eligibleRecoveryClasses.length !== 1 ? 'es' : ''} ready to generate
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {eligibleRecoveryClasses.map((ac) => (
              <Link
                key={`${ac.class_name}||${ac.section}`}
                href={`/teacher/recovery-schedule?class=${encodeURIComponent(ac.class_name)}&section=${encodeURIComponent(ac.section)}`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
              >
                {ac.class_name} · {ac.section}
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">        <StatCard label="My Students" value={loading ? '—' : students.length}
          sub="Across your classes" icon={<StudentsIcon />} />
        <StatCard label="Classes Assigned" value={loading ? '—' : uniqueClasses.length}
          sub="Class + section pairs" icon={<ClassIcon />} />
        <StatCard label="Pending Complaints" value={loading ? '—' : pendingComplaints}
          sub="Awaiting review" icon={<ComplaintIcon />} />
        <StatCard label="Tests Created" value={loading ? '—' : testsThisMonth}
          sub="Created by you" icon={<TestIcon />} />
      </div>

      {/* No assignments notice */}
      {!loading && assignments.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-6 py-5 mb-6 flex items-start gap-3">
          <svg className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div>
            <p className="text-sm font-medium text-amber-800">No classes assigned yet</p>
            <p className="text-xs text-amber-700 mt-0.5">
              Your school admin needs to assign you to a class before you can mark attendance, enter marks, or see students.
              Contact your administrator.
            </p>
          </div>
        </div>
      )}

      {/* Assigned classes */}
      {!loading && assignments.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 mb-6">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900">My Assignments</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {assignments.map((a) => {
              const cn = a.class_name ?? (a as unknown as Record<string, string>).class;
              return (
                <div key={a.id} className="flex items-center justify-between px-6 py-3">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{cn} · {a.section}</p>
                    <p className="text-xs text-gray-400">{a.subject}</p>
                  </div>
                  <span className="text-xs text-gray-500">
                    {students.filter((s) => s.class_name === cn && (s.section ?? '') === a.section).length} students
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Quick actions */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-sm font-semibold text-gray-900 mb-4">Quick Actions</h2>        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { href: '/teacher/marks', label: 'Enter Marks' },
            { href: '/teacher/attendance', label: 'Mark Attendance' },
            { href: '/teacher/fees', label: 'Fee Status' },
            { href: '/teacher/tests', label: 'Create Test' },
            { href: '/teacher/complaints', label: 'View Complaints' },
          ].map((a) => (
            <Link key={a.href} href={a.href}
              className="flex items-center justify-between px-4 py-3 rounded-lg border border-gray-200 hover:border-blue-300 hover:bg-blue-50 text-sm font-medium text-gray-700 hover:text-blue-700 transition-colors">
              {a.label}
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          ))}
        </div>
      </div>

      {/* ── Suspicious Activity Panel ──────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 mt-6">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <span>⚠</span> Suspicious Test Activity
          </h2>
          <span className="text-xs text-gray-400">Last 30 days</span>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <div className="w-5 h-5 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : suspiciousActivity.length === 0 ? (
          <p className="text-center py-8 text-sm text-gray-400">No suspicious activity in the last 30 days</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase">Student</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Test</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Date</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Exits</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Time Outside</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Integrity</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Reasons</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {suspiciousActivity.map((row) => (
                  <tr key={row.id} className="hover:bg-red-50 transition-colors">
                    <td className="px-6 py-3 font-medium text-gray-900">{row.student_name}</td>
                    <td className="px-4 py-3 text-gray-700">
                      <span className="font-medium">{row.test_title ?? '—'}</span>
                      {row.subject && <span className="text-gray-400 text-xs ml-1">· {row.subject}</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {row.test_date ? new Date(row.test_date).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-700 font-semibold">{row.exit_count}</td>
                    <td className="px-4 py-3 text-gray-600 text-xs">{formatDuration(row.total_exit_duration_seconds)}</td>
                    <td className="px-4 py-3 text-gray-700 font-semibold">{row.integrity_score ?? '—'}</td>
                    <td className="px-4 py-3 text-red-600 text-xs max-w-xs truncate">
                      {row.suspicious_reasons && row.suspicious_reasons.length > 0
                        ? row.suspicious_reasons.join(', ')
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {row.test_id && (
                        <Link
                          href={`/teacher/tests?submissionsFor=${row.test_id}`}
                          className="px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                        >
                          View Results
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function StudentsIcon() {
  return <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>;
}
function ClassIcon() {
  return <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>;
}
function ComplaintIcon() {
  return <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>;
}
function TestIcon() {
  return <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>;
}
