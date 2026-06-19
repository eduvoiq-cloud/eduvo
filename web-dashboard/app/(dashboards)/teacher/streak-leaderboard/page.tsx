'use client';

/**
 * /teacher/streak-leaderboard
 *
 * Class-level streak leaderboard for teachers.
 * Only visible to teachers who are class admins for at least one class.
 */

import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { getToken } from '@/lib/session';
import StreakLeaderboard from '@/components/StreakLeaderboard';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

export default function TeacherStreakLeaderboardPage() {
  const { user, loading: authLoading } = useAuth();
  const [isClassAdmin, setIsClassAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    if (authLoading) return;
    const token = getToken();
    if (!token) {
      setIsClassAdmin(false);
      return;
    }
    fetch(`${BASE_URL}/api/class-admin/my-classes`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    })
      .then((r) => r.json())
      .then((res) => {
        const classes = res?.data ?? [];
        setIsClassAdmin(Array.isArray(classes) && classes.length > 0);
      })
      .catch(() => setIsClassAdmin(false));
  }, [user, authLoading]);

  if (isClassAdmin === null) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isClassAdmin) {
    return (
      <div className="bg-orange-50 border border-orange-200 rounded-xl px-6 py-8 flex flex-col items-center text-center gap-3 mt-6">
        <span className="text-3xl">🔥</span>
        <p className="text-sm font-semibold text-orange-800">Streak Board is for class admins</p>
        <p className="text-sm text-orange-700">
          The streak leaderboard is only available to teachers who are appointed as class admin for a class.
          Contact your school administrator if you think this is a mistake.
        </p>
      </div>
    );
  }

  return <StreakLeaderboard mode="teacher" />;
}
