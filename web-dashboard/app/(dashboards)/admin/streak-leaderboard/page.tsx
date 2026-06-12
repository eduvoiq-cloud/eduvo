'use client';

/**
 * /admin/streak-leaderboard
 *
 * School-wide streak leaderboard for school admins.
 * Shows top-5 students by current_streak in every class-section.
 * Suitable for display on a notice board or TV screen.
 */

import StreakLeaderboard from '@/components/StreakLeaderboard';

export default function AdminStreakLeaderboardPage() {
  return <StreakLeaderboard mode="admin" />;
}
