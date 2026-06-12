'use client';

/**
 * /teacher/streak-leaderboard
 *
 * Class-level streak leaderboard for teachers.
 * Teacher picks their class + section, sees top-5 students by current_streak.
 */

import StreakLeaderboard from '@/components/StreakLeaderboard';

export default function TeacherStreakLeaderboardPage() {
  return <StreakLeaderboard mode="teacher" />;
}
