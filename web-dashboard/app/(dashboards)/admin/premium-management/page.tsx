'use client';

/**
 * /admin/premium-management — removed
 *
 * Premium subscriptions no longer exist for students.
 * Redirects admins back to their dashboard.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminPremiumManagementRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/admin/dashboard');
  }, [router]);

  return (
    <div className="flex items-center justify-center min-h-[400px]">
      <p className="text-sm text-gray-500">Redirecting…</p>
    </div>
  );
}
