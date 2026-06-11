'use client';

import { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { superadminApi, schoolsApi, type School } from '@/lib/api';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';
import FormField, { inputClass } from '@/components/FormField';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AddSchoolForm {
  name: string;
  address: string;
  phone: string;
  email: string;
}

interface AddAdminForm {
  name: string;
  email: string;
  phone: string;
}

interface AdminCreatedResult {
  email: string;
  default_password?: string;
  password_is_phone?: boolean;
  already_existed?: boolean;
}

const EMPTY_SCHOOL_FORM: AddSchoolForm = { name: '', address: '', phone: '', email: '' };
const EMPTY_ADMIN_FORM: AddAdminForm = { name: '', email: '', phone: '' };

// ── Main page ─────────────────────────────────────────────────────────────────

function SchoolsPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [schools, setSchools] = useState<School[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Modal state
  const [showAddSchool, setShowAddSchool] = useState(false);
  const [showAddAdmin, setShowAddAdmin] = useState<School | null>(null); // school to add admin for
  const [showConfirmToggle, setShowConfirmToggle] = useState<School | null>(null);

  // Form state
  const [schoolForm, setSchoolForm] = useState<AddSchoolForm>(EMPTY_SCHOOL_FORM);
  const [adminForm, setAdminForm] = useState<AddAdminForm>(EMPTY_ADMIN_FORM);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const [adminCreated, setAdminCreated] = useState<AdminCreatedResult | null>(null);

  // Search
  const [search, setSearch] = useState('');

  // Open "Add School" modal if ?action=new in URL
  useEffect(() => {
    if (searchParams.get('action') === 'new') {
      setShowAddSchool(true);
      router.replace('/superadmin/schools');
    }
  }, [searchParams, router]);

  // ── Fetch schools ─────────────────────────────────────────────────────────

  const fetchSchools = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      // superadminApi.listSchools already includes student_count, teacher_count,
      // and subscription_status — no need for a separate students call.
      const res = await superadminApi.listSchools(token, { limit: 200 });
      const schoolList = res.data?.data ?? [];

      // Normalise: map subscription_status → is_active so the rest of the UI
      // can use school.is_active consistently.
      const enriched = schoolList.map((school) => ({
        ...school,
        is_active: (school as School & { subscription_status?: boolean }).subscription_status ?? false,
      }));

      setSchools(enriched as School[]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load schools');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSchools(); }, [fetchSchools]);

  // ── Add school ────────────────────────────────────────────────────────────

  async function handleAddSchool(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    if (!schoolForm.name.trim() || !schoolForm.address.trim()) {
      setFormError('Name and address are required.');
      return;
    }
    const token = getToken();
    if (!token) return;
    setSubmitting(true);
    try {
      await schoolsApi.create(token, {
        name: schoolForm.name.trim(),
        address: schoolForm.address.trim(),
        phone: schoolForm.phone.trim() || undefined,
        email: schoolForm.email.trim() || undefined,
      });
      setShowAddSchool(false);
      setSchoolForm(EMPTY_SCHOOL_FORM);
      await fetchSchools();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Failed to create school');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Toggle subscription ───────────────────────────────────────────────────

  async function handleToggleSubscription() {
    if (!showConfirmToggle) return;
    const token = getToken();
    if (!token) return;
    setSubmitting(true);
    try {
      const newStatus = !showConfirmToggle.is_active;
      await superadminApi.toggleSubscription(token, showConfirmToggle.id, newStatus);
      setShowConfirmToggle(null);
      await fetchSchools();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update school');
      setShowConfirmToggle(null);
    } finally {
      setSubmitting(false);
    }
  }

  // ── Create school admin ───────────────────────────────────────────────────

  async function handleAddAdmin(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    if (!adminForm.name.trim() || !adminForm.email.trim()) {
      setFormError('Name and email are required.');
      return;
    }
    if (!showAddAdmin) return;
    const token = getToken();
    if (!token) return;
    setSubmitting(true);
    try {
      const response = await superadminApi.createSchoolAdmin(token, showAddAdmin.id, {
        name:  adminForm.name.trim(),
        email: adminForm.email.trim(),
        phone: adminForm.phone.trim() || undefined,
      });
      const result = response.data;
      setAdminForm(EMPTY_ADMIN_FORM);
      setAdminCreated({
        email:            result.email ?? adminForm.email,
        default_password: result.default_password,
        password_is_phone: result.password_is_phone,
        already_existed:  result.already_existed,
      });
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Failed to create admin account');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Filtered list ─────────────────────────────────────────────────────────

  const filtered = schools.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.address.toLowerCase().includes(search.toLowerCase())
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <PageHeader
        title="Schools"
        description="Manage all schools on the platform"
        action={
          <button
            onClick={() => { setSchoolForm(EMPTY_SCHOOL_FORM); setFormError(''); setShowAddSchool(true); }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add School
          </button>
        }
      />

      {/* Error banner */}
      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Search */}
      <div className="mb-4">
        <div className="relative max-w-sm">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search schools…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-sm text-gray-500">
            {search ? 'No schools match your search.' : 'No schools yet. Add your first school.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">School</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Address</th>
                  <th className="text-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Students</th>
                  <th className="text-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                  <th className="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((school) => (
                  <tr key={school.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4">
                      <p className="font-medium text-gray-900">{school.name}</p>
                      {school.email && <p className="text-xs text-gray-400 mt-0.5">{school.email}</p>}
                    </td>
                    <td className="px-6 py-4 text-gray-600 max-w-xs truncate">{school.address}</td>
                    <td className="px-6 py-4 text-center">
                      <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-blue-50 text-blue-700 text-xs font-semibold">
                        {school.student_count ?? 0}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-center">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        school.is_active
                          ? 'bg-green-100 text-green-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}>
                        {school.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-2">
                        {/* View details */}
                        <Link
                          href={`/superadmin/schools/${school.id}`}
                          className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors"
                        >
                          View Details
                        </Link>
                        {/* Create admin */}
                        <button
                          onClick={() => { setAdminForm(EMPTY_ADMIN_FORM); setFormError(''); setShowAdminPassword(false); setShowAddAdmin(school); }}
                          className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors"
                          title="Create school admin"
                        >
                          Add Admin
                        </button>
                        {/* Toggle subscription */}
                        <button
                          onClick={() => setShowConfirmToggle(school)}
                          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                            school.is_active
                              ? 'text-orange-700 bg-orange-50 hover:bg-orange-100'
                              : 'text-green-700 bg-green-50 hover:bg-green-100'
                          }`}
                        >
                          {school.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Add School Modal ─────────────────────────────────────────────── */}
      <Modal
        open={showAddSchool}
        onClose={() => setShowAddSchool(false)}
        title="Add New School"
      >
        <form onSubmit={handleAddSchool} className="space-y-4">
          {formError && (
            <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {formError}
            </div>
          )}

          <FormField label="School Name" htmlFor="school-name" required>
            <input
              id="school-name"
              type="text"
              className={inputClass}
              placeholder="e.g. Greenwood Academy"
              value={schoolForm.name}
              onChange={(e) => setSchoolForm((f) => ({ ...f, name: e.target.value }))}
              required
            />
          </FormField>

          <FormField label="Address" htmlFor="school-address" required>
            <input
              id="school-address"
              type="text"
              className={inputClass}
              placeholder="123 Main Street, City"
              value={schoolForm.address}
              onChange={(e) => setSchoolForm((f) => ({ ...f, address: e.target.value }))}
              required
            />
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Phone" htmlFor="school-phone">
              <input
                id="school-phone"
                type="tel"
                className={inputClass}
                placeholder="+1 555 000 0000"
                value={schoolForm.phone}
                onChange={(e) => setSchoolForm((f) => ({ ...f, phone: e.target.value }))}
              />
            </FormField>
            <FormField label="Email" htmlFor="school-email">
              <input
                id="school-email"
                type="email"
                className={inputClass}
                placeholder="school@example.com"
                value={schoolForm.email}
                onChange={(e) => setSchoolForm((f) => ({ ...f, email: e.target.value }))}
              />
            </FormField>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setShowAddSchool(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors"
            >
              {submitting ? 'Creating…' : 'Create School'}
            </button>
          </div>
        </form>
      </Modal>

      {/* ── Add Admin Modal ──────────────────────────────────────────────── */}
      <Modal
        open={!!showAddAdmin}
        onClose={() => { setShowAddAdmin(null); setAdminCreated(null); setFormError(''); }}
        title={`Create Admin — ${showAddAdmin?.name ?? ''}`}
      >
        {adminCreated ? (
          <div className="space-y-4">
            {adminCreated.already_existed ? (
              <div className="px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
                An admin with email <strong>{adminCreated.email}</strong> already exists for this school.
                They can log in with their existing credentials, or use &ldquo;Forgot Password&rdquo; to reset.
              </div>
            ) : (
              <>
                <div className="px-3 py-2.5 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
                  ✓ Admin account created for <strong>{adminCreated.email}</strong>.
                </div>
                {adminCreated.default_password && (
                  <div className="px-3 py-2.5 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-900 space-y-2">
                    <p className="font-semibold">Share these login credentials with the school admin:</p>
                    <div className="bg-white border border-yellow-200 rounded-lg p-3 space-y-1 text-sm font-mono">
                      <p><span className="text-gray-500 font-sans">Email: </span>{adminCreated.email}</p>
                      <p><span className="text-gray-500 font-sans">Password: </span><span className="font-bold tracking-wider">{adminCreated.default_password}</span></p>
                    </div>
                    <p className="text-xs text-yellow-700">
                      {adminCreated.password_is_phone
                        ? 'Password is their phone number. They will be prompted to change it on first login.'
                        : 'A temporary password was generated. They will be prompted to change it on first login.'}
                    </p>
                  </div>
                )}
              </>
            )}
            <div className="flex justify-end">
              <button
                onClick={() => { setShowAddAdmin(null); setAdminCreated(null); }}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleAddAdmin} className="space-y-4">
            {formError && (
              <div className="px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {formError}
              </div>
            )}

            <div className="px-3 py-2.5 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-700">
              This account will have <strong>School Admin</strong> access for{' '}
              <strong>{showAddAdmin?.name}</strong>. Password will be set to their phone number and they&apos;ll be asked to change it on first login.
            </div>

            <FormField label="Full Name" htmlFor="admin-name" required>
              <input
                id="admin-name"
                type="text"
                className={inputClass}
                placeholder="Jane Smith"
                value={adminForm.name}
                onChange={(e) => setAdminForm((f) => ({ ...f, name: e.target.value }))}
                required
              />
            </FormField>

            <FormField label="Email Address" htmlFor="admin-email" required>
              <input
                id="admin-email"
                type="email"
                className={inputClass}
                placeholder="admin@school.com"
                value={adminForm.email}
                onChange={(e) => setAdminForm((f) => ({ ...f, email: e.target.value }))}
                required
              />
            </FormField>

            <FormField label="Phone Number" htmlFor="admin-phone">
              <input
                id="admin-phone"
                type="tel"
                className={inputClass}
                placeholder="+1 555 000 0000"
                value={adminForm.phone}
                onChange={(e) => setAdminForm((f) => ({ ...f, phone: e.target.value }))}
              />
              <p className="text-xs text-gray-400 mt-1">Used as the default password. If left blank, a temporary password is generated.</p>
            </FormField>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => { setShowAddAdmin(null); setFormError(''); }}
                className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 rounded-lg transition-colors"
              >
                {submitting ? 'Creating…' : 'Create Admin Account'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* ── Confirm Toggle Modal ─────────────────────────────────────────── */}
      <Modal
        open={!!showConfirmToggle}
        onClose={() => setShowConfirmToggle(null)}
        title={showConfirmToggle?.is_active ? 'Deactivate School' : 'Activate School'}
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            {showConfirmToggle?.is_active ? (
              <>
                Are you sure you want to <strong>deactivate</strong>{' '}
                <strong>{showConfirmToggle?.name}</strong>? Their subscription will be paused and
                users will lose access.
              </>
            ) : (
              <>
                Are you sure you want to <strong>activate</strong>{' '}
                <strong>{showConfirmToggle?.name}</strong>? Their subscription will be restored.
              </>
            )}
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setShowConfirmToggle(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleToggleSubscription}
              disabled={submitting}
              className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-50 ${
                showConfirmToggle?.is_active
                  ? 'bg-orange-600 hover:bg-orange-700'
                  : 'bg-green-600 hover:bg-green-700'
              }`}
            >
              {submitting
                ? 'Updating…'
                : showConfirmToggle?.is_active
                ? 'Yes, Deactivate'
                : 'Yes, Activate'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}

// Wrap in Suspense because useSearchParams requires it in Next.js App Router
export default function SchoolsPage() {
  return (
    <Suspense>
      <SchoolsPageInner />
    </Suspense>
  );
}
