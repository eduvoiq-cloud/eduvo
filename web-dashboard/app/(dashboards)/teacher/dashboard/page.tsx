'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import { complaintsApi, testsApi, type TeacherAssignment, type Student } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import StatCard from '@/components/StatCard';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export default function TeacherDashboard() {
  const { user } = useAuth();
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [pendingComplaints, setPendingComplaints] = useState(0);
  const [testsThisMonth, setTestsThisMonth] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (!token || !user?.school_id) return;

    async function fetchDashboard() {
      try {
        // Use the teacher-specific endpoints that are properly scoped
        const [classesRes, complaintsRes, testsRes] = await Promise.all([
          fetch(`${BASE_URL}/api/teacher/my-classes`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          }).then((r) => r.json()),
          complaintsApi.list(token!, { status: 'pending', role: user!.role }),
          testsApi.list(token!),
        ]);

        const myAssignments: TeacherAssignment[] = classesRes?.data ?? [];
        setAssignments(myAssignments);

        // Fetch students for each unique class+section the teacher is assigned to
        const classKeys = [
          ...new Map(
            myAssignments.map((a) => [`${a.class_name}||${a.section}`, a])
          ).values(),
        ];

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
        const uniqueStudents = [...new Map(allStudents.map((s) => [s.id, s])).values()];
        setStudents(uniqueStudents);

        setPendingComplaints(complaintsRes.data.length);

        const now = new Date();
        const thisMonth = testsRes.data.filter((t) => {
          const d = new Date(t.created_at);
          return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
        });
        setTestsThisMonth(thisMonth.length);
      } catch (err) {
        console.error('[TeacherDashboard] fetch error:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchDashboard();
  }, [user]);

  // Students are already fetched scoped to teacher's classes — no client-side filter needed
  const uniqueClasses = [...new Set(assignments.map((a) => `${a.class_name} ${a.section}`))];

  return (
    <>
      <PageHeader
        title={`Welcome back, ${user?.name}`}
        description="Your classes and student overview"
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="My Students" value={loading ? '—' : students.length}
          sub="Across your classes" icon={<StudentsIcon />} />
        <StatCard label="Classes Assigned" value={loading ? '—' : uniqueClasses.length}
          sub="Class + section pairs" icon={<ClassIcon />} />
        <StatCard label="Pending Complaints" value={loading ? '—' : pendingComplaints}
          sub="Awaiting review" icon={<ComplaintIcon />} />
        <StatCard label="Tests This Month" value={loading ? '—' : testsThisMonth}
          sub="Created by you" icon={<TestIcon />} />
      </div>

      {/* Assigned classes */}
      {!loading && assignments.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 mb-6">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900">My Assignments</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {assignments.map((a) => (
              <div key={a.id} className="flex items-center justify-between px-6 py-3">
                <div>
                  <p className="text-sm font-medium text-gray-900">{a.class_name} · {a.section}</p>
                  <p className="text-xs text-gray-400">{a.subject}</p>
                </div>
                <span className="text-xs text-gray-500">
                  {students.filter((s) => s.class_name === a.class_name && (s.section ?? '') === a.section).length} students
                </span>
              </div>
            ))}
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
