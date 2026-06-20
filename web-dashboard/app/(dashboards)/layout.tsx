'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import Navbar from '@/components/Navbar';

/**
 * Shared layout for all dashboard routes.
 * Client-side guard:
 *  1. No user after loading → redirect to /login
 *  2. User has must_reset_password → redirect to /force-reset-password
 *  3. School subscription expired → show the subscription-expired screen
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading, subscriptionExpired, logout, activeSchoolId } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    if (user.must_reset_password) {
      window.location.replace('/force-reset-password');
    }
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (user.must_reset_password) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Subscription expired — block all dashboard access
  if (subscriptionExpired && user.role !== 'superadmin') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4">
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-10 max-w-md w-full text-center space-y-6">
          {/* Icon */}
          <div className="flex items-center justify-center w-16 h-16 bg-orange-100 rounded-full mx-auto">
            <svg className="w-8 h-8 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
          </div>

          <div className="space-y-2">
            <h1 className="text-xl font-bold text-gray-900">Subscription Expired</h1>
            <p className="text-sm text-gray-500 leading-relaxed">
              Your subscription has expired. Please renew your subscription to continue
              using the service. Contact your administrator for assistance.
            </p>
          </div>

          <button
            onClick={() => logout()}
            className="w-full py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
          >
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      {/* key={activeSchoolId} causes all page children to fully remount whenever
          the admin switches medium, so every page's useEffect re-runs and fetches
          data for the newly selected school. */}
      <main key={activeSchoolId ?? 'default'} className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}
