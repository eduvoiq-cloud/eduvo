-- ============================================================
-- FCM Tokens Table Migration
-- Adds a dedicated fcm_tokens table for storing device push tokens
-- linked to users (staff/parents) and students.
-- Run in: https://supabase.com/dashboard/project/YOUR_PROJECT/sql/new
-- ============================================================

-- Create fcm_tokens table
CREATE TABLE IF NOT EXISTS public.fcm_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One of user_id or student_id will be set (not both)
  user_id     uuid REFERENCES public.users(id) ON DELETE CASCADE,
  student_id  uuid REFERENCES public.students(id) ON DELETE CASCADE,
  token       text NOT NULL,
  platform    text CHECK (platform IN ('android', 'ios', 'web')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Ensure token is unique across all rows
  CONSTRAINT fcm_tokens_token_unique UNIQUE (token),
  -- At least one of user_id / student_id must be set
  CONSTRAINT fcm_tokens_owner_check CHECK (
    (user_id IS NOT NULL AND student_id IS NULL) OR
    (student_id IS NOT NULL AND user_id IS NULL)
  )
);

-- Index for fast lookups by user
CREATE INDEX IF NOT EXISTS idx_fcm_tokens_user_id
  ON public.fcm_tokens(user_id) WHERE user_id IS NOT NULL;

-- Index for fast lookups by student
CREATE INDEX IF NOT EXISTS idx_fcm_tokens_student_id
  ON public.fcm_tokens(student_id) WHERE student_id IS NOT NULL;

-- Keep the existing fcm_token columns on users/students for backwards
-- compatibility with the attendanceNotifications service (it reads
-- users.fcm_token for parents). They remain the source of truth for
-- single-device users; the fcm_tokens table supports multi-device.
