'use client';

/**
 * Admin Data Export
 * School admin can download all school data as a ZIP of CSVs.
 * Calls GET /api/admin/export which streams a ZIP directly.
 */

import { useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { getToken } from '@/lib/session';
import PageHeader from '@/components/PageHeader';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

export default function ExportPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  async function handleExport() {
    const token = getToken();
    if (!token) return;
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const res = await fetch(`${BASE_URL}/api/admin/export`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { message?: string }).message ?? `Export failed: ${res.status}`);
      }
      // Trigger browser download
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `school-export-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setSuccess('Export downloaded successfully.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Export School Data"
        description="Download all school data as a ZIP archive of CSV files"
      />

      <div className="max-w-lg">
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">

          {/* What's included */}
          <div>
            <h2 className="text-sm font-semibold text-gray-900 mb-3">What's included</h2>
            <ul className="space-y-2">
              {[
                { file: 'students.csv', desc: 'All student records (name, class, section, roll number)' },
                { file: 'attendance.csv', desc: 'All attendance records with dates and status' },
                { file: 'marks.csv', desc: 'All marks by subject, term, and exam type' },
                { file: 'test_results.csv', desc: 'All test records' },
              ].map(({ file, desc }) => (
                <li key={file} className="flex items-start gap-3">
                  <div className="mt-0.5 w-5 h-5 rounded bg-blue-50 flex items-center justify-center shrink-0">
                    <svg className="w-3 h-3 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-800">{file}</p>
                    <p className="text-xs text-gray-500">{desc}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* Info note */}
          <div className="px-4 py-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
            This export includes all data for <strong>{user?.name ?? 'your school'}</strong>. The action is logged to the audit trail.
          </div>

          {/* Feedback */}
          {success && (
            <div className="px-4 py-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700 flex items-center gap-2">
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              {success}
            </div>
          )}
          {error && (
            <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
          )}

          {/* Download button */}
          <button
            onClick={handleExport}
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-5 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {loading ? (
              <>
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Preparing export…
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download ZIP Export
              </>
            )}
          </button>
        </div>
      </div>
    </>
  );
}
