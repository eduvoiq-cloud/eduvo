'use client';

import { useEffect, useState, useCallback, Suspense } from 'react';
import { useAuth } from '@/context/AuthContext';
import { feesApi, adminApi, type FeeRecord, type PaginatedFees, type AdminStudent } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';
import FormField, { inputClass } from '@/components/FormField';

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<'paid' | 'partial' | 'unpaid', { badge: string; dot: string }> = {
  paid:    { badge: 'bg-green-100 text-green-700',  dot: 'bg-green-500'  },
  partial: { badge: 'bg-yellow-100 text-yellow-700', dot: 'bg-yellow-400' },
  unpaid:  { badge: 'bg-red-100 text-red-700',       dot: 'bg-red-400'    },
};

function fmt(n: number | null): string {
  if (n === null || n === undefined) return '—';
  return `₹${Number(n).toLocaleString('en-IN')}`;
}

function statusLabel(status: 'paid' | 'partial' | 'unpaid'): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

// ── Sub-components ─────────────────────────────────────────────────────────

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

// ── Summary stat card ────────────────────────────────────────────────────────

function FeeStatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <p className="text-sm text-gray-500 font-medium">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${color}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-gray-400">{sub}</p>}
    </div>
  );
}

// ── Inner page ────────────────────────────────────────────────────────────────

interface ClassInfo { class_name: string; section: string; }

