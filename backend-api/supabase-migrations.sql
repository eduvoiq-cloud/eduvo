-- ============================================================
-- Eduvo — Schema Migrations
-- Run AFTER supabase-schema.sql to add missing columns/tables
-- that the backend code requires but the base schema omits.
-- Safe to run multiple times (uses IF NOT EXISTS / DO blocks).
-- ============================================================

-- ── schools: add subscription_status, updated_at ─────────────────────────────
-- The superadmin route uses subscription_status (boolean) not is_active.
-- Both are kept so existing code using is_active still works.
alter table public.schools
  add column if not exists subscription_status boolean not null default false,
  add column if not exists updated_at timestamptz not null default now();

-- Sync is_active → subscription_status for existing rows
update public.schools set subscription_status = is_active where subscription_status != is_active;

-- ── students: add missing columns ────────────────────────────────────────────
alter table public.students
  add column if not exists roll_number  text,
  add column if not exists rfid_uid     text unique,
  add column if not exists qr_code      text,
  add column if not exists is_deleted   boolean not null default false,
  add column if not exists deleted_at   timestamptz;

-- ── users: add fcm_token, phone, is_deleted ──────────────────────────────────
alter table public.users
  add column if not exists fcm_token  text,
  add column if not exists phone      text,
  add column if not exists is_deleted boolean not null default false,
  add column if not exists deleted_at timestamptz;

-- ── audit_logs: add table_name column ────────────────────────────────────────
-- The superadmin and admin routes write table_name to audit_logs.
alter table public.audit_logs
  add column if not exists table_name text;

-- ── notification_queue: new table ────────────────────────────────────────────
-- Used by the attendance RFID route to queue delayed parent notifications.
create table if not exists public.notification_queue (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references public.users(id) on delete cascade,
  student_id  uuid references public.students(id) on delete cascade,
  message     text not null,
  send_after  timestamptz not null,
  sent        boolean not null default false,
  sent_at     timestamptz,
  cancelled   boolean not null default false,
  created_at  timestamptz not null default now()
);

alter table public.notification_queue enable row level security;
create policy "deny_all_notification_queue" on public.notification_queue for all using (false);

create index if not exists idx_notification_queue_send_after
  on public.notification_queue(send_after)
  where sent = false and cancelled = false;

-- ── parent_students: junction table ──────────────────────────────────────────
-- Used by admin route to link parents to multiple students.
create table if not exists public.parent_students (
  parent_id   uuid not null references public.users(id) on delete cascade,
  student_id  uuid not null references public.students(id) on delete cascade,
  primary key (parent_id, student_id)
);

alter table public.parent_students enable row level security;
create policy "deny_all_parent_students" on public.parent_students for all using (false);

-- ── subjects: school subject catalogue ───────────────────────────────────────
-- Used by admin route POST /api/admin/subjects.
create table if not exists public.subjects (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  school_id   uuid not null references public.schools(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (school_id, name)
);

alter table public.subjects enable row level security;
create policy "deny_all_subjects" on public.subjects for all using (false);

-- ── announcements: school announcements ──────────────────────────────────────
-- Used by admin route POST /api/admin/announcements.
create table if not exists public.announcements (
  id            uuid primary key default uuid_generate_v4(),
  title         text not null,
  message       text not null,
  target_class  text,
  school_id     uuid not null references public.schools(id) on delete cascade,
  created_by    uuid not null references public.users(id) on delete cascade,
  created_at    timestamptz not null default now()
);

alter table public.announcements enable row level security;
create policy "deny_all_announcements" on public.announcements for all using (false);

create index if not exists idx_announcements_school_id
  on public.announcements(school_id, created_at desc);

-- ── fees: rename student_fees → fees alias ───────────────────────────────────
-- The frontend api.ts calls /api/fees which maps to student_fees table.
-- The fees route uses student_fees. No rename needed — just ensure the
-- fees route's expected columns exist.
alter table public.student_fees
  add column if not exists school_id uuid references public.schools(id) on delete cascade;

-- Backfill school_id from the student's school
update public.student_fees sf
set school_id = s.school_id
from public.students s
where sf.student_id = s.id
  and sf.school_id is null;

-- ── indexes for new columns ───────────────────────────────────────────────────
create index if not exists idx_students_rfid_uid
  on public.students(rfid_uid) where rfid_uid is not null;

create index if not exists idx_students_is_deleted
  on public.students(school_id, is_deleted);

create index if not exists idx_audit_logs_table_name
  on public.audit_logs(table_name);

create index if not exists idx_schools_subscription_status
  on public.schools(subscription_status);
