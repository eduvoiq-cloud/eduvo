-- Fix: expand the notifications type constraint to include all types used by the backend.
-- The old constraint was:
--   CHECK (type IN ('announcement', 'alert', 'reminder', 'grade', 'attendance', 'fee_reminder'))
--
-- The backend inserts these additional types that were silently failing:
--   'test'           — new test assigned
--   'marks'          — marks uploaded
--   'homework'       — homework assigned/reviewed (future use)
--   'daily_reminder' — streak/daily test reminders from cron
--   'recovery'       — recovery pack/test ready
--
-- Run this in your Supabase SQL editor.

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'announcement',
    'alert',
    'reminder',
    'grade',
    'attendance',
    'fee_reminder',
    'test',
    'marks',
    'homework',
    'daily_reminder',
    'recovery'
  ));

NOTIFY pgrst, 'reload schema';
