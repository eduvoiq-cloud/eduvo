'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { feesApi, settingsApi, type FeeRecord } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

interface MyClass {
  class_name: string;
  section: string;
  subject: string;
}

interface FeeReminderPreview {
  student_id: string;
  student_name: string;
  total_fee_amount: number;
  amount_paid: number;
  remaining_balance: number;
  message: string;
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
      // Prefer the term/year from the existing fee record to ensure we update
      // the correct row and don't collide with the unique constraint.
      const effectiveTerm = record.fee_record?.term ?? term;
      const effectiveYear = record.fee_record?.academic_year ?? academicYear;
      await feesApi.updatePayment(token, record.student_id, {
        ...(effectiveTerm ? { term: effectiveTerm } : {}),
        ...(effectiveYear ? { academic_year: effectiveYear } : {}),
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
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
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
              type="number" min={0} step={0.01}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g. 12000"
              value={totalFee}
              onChange={(e) => setTotalFee(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Amount Paid <span className="text-red-500">*</span>
            </label>
            <input
              type="number" min={0} step={0.01}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g. 6000"
              value={amountPaid}
              onChange={(e) => setAmountPaid(e.target.value)}
            />
          </div>

          {remaining !== null && (
            <div className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg text-sm">
              <span className="text-gray-500">Remaining Balance</span>
              <span className={`font-semibold ${remaining > 0 ? 'text-red-600' : 'text-green-600'}`}>
                ₹{remaining.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          )}

          {error && (
            <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{error}</div>
          )}
        </div>

        <div className="flex gap-3 mt-5">
          <button type="button" onClick={onClose}
            className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            Cancel
          </button>
          <button type="button" onClick={handleSave} disabled={saving}
            className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors">
            {saving ? 'Saving…' : 'Save Payment'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Bulk Class Fee Modal ───────────────────────────────────────────────────────

interface BulkFeeModalProps {
  className: string;
  section: string;
  studentCount: number;
  term: string;
  academicYear: string;
  onClose: () => void;
  onSaved: () => void;
}

function BulkFeeModal({ className, section, studentCount, term, academicYear, onClose, onSaved }: BulkFeeModalProps) {
  const [amount, setAmount] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function handleContinue() {
    const val = parseFloat(amount);
    if (isNaN(val) || val < 0) {
      setError('Please enter a valid amount.');
      return;
    }
    setError('');
    setConfirming(true);
  }

  async function handleConfirm() {
    const token = getToken();
    if (!token) return;
    setSaving(true);
    setError('');
    try {
      await fetch(`${BASE_URL}/api/fees/class-bulk`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          class_name: className,
          section,
          total_fee_amount: parseFloat(amount),
          ...(term ? { term } : {}),
          ...(academicYear ? { academic_year: academicYear } : {}),
        }),
      }).then(async (r) => {
        if (!r.ok) {
          const json = await r.json();
          throw new Error(json.message ?? 'Failed to set fees');
        }
      });
      onSaved();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to set fees');
      setConfirming(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-900">Set Class Fee</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {!confirming ? (
          <>
            <p className="text-sm text-gray-600 mb-4">
              Enter the total fee amount to apply to all students in{' '}
              <span className="font-semibold">{className} {section}</span>.
              Individual amounts can still be overridden per student.
            </p>
            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Total Fee Amount (₹) <span className="text-red-500">*</span>
              </label>
              <input
                type="number" min={0} step={1} autoFocus
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="e.g. 12000"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleContinue()}
              />
            </div>
            {error && <p className="text-xs text-red-600 mb-3">{error}</p>}
            <div className="flex gap-3">
              <button type="button" onClick={onClose}
                className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
                Cancel
              </button>
              <button type="button" onClick={handleContinue}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors">
                Continue
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg mb-4">
              <p className="text-sm text-amber-800 font-medium mb-1">⚠️ Please confirm</p>
              <p className="text-sm text-amber-700">
                This will set total fees to{' '}
                <span className="font-bold">₹{parseFloat(amount).toLocaleString('en-IN')}</span>{' '}
                for all <span className="font-bold">{studentCount}</span> students in{' '}
                <span className="font-bold">{className} {section}</span>.
                {term && <> Term: <span className="font-semibold">{term}</span>.</>}
              </p>
            </div>
            {error && <p className="text-xs text-red-600 mb-3">{error}</p>}
            <div className="flex gap-3">
              <button type="button" onClick={() => setConfirming(false)}
                className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
                Back
              </button>
              <button type="button" onClick={handleConfirm} disabled={saving}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors">
                {saving ? 'Applying…' : 'Apply to All'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Fee Reminder Modal ────────────────────────────────────────────────────────

interface FeeReminderModalProps {
  className: string;
  section: string;
  term: string;
  academicYear: string;
  onClose: () => void;
}

function FeeReminderModal({ className, section, term, academicYear, onClose }: FeeReminderModalProps) {
  const [customNote, setCustomNote] = useState('');
  const [previews, setPreviews] = useState<FeeReminderPreview[] | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  async function loadPreview() {
    const token = getToken();
    if (!token) return;
    setLoadingPreview(true);
    setError('');
    try {
      const res = await fetch(`${BASE_URL}/api/fees/preview-reminder`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          class_name: className,
          section,
          custom_note: customNote || undefined,
          ...(term ? { term } : {}),
          ...(academicYear ? { academic_year: academicYear } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to load preview');
      setPreviews(json.data ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load preview');
    } finally {
      setLoadingPreview(false);
    }
  }

  async function handleSend() {
    const token = getToken();
    if (!token) return;
    setSending(true);
    setError('');
    try {
      const res = await fetch(`${BASE_URL}/api/fees/send-reminder`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          class_name: className,
          section,
          custom_note: customNote || undefined,
          ...(term ? { term } : {}),
          ...(academicYear ? { academic_year: academicYear } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to send reminders');
      setSuccess(`Fee reminders sent to ${json.data?.sent ?? 0} student(s).`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to send reminders');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Send Fee Reminder</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <p className="text-sm text-gray-600">
            Sending to <span className="font-semibold">{className} {section}</span>. Each student will receive a personalised message with their fee details.
          </p>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Custom Note <span className="text-gray-400">(optional)</span>
            </label>
            <textarea
              rows={2}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              placeholder="e.g. Please visit the accounts office by Friday."
              value={customNote}
              onChange={(e) => setCustomNote(e.target.value)}
            />
          </div>

          <button type="button" onClick={loadPreview} disabled={loadingPreview}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 disabled:opacity-50 rounded-lg transition-colors">
            {loadingPreview ? (
              <span className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            )}
            Preview Messages
          </button>

          {previews && previews.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Preview ({previews.length} messages)</p>
              <div className="max-h-48 overflow-y-auto space-y-2 border border-gray-100 rounded-lg p-3 bg-gray-50">
                {previews.slice(0, 5).map((p) => (
                  <div key={p.student_id} className="bg-white rounded-lg p-3 border border-gray-200">
                    <p className="text-xs font-semibold text-gray-700 mb-1">{p.student_name}</p>
                    <p className="text-xs text-gray-600 leading-relaxed">{p.message}</p>
                  </div>
                ))}
                {previews.length > 5 && (
                  <p className="text-xs text-gray-400 text-center py-1">+{previews.length - 5} more students</p>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{error}</div>
          )}

          {success && (
            <div className="px-3 py-2 bg-green-50 border border-green-200 rounded-lg text-xs text-green-700">✓ {success}</div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4 border-t border-gray-100">
          <button type="button" onClick={onClose}
            className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            {success ? 'Close' : 'Cancel'}
          </button>
          {!success && (
            <button type="button" onClick={handleSend} disabled={sending}
              className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors">
              {sending ? 'Sending…' : 'Send Reminders'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: 'paid' | 'partial' | 'unpaid' }) {
  if (status === 'paid') {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
        🟢 Paid
      </span>
    );
  }
  if (status === 'partial') {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">
        🟡 Partial
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-600">
      🔴 Unpaid
    </span>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FeesPage() {
  const { user } = useAuth();

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

  // Modals
  const [editingRecord, setEditingRecord] = useState<FeeRecord | null>(null);
  const [showBulkFee, setShowBulkFee] = useState(false);
  const [showReminderModal, setShowReminderModal] = useState(false);

  // ── Load teacher's classes ────────────────────────────────────────────────

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
      const feeData: FeeRecord[] = (res.data as unknown as {data: FeeRecord[]}).data
        ?? res.data as unknown as FeeRecord[]
        ?? [];
      setFeeRecords(feeData);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load fee records');
    } finally {
      setLoading(false);
    }
  }, [filterClass, filterSection, term, academicYear]);

  useEffect(() => { fetchFees(); }, [fetchFees]);

  // ── Summary counts ────────────────────────────────────────────────────────

  const paidCount    = feeRecords.filter((r) => (r.payment_status ?? (r.fee_paid ? 'paid' : 'unpaid')) === 'paid').length;
  const partialCount = feeRecords.filter((r) => (r.payment_status ?? '') === 'partial').length;
  const unpaidCount  = feeRecords.filter((r) => (r.payment_status ?? (r.fee_paid ? 'paid' : 'unpaid')) === 'unpaid').length;

  return (
    <>
      <PageHeader
        title="Fee Management"
        description="Track and update student fee payment status"
        action={
          filterClass && filterSection ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowBulkFee(true)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-green-700 bg-green-50 hover:bg-green-100 border border-green-200 rounded-lg transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 11h.01M12 11h.01M15 11h.01M4 19h16a2 2 0 002-2V7a2 2 0 00-2-2H4a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                Set Class Fee
              </button>
              <button
                type="button"
                onClick={() => setShowReminderModal(true)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                Send Fee Reminder
              </button>
            </div>
          ) : undefined
        }
      />

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
            🟢 {paidCount} paid
          </span>
          {partialCount > 0 && (
            <span className="px-3 py-1 bg-yellow-100 text-yellow-700 text-xs font-medium rounded-full">
              🟡 {partialCount} partial
            </span>
          )}
          <span className="px-3 py-1 bg-red-100 text-red-600 text-xs font-medium rounded-full">
            🔴 {unpaidCount} unpaid
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
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Student Name</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Total Fee</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Amount Paid</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Remaining</th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                  <th className="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {feeRecords.map((r) => {
                  const total = (r.total_fee_amount != null && !isNaN(Number(r.total_fee_amount)))
                    ? Number(r.total_fee_amount) : null;
                  const paid = (r.amount_paid != null && !isNaN(Number(r.amount_paid)))
                    ? Number(r.amount_paid) : 0;
                  const remaining = total !== null ? Math.max(0, total - paid) : null;
                  const status = r.payment_status ?? (r.fee_paid ? 'paid' : 'unpaid');

                  return (
                    <tr key={r.student_id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 text-xs font-semibold shrink-0">
                            {r.full_name.charAt(0).toUpperCase()}
                          </div>
                          <span className="font-medium text-gray-900">{r.full_name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700">
                        {total !== null
                          ? `₹${total.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                          : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700">
                        {paid > 0
                          ? `₹${paid.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                          : <span className="text-gray-400">₹0.00</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {remaining !== null ? (
                          <span className={remaining > 0 ? 'text-red-600 font-medium' : 'text-green-600 font-medium'}>
                            ₹{remaining.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <StatusBadge status={status as 'paid' | 'partial' | 'unpaid'} />
                      </td>
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

      {/* ── Modals ───────────────────────────────────────────────────────── */}
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

      {showBulkFee && filterClass && filterSection && (
        <BulkFeeModal
          className={filterClass}
          section={filterSection}
          studentCount={feeRecords.length}
          term={term}
          academicYear={academicYear}
          onClose={() => setShowBulkFee(false)}
          onSaved={async () => {
            setShowBulkFee(false);
            setSuccess(`Total fees applied to all students in ${filterClass} ${filterSection}.`);
            await fetchFees();
            setTimeout(() => setSuccess(''), 5000);
          }}
        />
      )}

      {showReminderModal && filterClass && filterSection && (
        <FeeReminderModal
          className={filterClass}
          section={filterSection}
          term={term}
          academicYear={academicYear}
          onClose={() => setShowReminderModal(false)}
        />
      )}
    </>
  );
}