function FeesPageInner() {
  const { user } = useAuth();
  void user;

  // List state
  const [records, setRecords] = useState<FeeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Filters
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [filterClass, setFilterClass] = useState('');
  const [filterSection, setFilterSection] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  // Payment modal
  const [payTarget, setPayTarget] = useState<FeeRecord | null>(null);
  const [payTotal, setPayTotal] = useState('');
  const [payPaid, setPayPaid] = useState('');
  const [payNotes, setPayNotes] = useState('');
  const [paySubmitting, setPaySubmitting] = useState(false);
  const [payError, setPayError] = useState('');

  // Bulk class fee modal
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkClass, setBulkClass] = useState('');
  const [bulkSection, setBulkSection] = useState('');
  const [bulkAmount, setBulkAmount] = useState('');
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkError, setBulkError] = useState('');

  // Reminder modal
  const [reminderOpen, setReminderOpen] = useState(false);
  const [reminderClass, setReminderClass] = useState('');
  const [reminderSection, setReminderSection] = useState('');
  const [reminderNote, setReminderNote] = useState('');
  const [reminderSubmitting, setReminderSubmitting] = useState(false);
  const [reminderError, setReminderError] = useState('');

  // Fetch class list for filter dropdowns
  useEffect(() => {
    const token = getToken();
    if (!token) return;
    adminApi.listStudents(token, { limit: 0 }).then((res) => {
      const students = res.data as AdminStudent[];
      const seen = new Set<string>();
      const list: ClassInfo[] = [];
      for (const s of students) {
        const key = `${s.class_name}||${s.section}`;
        if (!seen.has(key)) { seen.add(key); list.push({ class_name: s.class_name, section: s.section ?? '' }); }
      }
      list.sort((a, b) => a.class_name.localeCompare(b.class_name) || a.section.localeCompare(b.section));
      setClasses(list);
    }).catch(() => {});
  }, []);

  const fetchFees = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const res = await feesApi.list(token, {
        class_name: filterClass || undefined,
        section: filterSection || undefined,
        limit: 200,
      });
      const paged = res.data as PaginatedFees;
      const arr: FeeRecord[] = Array.isArray(paged) ? (paged as unknown as FeeRecord[]) : (paged.data ?? []);
      const filtered = filterStatus
        ? arr.filter((r) => r.payment_status === filterStatus)
        : arr;
      setRecords(filtered);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load fee records');
    } finally {
      setLoading(false);
    }
  }, [filterClass, filterSection, filterStatus]);

  useEffect(() => { fetchFees(); }, [fetchFees]);

  // ── Stats ────────────────────────────────────────────────────────────────
  const allRecords = records;
  const paidCount    = allRecords.filter((r) => r.payment_status === 'paid').length;
  const partialCount = allRecords.filter((r) => r.payment_status === 'partial').length;
  const unpaidCount  = allRecords.filter((r) => r.payment_status === 'unpaid').length;
  const totalCollected = allRecords.reduce((sum, r) => sum + (r.amount_paid ?? 0), 0);
  const totalOutstanding = allRecords.reduce((sum, r) => {
    const total = r.total_fee_amount ?? 0;
    const paid = r.amount_paid ?? 0;
    return sum + Math.max(0, total - paid);
  }, 0);

  // ── Open payment modal ────────────────────────────────────────────────────
  function openPay(record: FeeRecord) {
    setPayTarget(record);
    setPayTotal(record.fee_record?.total_fee_amount != null ? String(record.fee_record.total_fee_amount) : record.total_fee_amount != null ? String(record.total_fee_amount) : '');
    setPayPaid(record.amount_paid != null ? String(record.amount_paid) : '0');
    setPayNotes(record.fee_record?.notes ?? '');
    setPayError('');
  }

  // ── Submit payment update ─────────────────────────────────────────────────
  async function handlePaySubmit(e: React.FormEvent) {
    e.preventDefault();
    setPayError('');
    if (!payTarget) return;
    const totalNum = parseFloat(payTotal);
    const paidNum = parseFloat(payPaid);
    if (isNaN(totalNum) || totalNum < 0) { setPayError('Enter a valid total fee amount'); return; }
    if (isNaN(paidNum) || paidNum < 0) { setPayError('Enter a valid amount paid'); return; }
    if (paidNum > totalNum) { setPayError('Amount paid cannot exceed total fee'); return; }
    const token = getToken();
    if (!token) return;
    setPaySubmitting(true);
    try {
      await feesApi.updatePayment(token, payTarget.student_id, {
        total_fee_amount: totalNum,
        amount_paid: paidNum,
        notes: payNotes.trim() || undefined,
      });
      setSuccess(`Fee updated for ${payTarget.full_name}`);
      setPayTarget(null);
      await fetchFees();
    } catch (e: unknown) {
      setPayError(e instanceof Error ? e.message : 'Failed to update fee');
    } finally {
      setPaySubmitting(false);
    }
  }

  // ── Bulk set class fee ────────────────────────────────────────────────────
  async function handleBulkSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBulkError('');
    if (!bulkClass || !bulkSection) { setBulkError('Select a class and section'); return; }
    const amt = parseFloat(bulkAmount);
    if (isNaN(amt) || amt <= 0) { setBulkError('Enter a valid fee amount'); return; }
    const token = getToken();
    if (!token) return;
    setBulkSubmitting(true);
    try {
      const res = await feesApi.setBulkClassFee(token, { class_name: bulkClass, section: bulkSection, total_fee_amount: amt });
      setSuccess(`Fee set for ${(res.data as { total_students?: number }).total_students ?? 0} students in ${bulkClass} ${bulkSection}`);
      setBulkOpen(false);
      setBulkClass(''); setBulkSection(''); setBulkAmount('');
      await fetchFees();
    } catch (e: unknown) {
      setBulkError(e instanceof Error ? e.message : 'Failed to set bulk fee');
    } finally {
      setBulkSubmitting(false);
    }
  }

  // ── Send reminder ─────────────────────────────────────────────────────────
  async function handleReminderSubmit(e: React.FormEvent) {
    e.preventDefault();
    setReminderError('');
    if (!reminderClass || !reminderSection) { setReminderError('Select a class and section'); return; }
    const token = getToken();
    if (!token) return;
    setReminderSubmitting(true);
    try {
      const res = await feesApi.sendReminder(token, {
        class_name: reminderClass,
        section: reminderSection,
        custom_note: reminderNote.trim() || undefined,
      });
      const d = res.data as { sent?: number };
      setSuccess(`Fee reminders sent to ${d.sent ?? 0} students`);
      setReminderOpen(false);
      setReminderClass(''); setReminderSection(''); setReminderNote('');
    } catch (e: unknown) {
      setReminderError(e instanceof Error ? e.message : 'Failed to send reminders');
    } finally {
      setReminderSubmitting(false);
    }
  }

  // ── Unique sections for selected class in bulk/reminder modals ─────────────
  const sectionsForBulkClass = classes.filter((c) => c.class_name === bulkClass).map((c) => c.section);
  const sectionsForReminderClass = classes.filter((c) => c.class_name === reminderClass).map((c) => c.section);
  const uniqueClasses = [...new Set(classes.map((c) => c.class_name))];

  return (
    <>
      <PageHeader
        title="Fee Management"
        description="Track and update student fee payments across all classes"
        action={
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setReminderOpen(true); setReminderError(''); }}
              className="px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Send Reminder
            </button>
            <button
              onClick={() => { setBulkOpen(true); setBulkError(''); }}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
            >
              Set Class Fees
            </button>
          </div>
        }
      />

      {/* ── Summary stats ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
        <FeeStatCard label="Total Students" value={String(allRecords.length)} sub="in view" color="text-gray-900" />
        <FeeStatCard label="Paid" value={String(paidCount)} sub="fee cleared" color="text-green-700" />
        <FeeStatCard label="Partial" value={String(partialCount)} sub="partially paid" color="text-yellow-700" />
        <FeeStatCard label="Unpaid" value={String(unpaidCount)} sub="fee defaulters" color="text-red-600" />
        <FeeStatCard label="Collected" value={fmt(totalCollected)} sub={`${fmt(totalOutstanding)} outstanding`} color="text-blue-700" />
      </div>

      {/* ── Filters ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <select
          value={filterClass}
          onChange={(e) => { setFilterClass(e.target.value); setFilterSection(''); }}
          className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
          aria-label="Filter by class"
        >
          <option value="">All Classes</option>
          {uniqueClasses.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select
          value={filterSection}
          onChange={(e) => setFilterSection(e.target.value)}
          disabled={!filterClass}
          className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-400"
          aria-label="Filter by section"
        >
          <option value="">All Sections</option>
          {classes.filter((c) => !filterClass || c.class_name === filterClass).map((c) => (
            <option key={`${c.class_name}-${c.section}`} value={c.section}>{c.section}</option>
          ))}
        </select>
        {(['', 'paid', 'partial', 'unpaid'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
              filterStatus === s
                ? 'bg-blue-600 text-white border-blue-600'
                : 'text-gray-600 border-gray-300 hover:border-blue-400 hover:text-blue-600'
            }`}
          >
            {s === '' ? 'All' : statusLabel(s)}
          </button>
        ))}
      </div>

      {/* ── Feedback ─────────────────────────────────────────────────────────── */}
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

      {/* ── Table ────────────────────────────────────────────────────────────── */}
      {loading ? (
        <LoadingSpinner />
      ) : records.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 text-center py-16">
          <p className="text-2xl mb-2">💰</p>
          <p className="text-sm text-gray-400">No fee records found.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-4 items-center px-5 py-3 bg-gray-50 border-b border-gray-100 text-xs font-medium text-gray-500 uppercase tracking-wide">
            <span>Student</span>
            <span className="text-right hidden sm:block">Class</span>
            <span className="text-right">Total Fee</span>
            <span className="text-right">Paid</span>
            <span className="text-right">Balance</span>
            <span className="text-right">Status</span>
          </div>

          <div className="divide-y divide-gray-50">
            {records.map((r) => {
              const total = r.total_fee_amount ?? 0;
              const paid = r.amount_paid ?? 0;
              const balance = Math.max(0, total - paid);
              const status = r.payment_status ?? (r.fee_paid ? 'paid' : 'unpaid');
              const styles = STATUS_STYLES[status as keyof typeof STATUS_STYLES] ?? STATUS_STYLES.unpaid;
              return (
                <div
                  key={r.student_id}
                  className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-4 items-center px-5 py-3 hover:bg-gray-50 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{r.full_name}</p>
                  </div>
                  <span className="text-sm text-gray-500 text-right hidden sm:block whitespace-nowrap">
                    {r.class_name} {r.section}
                  </span>
                  <span className="text-sm text-gray-800 text-right whitespace-nowrap">{fmt(total || null)}</span>
                  <span className="text-sm text-green-700 font-medium text-right whitespace-nowrap">{fmt(paid)}</span>
                  <span className={`text-sm font-medium text-right whitespace-nowrap ${balance > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                    {balance > 0 ? fmt(balance) : '—'}
                  </span>
                  <div className="flex items-center justify-end gap-2">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${styles.badge}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${styles.dot}`} />
                      {statusLabel(status as 'paid' | 'partial' | 'unpaid')}
                    </span>
                    <button
                      onClick={() => openPay(r)}
                      className="px-2 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors"
                    >
                      Edit
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Edit Payment Modal ──────────────────────────────────────────────── */}
      <Modal open={!!payTarget} onClose={() => setPayTarget(null)} title="Update Fee Payment">
        <form onSubmit={handlePaySubmit} className="space-y-4">
          {payError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{payError}</div>
          )}
          {payTarget && (
            <div className="px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg">
              <p className="text-xs text-gray-500 font-medium">Student</p>
              <p className="text-sm font-semibold text-gray-900">{payTarget.full_name}</p>
              <p className="text-xs text-gray-400">{payTarget.class_name} {payTarget.section}</p>
            </div>
          )}
          <FormField label="Total Fee Amount (₹)" htmlFor="pay-total" required>
            <input id="pay-total" type="number" min="0" step="1" className={inputClass}
              value={payTotal} onChange={(e) => setPayTotal(e.target.value)} placeholder="e.g. 25000" />
          </FormField>
          <FormField label="Amount Paid (₹)" htmlFor="pay-paid" required>
            <input id="pay-paid" type="number" min="0" step="1" className={inputClass}
              value={payPaid} onChange={(e) => setPayPaid(e.target.value)} placeholder="e.g. 12000" />
          </FormField>
          <FormField label="Notes (optional)" htmlFor="pay-notes">
            <textarea id="pay-notes" rows={2} className={`${inputClass} resize-none`}
              value={payNotes} onChange={(e) => setPayNotes(e.target.value)} placeholder="e.g. Paid by cheque #1234" />
          </FormField>
          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={() => setPayTarget(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={paySubmitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors">
              {paySubmitting ? 'Saving…' : 'Save Payment'}
            </button>
          </div>
        </form>
      </Modal>

      {/* ── Bulk Class Fee Modal ───────────────────────────────────────────── */}
      <Modal open={bulkOpen} onClose={() => setBulkOpen(false)} title="Set Class Fee Amount">
        <form onSubmit={handleBulkSubmit} className="space-y-4">
          {bulkError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{bulkError}</div>
          )}
          <p className="text-sm text-gray-500">Sets the same total fee amount for every student in the selected class/section.</p>
          <FormField label="Class" htmlFor="bulk-class" required>
            <select id="bulk-class" className={inputClass} value={bulkClass} onChange={(e) => { setBulkClass(e.target.value); setBulkSection(''); }}>
              <option value="">Select class…</option>
              {uniqueClasses.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </FormField>
          <FormField label="Section" htmlFor="bulk-section" required>
            <select id="bulk-section" className={inputClass} value={bulkSection} onChange={(e) => setBulkSection(e.target.value)} disabled={!bulkClass}>
              <option value="">Select section…</option>
              {sectionsForBulkClass.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </FormField>
          <FormField label="Total Fee Amount (₹)" htmlFor="bulk-amount" required>
            <input id="bulk-amount" type="number" min="1" step="1" className={inputClass}
              value={bulkAmount} onChange={(e) => setBulkAmount(e.target.value)} placeholder="e.g. 25000" />
          </FormField>
          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={() => setBulkOpen(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={bulkSubmitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors">
              {bulkSubmitting ? 'Setting…' : 'Set Fee'}
            </button>
          </div>
        </form>
      </Modal>

      {/* ── Reminder Modal ─────────────────────────────────────────────────── */}
      <Modal open={reminderOpen} onClose={() => setReminderOpen(false)} title="Send Fee Reminders">
        <form onSubmit={handleReminderSubmit} className="space-y-4">
          {reminderError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{reminderError}</div>
          )}
          <p className="text-sm text-gray-500">Sends a personalised fee reminder notification to each student in the class.</p>
          <FormField label="Class" htmlFor="rem-class" required>
            <select id="rem-class" className={inputClass} value={reminderClass} onChange={(e) => { setReminderClass(e.target.value); setReminderSection(''); }}>
              <option value="">Select class…</option>
              {uniqueClasses.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </FormField>
          <FormField label="Section" htmlFor="rem-section" required>
            <select id="rem-section" className={inputClass} value={reminderSection} onChange={(e) => setReminderSection(e.target.value)} disabled={!reminderClass}>
              <option value="">Select section…</option>
              {sectionsForReminderClass.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </FormField>
          <FormField label="Custom Note (optional)" htmlFor="rem-note">
            <textarea id="rem-note" rows={2} className={`${inputClass} resize-none`}
              value={reminderNote} onChange={(e) => setReminderNote(e.target.value)}
              placeholder="e.g. Last date for fee payment is 30th June" />
          </FormField>
          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={() => setReminderOpen(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={reminderSubmitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors">
              {reminderSubmitting ? 'Sending…' : 'Send Reminders'}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}

export default function AdminFeesPage() {
  return (
    <Suspense>
      <FeesPageInner />
    </Suspense>
  );
}
