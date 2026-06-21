-- ── Student OTP Reset Tokens ─────────────────────────────────────────────────
--
-- Stores hashed OTPs for the self-service WhatsApp-based password reset flow.
-- The backend also uses Redis for OTP storage (5-min TTL), but this table
-- provides an audit trail and a fallback if Redis is unavailable.
--
-- NOTE: The primary OTP flow is Redis-backed (see auth.ts).
-- This table is for audit/compliance purposes only.
-- Run this migration in the Supabase SQL editor or via psql.

CREATE TABLE IF NOT EXISTS public.student_otp_tokens (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  uuid        NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  otp_hash    text        NOT NULL,
  expires_at  timestamptz NOT NULL,
  used        boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS student_otp_tokens_student_id_idx
  ON public.student_otp_tokens (student_id);

CREATE INDEX IF NOT EXISTS student_otp_tokens_expires_at_idx
  ON public.student_otp_tokens (expires_at);

ALTER TABLE public.student_otp_tokens ENABLE ROW LEVEL SECURITY;

-- Only the service role (backend) may read/write OTP tokens — no client access.
-- (No RLS policies = blocked for all anon/authenticated Supabase clients;
--  the backend uses supabaseAdmin which bypasses RLS.)

COMMENT ON TABLE public.student_otp_tokens IS
  'Audit log of OTP tokens issued for student self-service password reset via WhatsApp.';
