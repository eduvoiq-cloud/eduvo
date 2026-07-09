-- Reset today's AI generation count for ALL users
-- Run this in Supabase SQL editor whenever you need to unblock testing
DELETE FROM ai_usage
WHERE feature = 'test_generate'
  AND created_at >= CURRENT_DATE;
