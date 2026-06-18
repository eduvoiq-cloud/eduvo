'use client';

/**
 * /teacher/premium — removed
 *
 * Premium subscriptions no longer exist.
 * This page redirects teachers back to their dashboard.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function TeacherPremiumRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/teacher/dashboard');
  }, [router]);

  return (
    <div className="flex items-center justify-center min-h-[400px]">
      <p className="text-sm text-gray-500">Redirecting…</p>
    </div>
  );
}
