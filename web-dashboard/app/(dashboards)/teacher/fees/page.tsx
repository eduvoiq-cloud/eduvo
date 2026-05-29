'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { assignmentsApi, feesApi, settingsApi, type TeacherAssignment, type FeeRecord } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

export default function FeesPage() {
  const { user } = useAuth();
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([]);
  const [feeRecords, setFeeRecords] = useState<FeeRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingAssignments, setLoadingAssignments] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Filters
  const [filterClass, setFilterClass] = useState('');
  const [filterSection, setFilterSection] = useState('');
  const [term, setTerm] = useState('');
  const [academicYear, setAcademicYear] = useState('');

  // Load assignments + settings defaults
  useEffect(() => {
    const token = getToken();
    if (!token || !user?.school_id) return;
    Promise.all([
      assignmentsApi.list(token, user.school_id),
      settingsApi.get(token),
    ])
      .then(([aRes, sRes]) => {
        setAssignments(aRes.data.filter((a) => a.teacher_id === user.id));
        setTerm(sRes.data.term_name ?? '');
        setAcademicYear(sRes.data.academic_year ?? '');
      })
      .catch(() => {})
      .finally(() => setLoadingAssignments(false));
  }, [user]);

  const fetchFees = useCallback(async () => {
    if (!filterClass || !filterSection || !term || !academicYear) return;
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const res = await feesApi.list(token, {
        class_name: filterClass,
        section: filterSection,
        term,
        academic_year: academicYear,
      });
      setFeeRecords(res.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load fee records');
    } finally {
      setLoading(false);
    }
  }, [filterClass, filterSection, term, academicYear]);

  useEffect(() => { fetchFees(); }, [fetchFees]);

  async function handleToggle(studentId: string, currentPaid: boolean) {
    if (!term || !academicYear) {
      setError('Term and academic year are required before toggling fee status.');
      return;
    }
    const token = getToken();
    if (!token) return;
    setToggling(studentId);
    setError(''); setSuccess('');
    try {
      await feesApi.toggle(token, studentId, {
        fee_paid: !currentPaid,
        term,
        academic_year: academicYear,
      });
      setSuccess(`Fee status updated.`);
      await fetchFees();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to update fee status');
    } finally {
      setToggling(null);
    }
  }

  const myClasses = [...new Set(assignments.map((a) => a.class_name))];
  const mySections = [...new Set(assignments.filter((a) => a.class_name === filterClass).map((a) => a.section))];
  const paidCount = feeRecords.filter((r) => r.fee_paid).length;
  const unpaidCount = feeRecords.length - paidCount;

  return (
    <>
      <PageHeader title="Fee Management" description="Track and update student fee payment status" />

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <select
          className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          value={filterClass}
          onChange={(e) => { setFilterClass(e.target.value); setFilterSection(''); setFeeRecords([]); }}
          disabled={loadingAssignments}
        >
          <option value="">Select class…</option>
          {myClasses.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        <select
          className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          value={filterSection}
          onChange={(e) => { setFilterSection(e.target.value); setFeeRecords([]); }}
          disabled={!filterClass}
        >
          <option value="">Select section…</option>
          {mySections.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        <input
          type="text"
          placeholder="Term (e.g. Term 1)"
          className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 w-36"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />

        <input
          type="text"
          placeholder="Year (e.g. 2024/2025)"
          className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 w-36"
          value={academicYear}
          onChange={(e) => setAcademicYear(e.target.value)}
        />
      </div>

      {/* Feedback */}
      {success && (
        <div className="mb-4 px-4 py-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700 flex items-center gap-2">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {success}
        </div>
      )}
      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      {/* Summary chips */}
      {feeRecords.length > 0 && (
        <div className="flex items-center gap-3 mb-4">
          <span className="px-3 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-full">
            {paidCount} paid
          </span>
          <span className="px-3 py-1 bg-red-100 text-red-600 text-xs font-medium rounded-full">
            {unpaidCount} unpaid
          </span>
          <span className="text-xs text-gray-400">{feeRecords.length} total</span>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {!filterClass || !filterSection ? (
          <div className="text-center py-16 text-sm text-gray-400">
            Select a class and section to view fee records.
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : feeRecords.length === 0 ? (
          <div className="text-center py-16 text-sm text-gray-400">
            No students found for {filterClass} · {filterSection}.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Student</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Class</th>
                  <th className="text-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                  <th className="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {feeRecords.map((r) => (
                  <tr key={r.student_id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 text-xs font-semibold">
                          {r.full_name.charAt(0).toUpperCase()}
                        </div>
                        <span className="font-medium text-gray-900">{r.full_name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-3 text-gray-600">
                      {r.class_name}{r.section ? ` · ${r.section}` : ''}
                    </td>
                    <td className="px-6 py-3 text-center">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        r.fee_paid ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
                      }`}>
                        {r.fee_paid ? 'Paid' : 'Unpaid'}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-right">
                      <button
                        onClick={() => handleToggle(r.student_id, r.fee_paid)}
                        disabled={toggling === r.student_id}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors disabled:opacity-50 ${
                          r.fee_paid
                            ? 'text-red-600 bg-red-50 hover:bg-red-100'
                            : 'text-green-700 bg-green-50 hover:bg-green-100'
                        }`}
                      >
                        {toggling === r.student_id
                          ? '…'
                          : r.fee_paid ? 'Mark Unpaid' : 'Mark Paid'}
                      </button>
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
