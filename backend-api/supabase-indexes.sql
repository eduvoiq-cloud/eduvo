-- ============================================================
-- Eduvo — Performance Indexes
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor)
-- All statements use CREATE INDEX IF NOT EXISTS so they are
-- safe to re-run without errors.
-- ============================================================

-- ── attendance ────────────────────────────────────────────────────────────────

-- Fast lookup by date (used by today-summary, class-history date range queries)
CREATE INDEX IF NOT EXISTS attendance_date_school
  ON attendance (date);

-- Fast lookup by student + date (used by history endpoint, notification dedup)
CREATE INDEX IF NOT EXISTS attendance_student_date
  ON attendance (student_id, date);

-- Fast lookup of unsent notifications (used by attendanceNotifications service)
CREATE INDEX IF NOT EXISTS attendance_notification_sent
  ON attendance (notification_sent)
  WHERE notification_sent = false;

-- ── marks ─────────────────────────────────────────────────────────────────────

-- Fast lookup by student + subject (used by marks list endpoint)
CREATE INDEX IF NOT EXISTS marks_student_subject
  ON marks (student_id, subject_id);

-- Fast lookup by student alone (common filter)
CREATE INDEX IF NOT EXISTS marks_student_id
  ON marks (student_id);

-- ── notifications ─────────────────────────────────────────────────────────────

-- Fast unread count + list for a user (used by GET /api/notifications)
CREATE INDEX IF NOT EXISTS notifications_user_read
  ON notifications (user_id, is_read);

-- Alias: recipient_id is the FK used in the notifications table
CREATE INDEX IF NOT EXISTS notifications_recipient_read
  ON notifications (recipient_id, is_read);

-- ── students ──────────────────────────────────────────────────────────────────

-- Fast class/section lookup (used by attendance submit, class-history, teacher routes)
CREATE INDEX IF NOT EXISTS students_school_class
  ON students (school_id, class, section);

-- Alias for tables that use class_name column
CREATE INDEX IF NOT EXISTS students_school_class_name
  ON students (school_id, class_name, section);

-- Fast soft-delete filter (nearly every query filters is_deleted = false)
CREATE INDEX IF NOT EXISTS students_school_not_deleted
  ON students (school_id)
  WHERE is_deleted = false;

-- Full-text search on student name (used by search/filter endpoints)
CREATE INDEX IF NOT EXISTS students_full_name_trgm
  ON students USING gin (full_name gin_trgm_ops);

-- ── users ─────────────────────────────────────────────────────────────────────

-- Fast role + school lookup (used by admin list, notification sender lookup)
CREATE INDEX IF NOT EXISTS users_school_role
  ON users (school_id, role);

-- Fast email lookup (used by bulk import parent dedup)
CREATE INDEX IF NOT EXISTS users_email
  ON users (email);

-- ── audit_logs ────────────────────────────────────────────────────────────────

-- Fast recent activity feed (used by dashboard audit log endpoint)
CREATE INDEX IF NOT EXISTS audit_logs_created_at
  ON audit_logs (created_at DESC);

-- ── ai_usage ──────────────────────────────────────────────────────────────────

-- Fast daily limit check (used by checkDailyLimit in geminiService)
CREATE INDEX IF NOT EXISTS ai_usage_user_school_created
  ON ai_usage (user_id, school_id, created_at);

-- Fast cache lookup by prompt hash (used by getCachedResult)
CREATE INDEX IF NOT EXISTS ai_usage_prompt_hash
  ON ai_usage (prompt_hash, created_at DESC);

-- ── teacher_assignments ───────────────────────────────────────────────────────

-- Fast teacher → class lookup (used by attendance submit auth check)
CREATE INDEX IF NOT EXISTS teacher_assignments_teacher
  ON teacher_assignments (teacher_id, school_id);

-- ── timetable ─────────────────────────────────────────────────────────────────

-- Fast class/section/day lookup (used by GET /api/timetable/class)
CREATE INDEX IF NOT EXISTS timetable_lookup
  ON timetable (school_id, class_name, section, day_of_week);

-- ── homework ──────────────────────────────────────────────────────────────────

-- Fast class/section/due_date lookup (used by GET /api/homework/class)
CREATE INDEX IF NOT EXISTS homework_class_due
  ON homework (school_id, class_name, section, due_date);

-- Fast acknowledgement lookup per student (used by homework /class JOIN and pending-count)
CREATE INDEX IF NOT EXISTS homework_ack_student
  ON homework_acknowledgements (student_id, homework_id);

-- ── students (additional) ─────────────────────────────────────────────────────

-- Fast phone number lookup (used by student login)
CREATE INDEX IF NOT EXISTS students_phone_lookup
  ON students (phone_number);

-- ── complaints ────────────────────────────────────────────────────────────────

-- Fast teacher complaints lookup (used by GET /api/complaints/teacher)
CREATE INDEX IF NOT EXISTS complaints_teacher
  ON complaints (teacher_id, status);

-- Fast school-level complaints lookup (used by GET /api/complaints/admin)
CREATE INDEX IF NOT EXISTS complaints_school
  ON complaints (school_id, recipient_type, status);

-- ============================================================
-- NOTE: The gin_trgm_ops index requires the pg_trgm extension.
-- Enable it first if not already active:
--   CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- ============================================================
