'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import { complaintsApi, testsApi, type TeacherAssignment, type Student } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import StatCard from '@/components/StatCard';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

export default function TeacherDashboard() {
  const { user, loading: authLoading } = useAuth();
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [pendingComplaints, setPendingComplaints] = useState(0);
  const [testsThisMonth, setTestsThisMonth] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Wait for auth to finish rehydrating before fetching
    if (authLoading) return;

    const token = getToken();
    if (!token) {
      setLoading(false);
      return;
    }

    async function fetchDashboard() {
      try {
        // If school_id is missing from the cached session, fetch fresh profile first
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
          // Still no school_id — account not linked to a school
          setLoading(false);
          return;
        }
        // Fetch classes, complaints, and tests in parallel.
        // Each call is individually guarded so one failure never kills the whole dashboard.
        const [classesRes, complaintsRes, testsRes] = await Promise.all([
          fetch(`${BASE_URL}/api/teacher/my-classes`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          }).then((r) => r.json()).catch(() => ({ data: [] })),
          complaintsApi.list(token!, { status: 'pending', role: user!.role }).catch(() => ({ data: [] })),
          testsApi.list(token!).catch(() => ({ data: [] })),
        ]);

        const myAssignments: TeacherAssignment[] = classesRes?.data ?? [];
        setAssignments(myAssignments);

        // Fetch students scoped to this teacher's assigned classes.
        // If the teacher has assignments, fetch per class+section via the
        // teacher-scoped endpoint. If no assignments exist yet (e.g. newly
        // created teacher), fall back to fetching all students in the school
        // so the dashboard never shows 0 when students do exist.
        let uniqueStudents: Student[] = [];

        const classKeys = [
          ...new Map(
            myAssignments.map((a) => {
              // DB column is `class` but we normalise to `class_name` in the API response.
              // Guard against both shapes just in case.
              const cn = (a.class_name ?? (a as unknown as Record<string, string>).class) as string;
              return [`${cn}||${a.section}`, { ...a, class_name: cn }];
            })
          ).values(),
        ];

        if (classKeys.length > 0) {
          // Teacher has assignments — fetch students per assigned class/section
          const studentResults = await Promise.all(
            classKeys.map((a) =>
              fetch(
                `${BASE_URL}/api/teacher/students?class=${encodeURIComponent(a.class_name)}&section=${encodeURIComponent(a.section)}`,
                { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
              ).then((r) => r.json())
            )
          );

          const allStudents: Student[] = studentResults.flatMap((r) => r?.data ?? []);
          // Deduplicate by id in case a student appears in multiple results
          uniqueStudents = [...new Map(allStudents.map((s) => [s.id, s])).values()];
        }
        // No else fallback — if a teacher has no assignments, student count is 0.
        // The admin needs to assign classes before the teacher can see students.

        setStudents(uniqueStudents);

        setPendingComplaints(complaintsRes.data.length);

        // Count all tests created by this teacher
        setTestsThisMonth((testsRes.data ?? []).length);
      } catch (err) {
        console.error('[TeacherDashboard] fetch error:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchDashboard();
  }, [user, authLoading]);

  // Students are already fetched scoped to teacher's classes — no client-side filter needed
  const uniqueClasses = [...new Set(assignments.map((a) => {
    const cn = a.class_name ?? (a as unknown as Record<string, string>).class;
    return `${cn} ${a.section}`;
  }))];

  return (
    <>
      <PageHeader
        title={user?.name ? `Welcome back, ${user.name}` : 'Welcome back'}
        description="Your classes and student overview"
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="My Students" value={loading ? '—' : students.length}
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
        <h2 className="text-sm font-semibold text-gray-900 mb-4">Quick Actions</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
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
    </>
  );
}

function StudentsIcon() {
  return <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>;
}
function ClassIcon() {
  return <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>;
}
function SubjectIcon() {
  return <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>;
}

function ComplaintIcon() {
  return <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>;
}
function TestIcon() {
  return <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>;
}
