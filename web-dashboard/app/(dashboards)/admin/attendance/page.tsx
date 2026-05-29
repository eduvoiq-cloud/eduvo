'use client';

/**
 * Admin Attendance Overview
 * School admin can view attendance for any class/section/date.
 * Read-only — corrections are done by teachers.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { attendanceApi, studentsApi, type Student } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

interface AttendanceRow {
  student: Student;
  status: string | null;
  source: string | null;
}

const STATUS_STYLE: Record<string, string> = {
  present: 'bg-green-100 text-green-700',
  absent:  'bg-red-100 text-red-600',
  late:    'bg-orange-100 text-orange-600',
  excused: 'bg-gray-100 text-gray-600',
};

export default function AdminAttendancePage() {
  const { user } = useAuth();

  const [students, setStudents] = useState<Student[]>([]);
  const [rows, setRows] = useState<AttendanceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Filters
  const [filterClass, setFilterClass] = useState('');
  const [filterSection, setFilterSection] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));

  // Fetch all students once to build class/section dropdowns
  useEffect(() => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    studentsApi.list(token, user.school_id)
      .then((res) => setStudents(res.data))
      .catch(() => {});
  }, [user]);

  const classes = [...new Set(students.map((s) => s.class_name))].sort();
  const sections = filterClass
    ? [...new Set(students.filter((s) => s.class_name === filterClass).map((s) => s.section ?? ''))].filter(Boolean).sort()
    : [];

  const loadAttendance = useCallback(async () => {
    if (!filterClass || !filterSection || !date) return;
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const res = await attendanceApi.check(token, {
        class_name: filterClass,
        section: filterSection,
        date,
      });
      const { students: classStudents, existing } = res.data;
      const existingMap = new Map(existing.map((e) => [e.student_id, e]));
      setRows(
        classStudents.map((s) => {
          const rec = existingMap.get(s.id);
          return {
            student: s as unknown as Student,
            status: rec?.status ?? null,
            source: rec?.source ?? null,
          };
        })
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filterClass, filterSection, date]);

  useEffect(() => { loadAttendance(); }, [loadAttendance]);

  const present = rows.filter((r) => r.status === 'present').length;
  const absent  = rows.filter((r) => r.status === 'absent').length;
  const late    = rows.filter((r) => r.status === 'late').length;
  const unmarked = rows.filter((r) => !r.status).length;

  return (
    <>
      <PageHeader
        title="Attendance Overview"
        description="View daily attendance for any class"
      />

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <select
          value={filterClass}
          onChange={(e) => { setFilterClass(e.target.value); setFilterSection(''); setRows([]); }}
          className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
        >
          <option value="">Select class…</option>
          {classes.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        <select
          value={filterSection}
          onChange={(e) => { setFilterSection(e.target.value); setRows([]); }}
          disabled={!filterClass}
          className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white disabled:opacity-50"
        >
          <option value="">Select section…</option>
          {sections.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Summary chips */}
      {rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <span className="px-3 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-full">{present} present</span>
          <span className="px-3 py-1 bg-red-100 text-red-600 text-xs font-medium rounded-full">{absent} absent</span>
          {late > 0 && <span className="px-3 py-1 bg-orange-100 text-orange-600 text-xs font-medium rounded-full">{late} late</span>}
          {unmarked > 0 && <span className="px-3 py-1 bg-gray-100 text-gray-500 text-xs font-medium rounded-full">{unmarked} not marked</span>}
          <span className="text-xs text-gray-400">{rows.length} total</span>
        </div>
      )}

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {!filterClass || !filterSection ? (
          <div className="text-center py-16 text-sm text-gray-400">
            Select a class and section to view attendance.
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-16 text-sm text-gray-400">
            No students found for {filterClass} · {filterSection}.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Student</th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map(({ student, status, source }) => (
                  <tr key={student.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 text-xs font-semibold shrink-0">
                          {student.full_name.charAt(0).toUpperCase()}
                        </div>
                        <span className="font-medium text-gray-900">{student.full_name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center">
                      {status ? (
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_STYLE[status] ?? 'bg-gray-100 text-gray-600'}`}>
                          {status}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {source ? (
                        <span className={`text-xs font-medium capitalize ${source === 'rfid' ? 'text-indigo-600' : 'text-gray-500'}`}>
                          {source}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
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
