'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { feesApi, settingsApi, type FeeRecord } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface MyClass {
  class_name: string;
  section: string;
  subject: string;
}

// ── Update Payment Modal ──────────────────────────────────────────────────────

interface UpdatePaymentModalProps {
  record: FeeRecord;
  term: string;
  academicYear: string;
  onClose: () => void;
  onSaved: () => void;
}

function UpdatePaymentModal({ record, term, academicYear, onClose, onSaved }: UpdatePaymentModalProps) {
  const [totalFee, setTotalFee] = useState(
    record.total_fee_amount !== null ? String(record.total_fee_amount) : ''
  );
  const [amountPaid, setAmountPaid] = useState(String(record.amount_paid ?? 0));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    const total = parseFloat(totalFee);
    const paid = parseFloat(amountPaid);

    if (isNaN(total) || total < 0) {
      setError('Total fee amount must be a valid non-negative number.');
      return;
    }
    if (isNaN(paid) || paid < 0) {
      setError('Amount paid must be a valid non-negative number.');
      return;
    }
    if (paid > total) {
      setError('Amount paid cannot exceed total fee amount.');
      return;
    }

    const token = getToken();
    if (!token) return;
    setSaving(true);
    setError('');
    try {
      await feesApi.updatePayment(token, record.student_id, {
        term,
        academic_year: academicYear,
        total_fee_amount: total,
        amount_paid: paid,
      });
      onSaved();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to update payment');
    } finally {
      setSaving(false);
    }
  }

  const remaining =
    totalFee !== '' && amountPaid !== ''
      ? Math.max(0, parseFloat(totalFee || '0') - parseFloat(amountPaid || '0'))
      : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-900">Update Payment</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex items-center gap-3 mb-5 p-3 bg-gray-50 rounded-lg">
          <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 text-sm font-semibold shrink-0">
            {record.full_name.charAt(0).toUpperCase()}
          </div>
          <div>
            <p className="text-sm font-medium text-gray-900">{record.full_name}</p>
            <p className="text-xs text-gray-500">{record.class_name} · {record.section}</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Total Fee Amount <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              min={0}
              step={0.01}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g. 5000"
              value={totalFee}
              onChange={(e) => setTotalFee(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Amount Paid <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              min={0}
              step={0.01}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g. 2500"
              value={amountPaid}
              onChange={(e) => setAmountPaid(e.target.value)}
            />
          </div>

          {remaining !== null && (
            <div className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg text-sm">
              <span className="text-gray-500">Remaining Balance</span>
              <span className={`font-semibold ${remaining > 0 ? 'text-red-600' : 'text-green-600'}`}>
                {remaining.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          )}

          {error && (
            <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
              {error}
            </div>
          )}
        </div>

        <div className="flex gap-3 mt-5">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors"
          >
            {saving ? 'Saving…' : 'Save Payment'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: 'paid' | 'partial' | 'unpaid' }) {
  if (status === 'paid') {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
        Paid
      </span>
    );
  }
  if (status === 'partial') {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">
        Partial
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-600">
      Unpaid
    </span>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FeesPage() {
  const { user } = useAuth();

  // Classes loaded from /api/teacher/my-classes (same source as marks/attendance)
  const [myClasses, setMyClasses] = useState<MyClass[]>([]);
  const [loadingClasses, setLoadingClasses] = useState(true);

  const [feeRecords, setFeeRecords] = useState<FeeRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Filters
  const [filterClass, setFilterClass] = useState('');
  const [filterSection, setFilterSection] = useState('');
  const [term, setTerm] = useState('');
  const [academicYear, setAcademicYear] = useState('');

  // Update payment modal
  const [editingRecord, setEditingRecord] = useState<FeeRecord | null>(null);

  // ── Load teacher's classes from my-classes endpoint ───────────────────────
  useEffect(() => {
    const token = getToken();
    if (!token || !user) return;

    Promise.all([
      fetch(`${BASE_URL}/api/teacher/my-classes`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      }).then((r) => r.json()).catch(() => ({ data: [] })),
      settingsApi.get(token).catch(() => ({ data: { term_name: '', academic_year: '' } })),
    ]).then(([classesRes, settingsRes]) => {
      setMyClasses(classesRes.data ?? []);
      setTerm(settingsRes.data?.term_name ?? '');
      setAcademicYear(settingsRes.data?.academic_year ?? '');
    }).finally(() => setLoadingClasses(false));
  }, [user]);

  // Derived dropdowns
  const uniqueClasses = [...new Set(myClasses.map((c) => c.class_name))].sort();
  const sectionsForClass = [...new Set(
    myClasses.filter((c) => c.class_name === filterClass).map((c) => c.section)
  )].sort();

  // ── Fetch fee records ─────────────────────────────────────────────────────
  const fetchFees = useCallback(async () => {
    if (!filterClass || !filterSection) return;
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const res = await feesApi.list(token, {
        class_name: filterClass,
        section: filterSection,
        term: term || undefined,
        academic_year: academicYear || undefined,
      });
      setFeeRecords(res.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load fee records');
    } finally {
      setLoading(false);
    }
  }, [filterClass, filterSection, term, academicYear]);

  useEffect(() => { fetchFees(); }, [fetchFees]);

  // ── Summary counts ────────────────────────────────────────────────────────
  const paidCount = feeRecords.filter((r) => (r.payment_status ?? (r.fee_paid ? 'paid' : 'unpaid')) === 'paid').length;
  const partialCount = feeRecords.filter((r) => (r.payment_status ?? '') === 'partial').length;
  const unpaidCount = feeRecords.filter((r) => (r.payment_status ?? (r.fee_paid ? 'paid' : 'unpaid')) === 'unpaid').length;

  return (
    <>
      <PageHeader title="Fee Management" description="Track and update student fee payment status" />

      {/* ── Filters ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-3 mb-4">
        <select
          className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          value={filterClass}
          onChange={(e) => { setFilterClass(e.target.value); setFilterSection(''); setFeeRecords([]); }}
          disabled={loadingClasses}
        >
          <option value="">{loadingClasses ? 'Loading…' : 'Select class…'}</option>
          {uniqueClasses.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        <select
          className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          value={filterSection}
          onChange={(e) => { setFilterSection(e.target.value); setFeeRecords([]); }}
          disabled={!filterClass}
        >
          <option value="">Select section…</option>
          {sectionsForClass.map((s) => <option key={s} value={s}>{s}</option>)}
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

      {/* ── Feedback ─────────────────────────────────────────────────────── */}
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

      {/* ── Summary chips ─────────────────────────────────────────────────── */}
      {feeRecords.length > 0 && (
        <div className="flex items-center gap-3 mb-4">
          <span className="px-3 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-full">
            {paidCount} paid
          </span>
          {partialCount > 0 && (
            <span className="px-3 py-1 bg-yellow-100 text-yellow-700 text-xs font-medium rounded-full">
              {partialCount} partial
            </span>
          )}
          <span className="px-3 py-1 bg-red-100 text-red-600 text-xs font-medium rounded-full">
            {unpaidCount} unpaid
          </span>
          <span className="text-xs text-gray-400">{feeRecords.length} total</span>
        </div>
      )}

      {/* ── Table ────────────────────────────────────────────────────────── */}
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
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Student Name
                  </th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Total Fee
                  </th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Amount Paid
                  </th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Remaining
                  </th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Status
                  </th>
                  <th className="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {feeRecords.map((r) => {
                  const total = (r.total_fee_amount != null && !isNaN(Number(r.total_fee_amount)))
                    ? Number(r.total_fee_amount)
                    : null;
                  const paid = (r.amount_paid != null && !isNaN(Number(r.amount_paid)))
                    ? Number(r.amount_paid)
                    : 0;
                  const remaining = total !== null ? Math.max(0, total - paid) : null;
                  const status = r.payment_status ?? (r.fee_paid ? 'paid' : 'unpaid');

                  return (
                    <tr key={r.student_id} className="hover:bg-gray-50 transition-colors">
                      {/* Student name */}
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 text-xs font-semibold shrink-0">
                            {r.full_name.charAt(0).toUpperCase()}
                          </div>
                          <span className="font-medium text-gray-900">{r.full_name}</span>
                        </div>
                      </td>

                      {/* Total fee */}
                      <td className="px-4 py-3 text-right text-gray-700">
                        {total !== null
                          ? total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                          : <span className="text-gray-400">—</span>}
                      </td>

                      {/* Amount paid */}
                      <td className="px-4 py-3 text-right text-gray-700">
                        {paid > 0
                          ? paid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                          : <span className="text-gray-400">0.00</span>}
                      </td>

                      {/* Remaining balance */}
                      <td className="px-4 py-3 text-right">
                        {remaining !== null ? (
                          <span className={remaining > 0 ? 'text-red-600 font-medium' : 'text-green-600 font-medium'}>
                            {remaining.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3 text-center">
                        <StatusBadge status={status as 'paid' | 'partial' | 'unpaid'} />
                      </td>

                      {/* Action */}
                      <td className="px-6 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setEditingRecord(r)}
                          className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors"
                        >
                          Update Payment
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Update Payment Modal ──────────────────────────────────────────── */}
      {editingRecord && (
        <UpdatePaymentModal
          record={editingRecord}
          term={term}
          academicYear={academicYear}
          onClose={() => setEditingRecord(null)}
          onSaved={async () => {
            setEditingRecord(null);
            setSuccess('Payment updated successfully.');
            await fetchFees();
            setTimeout(() => setSuccess(''), 4000);
          }}
        />
      )}
    </>
  );
}
