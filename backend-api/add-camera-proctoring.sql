-- ── Camera proctoring migration ────────────────────────────────────────────────
-- Run this against your Supabase database.

-- Add camera proctoring toggle to tests table
ALTER TABLE tests ADD COLUMN IF NOT EXISTS require_camera BOOLEAN DEFAULT FALSE;

-- Add web proctoring fields to test_attempts table
ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS fullscreen_exit_count INTEGER DEFAULT 0;
ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS face_absent_count INTEGER DEFAULT 0;
ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS face_absent_duration_seconds INTEGER DEFAULT 0;
ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS multiple_faces_count INTEGER DEFAULT 0;
