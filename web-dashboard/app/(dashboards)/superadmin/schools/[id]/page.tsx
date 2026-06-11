'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { superadminApi } from '@/lib/api';
import { getToken } from '@/lib/session';
import Modal from '@/components/Modal';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SchoolAdmin {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  created_at: string;
}

interface SchoolDetail {
  id: string;
  name: string;
  address: string;
  phone?: string | null;
  email?: string | null;
  subscription_status: boolean;
  student_count: number;
  teacher_count: number;
  attendance_today: number;
  admins: SchoolAdmin[];
  created_at: string;
  updated_at?: string | null;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SchoolDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [school, setSchool] = useState<SchoolDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const fetchDetail = useCallback(async () => {
    const token = getToken();
    if (!token || !id) return;
    setLoading(true);
    setError('');
    try {
      const res = await superadminApi.getSchoolDetail(token, id);
      setSchool(res.data as unknown as SchoolDetail);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load school details');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  // ── Delete ─────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!school) return;
    if (deleteInput.trim().toLowerCase() !== school.name.toLowerCase()) {
      setDeleteError('School name does not match. Please type it exactly.');
      return;
    }
    const token = getToken();
    if (!token) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await superadminApi.deleteSchool(token, school.id);
      router.replace('/superadmin/schools');
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete school');
      setDeleting(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !school) {
    return (
      <div className="max-w-2xl mx-auto mt-12 px-4">
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
          <p className="text-sm text-red-700 mb-4">{error || 'School not found.'}</p>
          <Link href="/superadmin/schools" className="text-sm text-blue-600 hover:underline">
            ← Back to Schools
          </Link>
        </div>
      </div>
    );
  }

  const attendancePct =
    school.student_count > 0
      ? Math.round((school.attendance_today / school.student_count) * 100)
      : 0;

  return (
    <>
      {/* ── Header ── */}
      <div className="mb-6">
        <Link
          href="/superadmin/schools"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-4"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to Schools
        </Link>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{school.name}</h1>
            <p className="text-sm text-gray-500 mt-0.5">{school.address}</p>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold ${
                school.subscription_status
                  ? 'bg-green-100 text-green-700'
                  : 'bg-gray-100 text-gray-500'
              }`}
            >
              {school.subscription_status ? 'Active' : 'Inactive'}
            </span>
            <button
              onClick={() => { setDeleteInput(''); setDeleteError(''); setShowDeleteConfirm(true); }}
              className="px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg transition-colors"
            >
              Delete School
            </button>
          </div>
        </div>
      </div>

      {/* ── Stats row ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <StatCard
          label="Total Students"
          value={school.student_count}
          icon={
            <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197" />
            </svg>
          }
          color="blue"
        />
        <StatCard
          label="Total Teachers"
          value={school.teacher_count}
          icon={
            <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          }
          color="purple"
        />
        <StatCard
          label="Today's Attendance"
          value={`${school.attendance_today} / ${school.student_count}`}
          sub={`${attendancePct}% present`}
          icon={
            <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          }
          color="green"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── School Info ── */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">School Information</h2>
          <dl className="space-y-3">
            <InfoRow label="School Name" value={school.name} />
            <InfoRow label="Address" value={school.address} />
            <InfoRow
              label="Email"
              value={school.email || <span className="text-gray-400 italic">Not set</span>}
            />
            <InfoRow
              label="Phone"
              value={school.phone || <span className="text-gray-400 italic">Not set</span>}
            />
            <InfoRow
              label="Status"
              value={
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    school.subscription_status
                      ? 'bg-green-100 text-green-700'
                      : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {school.subscription_status ? 'Active' : 'Inactive'}
                </span>
              }
            />
            <InfoRow
              label="Created"
              value={new Date(school.created_at).toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
            />
          </dl>
        </div>

        {/* ── Admins ── */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">
            School Admins
            <span className="ml-2 text-xs font-normal text-gray-400">
              ({school.admins.length})
            </span>
          </h2>

          {school.admins.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm text-gray-400 mb-3">No admin accounts yet.</p>
              <Link
                href="/superadmin/schools"
                className="text-xs text-blue-600 hover:text-blue-700 font-medium"
              >
                Go to Schools list → Add Admin
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {school.admins.map((admin) => (
                <div
                  key={admin.id}
                  className="flex items-start justify-between p-3 bg-gray-50 rounded-lg"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{admin.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5 truncate">{admin.email}</p>
                    {admin.phone && (
                      <p className="text-xs text-gray-400 mt-0.5">{admin.phone}</p>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 shrink-0 ml-3">
                    {new Date(admin.created_at).toLocaleDateString()}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Delete Confirmation Modal ── */}
      <Modal
        open={showDeleteConfirm}
        onClose={() => { setShowDeleteConfirm(false); setDeleteInput(''); setDeleteError(''); }}
        title="Delete School"
        size="sm"
      >
        <div className="space-y-4">
          <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
            <p className="font-semibold mb-1">⚠️ This action cannot be undone.</p>
            <p>
              Deleting <strong>{school.name}</strong> will permanently remove all students,
              teachers, attendance records, marks, fees, and login accounts for this school.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">
              Type the school name to confirm:
              <span className="ml-1 font-mono text-gray-900">{school.name}</span>
            </label>
            <input
              type="text"
              value={deleteInput}
              onChange={(e) => { setDeleteInput(e.target.value); setDeleteError(''); }}
              placeholder={school.name}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
              autoFocus
            />
          </div>

          {deleteError && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {deleteError}
            </p>
          )}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => { setShowDeleteConfirm(false); setDeleteInput(''); }}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting || deleteInput.trim().toLowerCase() !== school.name.toLowerCase()}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors"
            >
              {deleting ? 'Deleting…' : 'Delete School'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  icon,
  color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ReactNode;
  color: 'blue' | 'purple' | 'green';
}) {
  const bg = { blue: 'bg-blue-50', purple: 'bg-purple-50', green: 'bg-green-50' }[color];
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
        <div className={`w-9 h-9 rounded-lg ${bg} flex items-center justify-center`}>{icon}</div>
      </div>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <dt className="text-xs font-medium text-gray-500 w-28 shrink-0 mt-0.5">{label}</dt>
      <dd className="text-sm text-gray-900 min-w-0 break-words">{value}</dd>
    </div>
  );
}
