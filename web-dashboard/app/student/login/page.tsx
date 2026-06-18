'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { studentAuthApi } from '@/lib/studentApi';
import { saveStudentSession, getStudentToken } from '@/lib/studentSession';

export default function StudentLoginPage() {
  const router = useRouter();
  const [phoneOrEmail, setPhoneOrEmail] = useState('');
  const [password, setPassword]         = useState('');
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState('');
  const [checking, setChecking]         = useState(true);

  // Redirect already-logged-in students immediately
  useEffect(() => {
    const token = getStudentToken();
    if (token) {
      router.replace('/student/tests');
    } else {
      setChecking(false);
    }
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!phoneOrEmail.trim() || !password.trim()) {
      setError('Please enter your phone/email and password.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await studentAuthApi.login(phoneOrEmail.trim(), password);
      const { token, student } = res.data;
      saveStudentSession(token, {
        id:           student.id,
        name:         student.name,
        phone_number: student.phone_number,
        class_name:   student.class_name,
        section:      student.section,
        school_id:    student.school_id,
      });
      router.replace('/student/tests');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Login failed. Please try again.';
      setError(msg.includes('401') || msg.toLowerCase().includes('invalid')
        ? 'Incorrect phone number or password.'
        : msg);
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm">
        {/* Logo / branding */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-600 rounded-2xl mb-4 shadow-lg">
            <span className="text-3xl" role="img" aria-label="pencil">✏️</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Eduvo</h1>
          <p className="text-sm text-gray-500 mt-1">Student Test Portal</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          <h2 className="text-lg font-semibold text-gray-900 mb-6">Sign in to your account</h2>

          {error && (
            <div
              role="alert"
              className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700"
            >
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div>
              <label htmlFor="identifier" className="block text-sm font-medium text-gray-700 mb-1">
                Phone Number or Email
              </label>
              <input
                id="identifier"
                type="text"
                autoComplete="username"
                inputMode="text"
                placeholder="e.g. 9876543210"
                value={phoneOrEmail}
                onChange={(e) => setPhoneOrEmail(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                required
                aria-required="true"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                required
                aria-required="true"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-semibold rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              aria-label="Sign in"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Signing in…
                </span>
              ) : (
                'Sign In'
              )}
            </button>
          </form>

          <p className="mt-6 text-xs text-center text-gray-400">
            Use your school-issued phone number and password.
            <br />Contact your teacher if you have trouble logging in.
          </p>
        </div>
      </div>
    </div>
  );
}
