'use client';

import { useState, FormEvent } from 'react';
import Link from 'next/link';

const REASONS = [
  { value: '', label: 'Select a reason…' },
  { value: 'no_longer_using', label: 'No longer using the service' },
  { value: 'privacy_concerns', label: 'Privacy concerns' },
  { value: 'other', label: 'Other' },
];

export default function DeleteAccountPage() {
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    if (!email.trim()) {
      setError('Please enter your email address.');
      return;
    }
    if (!reason) {
      setError('Please select a reason for your request.');
      return;
    }

    setSubmitting(true);
    try {
      // Send deletion request via backend API
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? ''}/api/auth/delete-account-request`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: email.trim().toLowerCase(),
            reason,
            message: message.trim(),
          }),
        }
      );

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.message ?? 'Failed to submit request. Please try again.');
      }

      setSubmitted(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded-xl flex items-center justify-center">
            <span className="text-white font-bold text-sm">E</span>
          </div>
          <span className="text-gray-900 font-semibold text-lg tracking-tight">eduvo</span>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-6 py-12">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Request Account Deletion</h1>
        <p className="text-sm text-gray-500 mb-8">
          Submit this form to request deletion of your account and associated data.
          We will process your request within 7 business days.
        </p>

        {submitted ? (
          /* ── Success state ─────────────────────────────────────────────── */
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
            <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Request Received</h2>
            <p className="text-sm text-gray-600 mb-6">
              Your request has been received. We will process it within 7 days.
              You will receive a confirmation email at <strong>{email}</strong> once the deletion is complete.
            </p>
            <Link
              href="/"
              className="inline-block px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Back to Home
            </Link>
          </div>
        ) : (
          /* ── Form ──────────────────────────────────────────────────────── */
          <div className="bg-white rounded-xl border border-gray-200 p-8">
            {error && (
              <div className="mb-5 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-5" noValidate>
              {/* Email */}
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1.5">
                  Email address <span className="text-red-500">*</span>
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(''); }}
                  className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-lg bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              {/* Reason */}
              <div>
                <label htmlFor="reason" className="block text-sm font-medium text-gray-700 mb-1.5">
                  Reason for deletion <span className="text-red-500">*</span>
                </label>
                <select
                  id="reason"
                  required
                  value={reason}
                  onChange={(e) => { setReason(e.target.value); setError(''); }}
                  className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-lg bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  {REASONS.map((r) => (
                    <option key={r.value} value={r.value} disabled={r.value === ''}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Optional message */}
              <div>
                <label htmlFor="message" className="block text-sm font-medium text-gray-700 mb-1.5">
                  Additional details{' '}
                  <span className="text-gray-400 font-normal">(optional)</span>
                </label>
                <textarea
                  id="message"
                  rows={4}
                  placeholder="Any additional context about your request…"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-lg bg-white text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                />
              </div>

              {/* Notice */}
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-xs text-amber-800">
                <strong>Note:</strong> Deleting your account will permanently remove all associated data.
                This action cannot be undone. Requests are processed within 7 business days.
              </div>

              {/* Submit */}
              <button
                type="submit"
                disabled={submitting}
                className="w-full py-2.5 px-4 bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white text-sm font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
              >
                {submitting ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Submitting…
                  </span>
                ) : (
                  'Submit Deletion Request'
                )}
              </button>
            </form>
          </div>
        )}

        {/* Footer links */}
        <div className="mt-8 flex flex-wrap gap-4 text-sm text-gray-500 justify-center">
          <Link href="/privacy-policy" className="hover:text-gray-900 transition-colors">Privacy Policy</Link>
          <Link href="/terms-of-service" className="hover:text-gray-900 transition-colors">Terms of Service</Link>
          <Link href="/login" className="hover:text-gray-900 transition-colors">Sign In</Link>
        </div>
      </main>
    </div>
  );
}
