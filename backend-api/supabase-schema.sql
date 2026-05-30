-- ============================================================
-- EduFlow / Eduvo — Supabase Database Schema
-- Run this in the Supabase SQL editor to create all tables.
-- ============================================================

-- ── Extensions ────────────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ── users ─────────────────────────────────────────────────────────────────────
-- Mirrors auth.users; role is the source of truth (never trust JWT claims).
-- NOTE: school_id FK is added after schools table is created (see below).
create table if not exists public.users (
  id            uuid primary key references auth.users(id) on delete cascade,
  name          text not null,
  email         text not null unique,
  role          text not null check (role in ('superadmin','schooladmin','teacher','parent','student')),
  school_id     uuid,  -- FK added after schools table below
  fcm_token     text,
  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- ── schools ───────────────────────────────────────────────────────────────────
create table if not exists public.schools (
  id                  uuid primary key default uuid_generate_v4(),
  name                text not null,
  address             text not null,
  phone               text,
  email               text,
  is_active           boolean not null default true,
  subscription_status boolean not null default false,
  updated_at          timestamptz not null default now(),
  created_at          timestamptz not null default now()
);

-- Add school_id FK to users now that schools table exists
alter table public.users
  add constraint users_school_id_fkey
  foreign key (school_id) references public.schools(id) on delete set null;

-- ── school_settings ───────────────────────────────────────────────────────────
create table if not exists public.school_settings (
  school_id               uuid primary key references public.schools(id) on delete cascade,
  attendance_cutoff_time  text not null default '09:00',  -- HH:MM
  timezone                text not null default 'UTC',
  term_name               text not null default '',
  academic_year           text not null default '',
  updated_at              timestamptz not null default now()
);

-- ── students ──────────────────────────────────────────────────────────────────
create table if not exists public.students (
  id             uuid primary key default uuid_generate_v4(),
  full_name      text not null,
  date_of_birth  date,
  school_id      uuid not null references public.schools(id) on delete cascade,
  class_name     text not null,
  section        text,
  parent_id      uuid references public.users(id) on delete set null,
  email          text,
  phone          text,
  photo_url      text,
  roll_number    text,
  rfid_uid       text unique,
  qr_code        text,
  is_deleted     boolean not null default false,
  deleted_at     timestamptz,
  created_at     timestamptz not null default now()
);

-- ── teacher_assignments ───────────────────────────────────────────────────────
create table if not exists public.teacher_assignments (
  id          uuid primary key default uuid_generate_v4(),
  teacher_id  uuid not null references public.users(id) on delete cascade,
  school_id   uuid not null references public.schools(id) on delete cascade,
  class_name  text not null,
  section     text not null,
  subject     text not null,
  created_at  timestamptz not null default now(),
  unique (teacher_id, class_name, section, subject)
);

-- ── attendance ────────────────────────────────────────────────────────────────
create table if not exists public.attendance (
  id                  uuid primary key default uuid_generate_v4(),
  student_id          uuid not null references public.students(id) on delete cascade,
  date                date not null,
  status              text not null check (status in ('present','absent','late','excused')),
  source              text not null default 'manual' check (source in ('manual','rfid')),
  notes               text,
  recorded_by         uuid references public.users(id) on delete set null,
  notification_sent   boolean not null default false,
  updated_at          timestamptz,
  created_at          timestamptz not null default now(),
  unique (student_id, date)
);

-- ── marks ─────────────────────────────────────────────────────────────────────
create table if not exists public.marks (
  id           uuid primary key default uuid_generate_v4(),
  student_id   uuid not null references public.students(id) on delete cascade,
  subject      text not null,
  score        numeric(6,2) not null,
  max_score    numeric(6,2) not null default 100,
  term         text not null,
  exam_type    text not null check (exam_type in ('quiz','midterm','final','assignment','project','unit_test','mid_term','class_test')),
  notes        text,
  recorded_by  uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

-- ── student_fees ──────────────────────────────────────────────────────────────
create table if not exists public.student_fees (
  id             uuid primary key default uuid_generate_v4(),
  student_id     uuid not null references public.students(id) on delete cascade,
  term           text not null,
  academic_year  text not null,
  fee_paid       boolean not null default false,
  notes          text,
  updated_by     uuid references public.users(id) on delete set null,
  updated_at     timestamptz not null default now(),
  unique (student_id, term, academic_year)
);

-- ── tests ─────────────────────────────────────────────────────────────────────
create table if not exists public.tests (
  id          uuid primary key default uuid_generate_v4(),
  title       text not null,
  subject     text not null,
  class_name  text not null,
  section     text not null,
  term        text not null,
  date        date not null,
  school_id   uuid not null references public.schools(id) on delete cascade,
  created_by  uuid not null references public.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- ── test_questions ────────────────────────────────────────────────────────────
create table if not exists public.test_questions (
  id              uuid primary key default uuid_generate_v4(),
  test_id         uuid not null references public.tests(id) on delete cascade,
  order_index     integer not null default 0,
  type            text not null check (type in ('mcq','theory')),
  text            text not null,
  marks           numeric(5,2) not null,
  options         jsonb,           -- [{text: string}] × 4 for MCQ, null for theory
  correct_option  integer,         -- 0-3 index for MCQ, null for theory
  created_at      timestamptz not null default now()
);

-- ── notifications ─────────────────────────────────────────────────────────────
create table if not exists public.notifications (
  id            uuid primary key default uuid_generate_v4(),
  title         text not null,
  body          text not null,
  type          text not null check (type in ('announcement','alert','reminder','grade','attendance')),
  recipient_id  uuid not null references public.users(id) on delete cascade,
  sender_id     uuid not null references public.users(id) on delete cascade,
  is_read       boolean not null default false,
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);

-- ── complaints ────────────────────────────────────────────────────────────────
create table if not exists public.complaints (
  id               uuid primary key default uuid_generate_v4(),
  subject          text not null,
  body             text not null,
  school_id        uuid not null references public.schools(id) on delete cascade,
  submitted_by     uuid not null references public.users(id) on delete cascade,
  student_id       uuid references public.students(id) on delete set null,
  status           text not null default 'pending' check (status in ('pending','reviewed','resolved')),
  resolution_note  text,
  reviewed_by      uuid references public.users(id) on delete set null,
  reviewed_at      timestamptz,
  created_at       timestamptz not null default now()
);

-- ── invites ───────────────────────────────────────────────────────────────────
-- Used for parent self-registration via invite link.
create table if not exists public.invites (
  id          uuid primary key default uuid_generate_v4(),
  token       text not null unique,
  email       text not null,
  role        text not null default 'parent',
  school_id   uuid not null references public.schools(id) on delete cascade,
  used_at     timestamptz,
  used_by     uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- ── audit_logs ────────────────────────────────────────────────────────────────
create table if not exists public.audit_logs (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references public.users(id) on delete set null,
  action      text not null,
  table_name  text,
  details     jsonb,
  created_at  timestamptz not null default now()
);

-- ── notification_queue ────────────────────────────────────────────────────────
-- Delayed FCM push notifications (sent 30 min after RFID scan).
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

-- ── parent_students ───────────────────────────────────────────────────────────
-- Junction table linking parents to multiple students.
create table if not exists public.parent_students (
  parent_id   uuid not null references public.users(id) on delete cascade,
  student_id  uuid not null references public.students(id) on delete cascade,
  primary key (parent_id, student_id)
);

-- ── subjects ─────────────────────────────────────────────────────────────────
-- School subject catalogue used by admin route.
create table if not exists public.subjects (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  school_id   uuid not null references public.schools(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (school_id, name)
);

-- ── announcements ─────────────────────────────────────────────────────────────
create table if not exists public.announcements (
  id            uuid primary key default uuid_generate_v4(),
  title         text not null,
  message       text not null,
  target_class  text,
  school_id     uuid not null references public.schools(id) on delete cascade,
  created_by    uuid not null references public.users(id) on delete cascade,
  created_at    timestamptz not null default now()
);

-- ── Row Level Security ────────────────────────────────────────────────────────
-- Enable RLS on all tables. The backend uses the service-role key which bypasses
-- RLS, so these policies protect direct client access only.

alter table public.users             enable row level security;
alter table public.schools           enable row level security;
alter table public.school_settings   enable row level security;
alter table public.students          enable row level security;
alter table public.teacher_assignments enable row level security;
alter table public.attendance        enable row level security;
alter table public.marks             enable row level security;
alter table public.student_fees      enable row level security;
alter table public.tests             enable row level security;
alter table public.test_questions    enable row level security;
alter table public.notifications     enable row level security;
alter table public.complaints        enable row level security;
alter table public.invites           enable row level security;
alter table public.audit_logs        enable row level security;
alter table public.notification_queue enable row level security;
alter table public.parent_students   enable row level security;
alter table public.subjects          enable row level security;
alter table public.announcements     enable row level security;

-- Deny all direct client access (backend uses service role key, bypasses RLS)
create policy "deny_all_users"             on public.users             for all using (false);
create policy "deny_all_schools"           on public.schools           for all using (false);
create policy "deny_all_school_settings"   on public.school_settings   for all using (false);
create policy "deny_all_students"          on public.students          for all using (false);
create policy "deny_all_assignments"       on public.teacher_assignments for all using (false);
create policy "deny_all_attendance"        on public.attendance        for all using (false);
create policy "deny_all_marks"             on public.marks             for all using (false);
create policy "deny_all_fees"              on public.student_fees      for all using (false);
create policy "deny_all_tests"             on public.tests             for all using (false);
create policy "deny_all_test_questions"    on public.test_questions    for all using (false);
create policy "deny_all_notifications"     on public.notifications     for all using (false);
create policy "deny_all_complaints"        on public.complaints        for all using (false);
create policy "deny_all_invites"           on public.invites           for all using (false);
create policy "deny_all_audit_logs"        on public.audit_logs        for all using (false);
create policy "deny_all_notification_queue" on public.notification_queue for all using (false);
create policy "deny_all_parent_students"   on public.parent_students   for all using (false);
create policy "deny_all_subjects"          on public.subjects          for all using (false);
create policy "deny_all_announcements"     on public.announcements     for all using (false);

-- ── Indexes ───────────────────────────────────────────────────────────────────
create index if not exists idx_users_school_id          on public.users(school_id);
create index if not exists idx_users_role               on public.users(role);
create index if not exists idx_students_school_id       on public.students(school_id);
create index if not exists idx_students_class_section   on public.students(class_name, section);
create index if not exists idx_students_parent_id       on public.students(parent_id);
create index if not exists idx_students_rfid_uid        on public.students(rfid_uid) where rfid_uid is not null;
create index if not exists idx_students_is_deleted      on public.students(school_id, is_deleted);
create index if not exists idx_attendance_student_date  on public.attendance(student_id, date);
create index if not exists idx_attendance_date          on public.attendance(date);
create index if not exists idx_marks_student_id         on public.marks(student_id);
create index if not exists idx_marks_subject_term       on public.marks(subject, term);
create index if not exists idx_fees_student_id          on public.student_fees(student_id);
create index if not exists idx_tests_school_class       on public.tests(school_id, class_name, section);
create index if not exists idx_test_questions_test_id   on public.test_questions(test_id);
create index if not exists idx_notifications_recipient  on public.notifications(recipient_id);
create index if not exists idx_complaints_school_status on public.complaints(school_id, status);
create index if not exists idx_assignments_teacher      on public.teacher_assignments(teacher_id);
create index if not exists idx_audit_logs_user_id       on public.audit_logs(user_id);
create index if not exists idx_audit_logs_created_at    on public.audit_logs(created_at desc);
create index if not exists idx_audit_logs_table_name    on public.audit_logs(table_name);
create index if not exists idx_schools_subscription     on public.schools(subscription_status);
create index if not exists idx_notification_queue_send  on public.notification_queue(send_after)
  where sent = false and cancelled = false;
create index if not exists idx_announcements_school     on public.announcements(school_id, created_at desc);
