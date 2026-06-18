/// <reference types="node" />
/**
 * seed.ts — Comprehensive test data seeder for Eduvo.
 *
 * Run with:
 *   npx ts-node src/scripts/seed.ts
 *
 * Safe to re-run: uses skip logic for anything that already exists.
 * Does NOT recreate: superadmin@eduvo.com, schooladmin@eduvo.com, teacher@eduvo.com
 *
 * CHANGES (latest):
 *   - REMOVED: parent user accounts, parent_students records, rfid_uid/nfc_id data
 *   - UPDATED students: phone_number (Indian 98XXXXXXXX), date_of_birth (age 12-18),
 *     password_hash (bcrypt of last 5 digits), is_first_login (false for most, true for 2),
 *     fcm_token: null
 *   - ADDED: full week timetable for Class 10A, 10B, 9A
 *   - ADDED: 5 homework items for Class 10A (2 pending, 2 completed, 1 due today)
 *   - ADDED: homework acknowledgements (3 students per homework)
 *   - ADDED: 4 complaints (2 to class_teacher, 2 to school_admin, mixed statuses)
 *   - ADDED: 2 marks import session audit log entries for teacher
 */

import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { supabaseAdmin } from '../config/supabase';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function logAudit(
  userId: string,
  action: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  const { error } = await supabaseAdmin.from('audit_logs').insert({
    user_id: userId,
    action,
    details,
    created_at: new Date().toISOString(),
  });
  if (error) console.warn(`  [audit] ${error.message}`);
}

async function getUserIdByEmail(email: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('email', email)
    .maybeSingle();
  return data?.id ?? null;
}

/** Returns a date string YYYY-MM-DD offset by `daysAgo` from today. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

/** Returns a date string YYYY-MM-DD offset by `daysFromNow` into the future. */
function daysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

/** Returns today's date as YYYY-MM-DD. */
function today(): string {
  return new Date().toISOString().split('T')[0];
}

/** Returns a date string YYYY-MM-DD for a specific weekday of the current week.
 *  0 = Monday, 1 = Tuesday, ..., 4 = Friday */
function currentWeekDay(dayOffset: number): string {
  const d = new Date();
  const day = d.getDay();
  const diffToMonday = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diffToMonday + dayOffset);
  return d.toISOString().split('T')[0];
}

/** Shuffle array (Fisher-Yates) and return new array. */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Hash a password with bcrypt (12 rounds). */
async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SUBJECTS = ['Maths', 'Science', 'English', 'Hindi', 'Gujarati'];

const SCHOOLS = [
  { name: 'Test School',   address: '123 Test Street, Test City' },
  { name: 'Demo Coaching', address: '456 Demo Avenue, Demo City' },
];

// ── Student definitions with phone numbers ────────────────────────────────────
// Phone format: 98XXXXXXXX (10 digits, Indian mobile)
// Password = last 5 digits of phone_number
// is_first_login = true for students at index 3 and 4 (0-based) in testStudentDefs

interface StudentDef {
  full_name: string;
  class: string;
  section: string;
  roll_number: string;
  phone_number: string;
  date_of_birth: string; // YYYY-MM-DD, age 12-18
  is_first_login: boolean;
}

const TEST_STUDENT_DEFS: StudentDef[] = [
  // Class 10A — 5 students
  {
    full_name: 'Rahul Sharma',
    class: '10', section: 'A', roll_number: '10A01',
    phone_number: '9812345678',
    date_of_birth: '2009-03-15',
    is_first_login: false,
  },
  {
    full_name: 'Priya Patel',
    class: '10', section: 'A', roll_number: '10A02',
    phone_number: '9823456789',
    date_of_birth: '2009-07-22',
    is_first_login: false,
  },
  {
    full_name: 'Sneha Desai',
    class: '10', section: 'A', roll_number: '10A03',
    phone_number: '9834567890',
    date_of_birth: '2008-11-08',
    is_first_login: false,
  },
  {
    full_name: 'Arjun Nair',
    class: '10', section: 'A', roll_number: '10A04',
    phone_number: '9845678901',  // is_first_login = true
    date_of_birth: '2009-01-30',
    is_first_login: true,
  },
  {
    full_name: 'Meera Iyer',
    class: '10', section: 'A', roll_number: '10A05',
    phone_number: '9856789012',  // is_first_login = true
    date_of_birth: '2008-09-14',
    is_first_login: true,
  },
  // Class 10B — 5 students
  {
    full_name: 'Rahul Verma',
    class: '10', section: 'B', roll_number: '10B01',
    phone_number: '9867890123',
    date_of_birth: '2009-05-20',
    is_first_login: false,
  },
  {
    full_name: 'Pooja Agarwal',
    class: '10', section: 'B', roll_number: '10B02',
    phone_number: '9878901234',
    date_of_birth: '2008-12-03',
    is_first_login: false,
  },
  {
    full_name: 'Siddharth Bose',
    class: '10', section: 'B', roll_number: '10B03',
    phone_number: '9889012345',
    date_of_birth: '2009-08-17',
    is_first_login: false,
  },
  {
    full_name: 'Kavya Reddy',
    class: '10', section: 'B', roll_number: '10B04',
    phone_number: '9890123456',
    date_of_birth: '2008-04-25',
    is_first_login: false,
  },
  {
    full_name: 'Nikhil Tiwari',
    class: '10', section: 'B', roll_number: '10B05',
    phone_number: '9801234567',
    date_of_birth: '2009-10-11',
    is_first_login: false,
  },
  // Class 9A — 5 students
  {
    full_name: 'Arjun Shah',
    class: '9', section: 'A', roll_number: '9A01',
    phone_number: '9811223344',
    date_of_birth: '2010-02-28',
    is_first_login: false,
  },
  {
    full_name: 'Diya Patel',
    class: '9', section: 'A', roll_number: '9A02',
    phone_number: '9822334455',
    date_of_birth: '2010-06-15',
    is_first_login: false,
  },
  {
    full_name: 'Rohan Mehta',
    class: '9', section: 'A', roll_number: '9A03',
    phone_number: '9833445566',
    date_of_birth: '2010-09-07',
    is_first_login: false,
  },
  {
    full_name: 'Priya Singh',
    class: '9', section: 'A', roll_number: '9A04',
    phone_number: '9844556677',
    date_of_birth: '2011-01-19',
    is_first_login: false,
  },
  {
    full_name: 'Karan Joshi',
    class: '9', section: 'A', roll_number: '9A05',
    phone_number: '9855667788',
    date_of_birth: '2010-11-30',
    is_first_login: false,
  },
];

// ── Step 1: Seed schools ──────────────────────────────────────────────────────

async function seedSchools(): Promise<Record<string, string>> {
  console.log('\n── Schools ──────────────────────────────────────────────────');
  const ids: Record<string, string> = {};

  for (const school of SCHOOLS) {
    const { data: existing } = await supabaseAdmin
      .from('schools')
      .select('id')
      .eq('name', school.name)
      .maybeSingle();

    if (existing) {
      console.log(`  [skip] "${school.name}" already exists (id: ${existing.id})`);
      ids[school.name] = existing.id as string;
      continue;
    }

    const { data, error } = await supabaseAdmin
      .from('schools')
      .insert({ name: school.name, address: school.address })
      .select('id')
      .single();

    if (error || !data) throw new Error(`Failed to create school "${school.name}": ${error?.message}`);
    console.log(`  [done] Created "${school.name}" (id: ${data.id})`);
    ids[school.name] = data.id as string;
  }

  return ids;
}

// ── Step 2: Seed subjects ─────────────────────────────────────────────────────

async function seedSubjects(schoolId: string): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};

  for (const name of SUBJECTS) {
    const { data: existing } = await supabaseAdmin
      .from('subjects')
      .select('id')
      .eq('school_id', schoolId)
      .eq('name', name)
      .maybeSingle();

    if (existing) {
      ids[name] = existing.id as string;
      continue;
    }

    const { data, error } = await supabaseAdmin
      .from('subjects')
      .insert({ name, school_id: schoolId })
      .select('id')
      .single();

    if (error || !data) throw new Error(`Failed to create subject "${name}": ${error?.message}`);
    ids[name] = data.id as string;
  }

  console.log(`  [done] Subjects seeded for school ${schoolId}`);
  return ids;
}

// ── Step 3: Seed admin2@eduvo.com (Demo Coaching school admin) ────────────────

async function seedAdmin2(schoolId: string, superAdminId: string): Promise<string> {
  console.log('\n── admin2@eduvo.com (Demo Coaching school admin) ────────────');
  const email = 'admin2@eduvo.com';

  const existingId = await getUserIdByEmail(email);
  if (existingId) {
    console.log(`  [skip] ${email} already exists (id: ${existingId})`);
    return existingId;
  }

  const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password: 'Test@1234',
    email_confirm: true,
  });

  if (authErr || !authData?.user) throw new Error(`Auth creation failed for ${email}: ${authErr?.message}`);
  const userId = authData.user.id;

  const { error: profileErr } = await supabaseAdmin.from('users').insert({
    id: userId,
    name: 'Demo Admin',
    email,
    role: 'schooladmin',
    school_id: schoolId,
    created_by: superAdminId,
  });

  if (profileErr) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Profile insert failed for ${email}: ${profileErr.message}`);
  }

  await logAudit(userId, 'SEED_USER_CREATED', { email, role: 'schooladmin' });
  console.log(`  [done] Created ${email} (id: ${userId})`);
  return userId;
}

// ── Step 4: Seed teachers ─────────────────────────────────────────────────────

interface TeacherDef {
  email: string;
  name: string;
  assignments: { subject: string; class: string; section: string }[];
}

async function seedTeachers(
  schoolId: string,
  schoolAdminId: string,
  teacherDefs: TeacherDef[]
): Promise<Record<string, string>> {
  console.log('\n── Teachers ─────────────────────────────────────────────────');
  const ids: Record<string, string> = {};

  for (const def of teacherDefs) {
    let userId = await getUserIdByEmail(def.email);

    if (userId) {
      console.log(`  [skip] ${def.email} already exists (id: ${userId})`);
    } else {
      const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
        email: def.email,
        password: 'Test@1234',
        email_confirm: true,
      });

      if (authErr || !authData?.user) throw new Error(`Auth creation failed for ${def.email}: ${authErr?.message}`);
      userId = authData.user.id;

      const { error: profileErr } = await supabaseAdmin.from('users').insert({
        id: userId,
        name: def.name,
        email: def.email,
        role: 'teacher',
        school_id: schoolId,
        created_by: schoolAdminId,
      });

      if (profileErr) {
        await supabaseAdmin.auth.admin.deleteUser(userId);
        throw new Error(`Profile insert failed for ${def.email}: ${profileErr.message}`);
      }

      await logAudit(userId, 'SEED_USER_CREATED', { email: def.email, role: 'teacher' });
      console.log(`  [done] Created teacher ${def.email} (id: ${userId})`);
    }

    ids[def.email] = userId;

    for (const a of def.assignments) {
      const { data: existing } = await supabaseAdmin
        .from('teacher_assignments')
        .select('id')
        .eq('teacher_id', userId)
        .eq('school_id', schoolId)
        .eq('class_name', a.class)
        .eq('section', a.section)
        .eq('subject', a.subject)
        .maybeSingle();

      if (existing) continue;

      const { error } = await supabaseAdmin.from('teacher_assignments').insert({
        teacher_id: userId,
        school_id: schoolId,
        class_name: a.class,
        section: a.section,
        subject: a.subject,
      });

      if (error) console.warn(`  [warn] Assignment insert: ${error.message}`);
      else console.log(`    → Assigned ${a.subject} / ${a.class} ${a.section}`);
    }
  }

  return ids;
}

// ── Step 5: Seed students (phone-based login, no parent accounts) ─────────────

async function seedStudents(
  schoolId: string,
  studentDefs: StudentDef[]
): Promise<string[]> {
  console.log('\n── Students ─────────────────────────────────────────────────');
  const ids: string[] = [];

  for (const def of studentDefs) {
    // Check by phone_number (unique login identifier)
    const { data: existing } = await supabaseAdmin
      .from('students')
      .select('id')
      .eq('school_id', schoolId)
      .eq('phone_number', def.phone_number)
      .maybeSingle();

    if (existing) {
      console.log(`  [skip] Student "${def.full_name}" (${def.phone_number}) already exists`);
      ids.push(existing.id as string);
      continue;
    }

    // Default password = last 5 digits of phone_number
    const defaultPassword = def.phone_number.slice(-5);
    const passwordHash = await hashPassword(defaultPassword);

    const { data: student, error } = await supabaseAdmin
      .from('students')
      .insert({
        full_name: def.full_name,
        name: def.full_name,          // keep name column in sync
        class_name: def.class,
        section: def.section,
        roll_number: def.roll_number,
        phone_number: def.phone_number,
        phone: def.phone_number,      // keep legacy phone column in sync
        date_of_birth: def.date_of_birth,
        password_hash: passwordHash,
        is_first_login: def.is_first_login,
        fcm_token: null,
        school_id: schoolId,
        is_deleted: false,
      })
      .select('id')
      .single();

    if (error || !student) {
      console.warn(`  [warn] Failed to create student "${def.full_name}": ${error?.message}`);
      continue;
    }

    // Set qr_code = student id
    await supabaseAdmin.from('students').update({ qr_code: student.id }).eq('id', student.id);

    ids.push(student.id as string);
    console.log(`  [done] ${def.full_name} (${def.class}${def.section}) phone: ${def.phone_number} pwd: ${defaultPassword} first_login: ${def.is_first_login}`);
  }

  return ids;
}

// ── Step 6: Seed attendance (historical 30-day records) ───────────────────────

async function seedAttendance(
  studentIds: string[],
  recordedById: string
): Promise<void> {
  console.log('\n── Attendance (historical) ──────────────────────────────────');

  for (const studentId of studentIds) {
    const statuses: ('present' | 'absent')[] = [
      ...Array(22).fill('present'),
      ...Array(8).fill('absent'),
    ];
    const shuffled = shuffle(statuses) as ('present' | 'absent')[];

    const rows = shuffled.map((status, i) => ({
      student_id: studentId,
      date: daysAgo(30 - i),
      status,
      source: 'manual' as const,
      recorded_by: recordedById,
    }));

    const { count } = await supabaseAdmin
      .from('attendance')
      .select('id', { count: 'exact', head: true })
      .eq('student_id', studentId);

    if ((count ?? 0) >= 30) {
      console.log(`  [skip] Attendance already seeded for student ${studentId}`);
      continue;
    }

    const { error } = await supabaseAdmin
      .from('attendance')
      .upsert(rows, { onConflict: 'student_id,date', ignoreDuplicates: true });

    if (error) console.warn(`  [warn] Attendance insert: ${error.message}`);
    else console.log(`  [done] 30 records for student ${studentId}`);
  }
}

// ── Step 6b: Seed current-week attendance submissions ────────────────────────

async function seedWeeklyAttendance(
  class10AStudentIds: string[],
  class10BStudentIds: string[],
  recordedById: string
): Promise<void> {
  console.log('\n── Attendance (current week submissions) ────────────────────');

  const class10ADays = [0, 1, 2, 3, 4];
  const class10BDays = [0, 1, 2, 3];

  const absentPatterns10A: number[][] = [
    [0, 1], [2, 3, 4], [1, 3], [0, 2, 4], [1, 2],
  ];
  const absentPatterns10B: number[][] = [
    [0, 1], [2, 3], [1, 4], [0, 2, 3],
  ];

  async function submitDay(
    studentIds: string[],
    dayOffset: number,
    absentIndices: number[],
    label: string
  ): Promise<void> {
    const date = currentWeekDay(dayOffset);
    const absentSet = new Set(absentIndices.map((i) => studentIds[i]).filter(Boolean));

    const { count: existing } = await supabaseAdmin
      .from('attendance')
      .select('id', { count: 'exact', head: true })
      .in('student_id', studentIds)
      .eq('date', date);

    if ((existing ?? 0) > 0) {
      console.log(`  [skip] ${label} attendance for ${date} already exists`);
      return;
    }

    const rows = studentIds.map((id) => ({
      student_id: id,
      date,
      status: absentSet.has(id) ? 'absent' : 'present',
      source: 'manual' as const,
      recorded_by: recordedById,
      notification_sent: true,
    }));

    const { error } = await supabaseAdmin
      .from('attendance')
      .upsert(rows, { onConflict: 'student_id,date', ignoreDuplicates: true });

    if (error) console.warn(`  [warn] ${label} ${date}: ${error.message}`);
    else {
      const absentCount = rows.filter((r) => r.status === 'absent').length;
      console.log(`  [done] ${label} ${date} — ${rows.length - absentCount} present, ${absentCount} absent`);
    }
  }

  for (let i = 0; i < class10ADays.length; i++) {
    await submitDay(class10AStudentIds, class10ADays[i], absentPatterns10A[i], 'Class 10A');
  }
  for (let i = 0; i < class10BDays.length; i++) {
    await submitDay(class10BStudentIds, class10BDays[i], absentPatterns10B[i], 'Class 10B');
  }
  console.log('  [info] Class 10B Friday attendance NOT submitted (pending state for testing)');
}

// ── Step 7: Seed fees ─────────────────────────────────────────────────────────
// Student 0 (Rahul Sharma / 10A01) → fee PAID
// Student 1 (Priya Patel / 10A02)  → fee NOT PAID
// All others → paid

async function seedFees(
  studentIds: string[],
  schoolId: string,
  updatedById: string,
  unpaidIndices: number[] = [1]
): Promise<void> {
  console.log('\n── Fees ─────────────────────────────────────────────────────');

  for (let i = 0; i < studentIds.length; i++) {
    const studentId = studentIds[i];
    const feePaid = !unpaidIndices.includes(i);

    const { data: existing } = await supabaseAdmin
      .from('student_fees')
      .select('id')
      .eq('student_id', studentId)
      .eq('term', 'Term 1')
      .eq('academic_year', '2025-26')
      .maybeSingle();

    if (existing) {
      console.log(`  [skip] Fee record already exists for student ${studentId}`);
      continue;
    }

    const { error } = await supabaseAdmin.from('student_fees').insert({
      student_id: studentId,
      term: 'Term 1',
      academic_year: '2025-26',
      fee_paid: feePaid,
      school_id: schoolId,
      updated_by: updatedById,
    });

    if (error) console.warn(`  [warn] Fee insert: ${error.message}`);
    else console.log(`  [done] Student ${studentId} fee_paid=${feePaid}`);
  }
}

// ── Step 8: Seed timetable ────────────────────────────────────────────────────
// Full week for Class 10A, 10B (same pattern), and 9A (slightly different times)

interface PeriodDef {
  day_of_week: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';
  period_number: number;
  start_time: string;
  end_time: string;
  subject: string;
}

// Class 10A / 10B timetable — 5 periods Mon-Fri, 4 periods Saturday
const TIMETABLE_10: PeriodDef[] = [
  // Monday
  { day_of_week: 'monday',    period_number: 1, start_time: '08:00', end_time: '08:45', subject: 'Maths' },
  { day_of_week: 'monday',    period_number: 2, start_time: '08:45', end_time: '09:30', subject: 'Science' },
  { day_of_week: 'monday',    period_number: 3, start_time: '09:45', end_time: '10:30', subject: 'English' },
  { day_of_week: 'monday',    period_number: 4, start_time: '10:30', end_time: '11:15', subject: 'Hindi' },
  { day_of_week: 'monday',    period_number: 5, start_time: '11:30', end_time: '12:15', subject: 'Gujarati' },
  // Tuesday
  { day_of_week: 'tuesday',   period_number: 1, start_time: '08:00', end_time: '08:45', subject: 'Science' },
  { day_of_week: 'tuesday',   period_number: 2, start_time: '08:45', end_time: '09:30', subject: 'English' },
  { day_of_week: 'tuesday',   period_number: 3, start_time: '09:45', end_time: '10:30', subject: 'Maths' },
  { day_of_week: 'tuesday',   period_number: 4, start_time: '10:30', end_time: '11:15', subject: 'Gujarati' },
  { day_of_week: 'tuesday',   period_number: 5, start_time: '11:30', end_time: '12:15', subject: 'Hindi' },
  // Wednesday
  { day_of_week: 'wednesday', period_number: 1, start_time: '08:00', end_time: '08:45', subject: 'English' },
  { day_of_week: 'wednesday', period_number: 2, start_time: '08:45', end_time: '09:30', subject: 'Maths' },
  { day_of_week: 'wednesday', period_number: 3, start_time: '09:45', end_time: '10:30', subject: 'Hindi' },
  { day_of_week: 'wednesday', period_number: 4, start_time: '10:30', end_time: '11:15', subject: 'Science' },
  { day_of_week: 'wednesday', period_number: 5, start_time: '11:30', end_time: '12:15', subject: 'Gujarati' },
  // Thursday
  { day_of_week: 'thursday',  period_number: 1, start_time: '08:00', end_time: '08:45', subject: 'Hindi' },
  { day_of_week: 'thursday',  period_number: 2, start_time: '08:45', end_time: '09:30', subject: 'Gujarati' },
  { day_of_week: 'thursday',  period_number: 3, start_time: '09:45', end_time: '10:30', subject: 'Science' },
  { day_of_week: 'thursday',  period_number: 4, start_time: '10:30', end_time: '11:15', subject: 'Maths' },
  { day_of_week: 'thursday',  period_number: 5, start_time: '11:30', end_time: '12:15', subject: 'English' },
  // Friday
  { day_of_week: 'friday',    period_number: 1, start_time: '08:00', end_time: '08:45', subject: 'Gujarati' },
  { day_of_week: 'friday',    period_number: 2, start_time: '08:45', end_time: '09:30', subject: 'Hindi' },
  { day_of_week: 'friday',    period_number: 3, start_time: '09:45', end_time: '10:30', subject: 'Maths' },
  { day_of_week: 'friday',    period_number: 4, start_time: '10:30', end_time: '11:15', subject: 'English' },
  { day_of_week: 'friday',    period_number: 5, start_time: '11:30', end_time: '12:15', subject: 'Science' },
  // Saturday — 4 periods only
  { day_of_week: 'saturday',  period_number: 1, start_time: '08:00', end_time: '08:45', subject: 'Maths' },
  { day_of_week: 'saturday',  period_number: 2, start_time: '08:45', end_time: '09:30', subject: 'Science' },
  { day_of_week: 'saturday',  period_number: 3, start_time: '09:45', end_time: '10:30', subject: 'English' },
  { day_of_week: 'saturday',  period_number: 4, start_time: '10:30', end_time: '11:15', subject: 'Hindi' },
];

// Class 9A — slightly different start times (09:00 base)
const TIMETABLE_9A: PeriodDef[] = [
  { day_of_week: 'monday',    period_number: 1, start_time: '09:00', end_time: '09:45', subject: 'Hindi' },
  { day_of_week: 'monday',    period_number: 2, start_time: '09:45', end_time: '10:30', subject: 'Gujarati' },
  { day_of_week: 'monday',    period_number: 3, start_time: '10:45', end_time: '11:30', subject: 'Maths' },
  { day_of_week: 'monday',    period_number: 4, start_time: '11:30', end_time: '12:15', subject: 'Science' },
  { day_of_week: 'monday',    period_number: 5, start_time: '12:30', end_time: '13:15', subject: 'English' },
  { day_of_week: 'tuesday',   period_number: 1, start_time: '09:00', end_time: '09:45', subject: 'Maths' },
  { day_of_week: 'tuesday',   period_number: 2, start_time: '09:45', end_time: '10:30', subject: 'English' },
  { day_of_week: 'tuesday',   period_number: 3, start_time: '10:45', end_time: '11:30', subject: 'Gujarati' },
  { day_of_week: 'tuesday',   period_number: 4, start_time: '11:30', end_time: '12:15', subject: 'Hindi' },
  { day_of_week: 'tuesday',   period_number: 5, start_time: '12:30', end_time: '13:15', subject: 'Science' },
  { day_of_week: 'wednesday', period_number: 1, start_time: '09:00', end_time: '09:45', subject: 'Science' },
  { day_of_week: 'wednesday', period_number: 2, start_time: '09:45', end_time: '10:30', subject: 'Maths' },
  { day_of_week: 'wednesday', period_number: 3, start_time: '10:45', end_time: '11:30', subject: 'English' },
  { day_of_week: 'wednesday', period_number: 4, start_time: '11:30', end_time: '12:15', subject: 'Gujarati' },
  { day_of_week: 'wednesday', period_number: 5, start_time: '12:30', end_time: '13:15', subject: 'Hindi' },
  { day_of_week: 'thursday',  period_number: 1, start_time: '09:00', end_time: '09:45', subject: 'English' },
  { day_of_week: 'thursday',  period_number: 2, start_time: '09:45', end_time: '10:30', subject: 'Science' },
  { day_of_week: 'thursday',  period_number: 3, start_time: '10:45', end_time: '11:30', subject: 'Hindi' },
  { day_of_week: 'thursday',  period_number: 4, start_time: '11:30', end_time: '12:15', subject: 'Maths' },
  { day_of_week: 'thursday',  period_number: 5, start_time: '12:30', end_time: '13:15', subject: 'Gujarati' },
  { day_of_week: 'friday',    period_number: 1, start_time: '09:00', end_time: '09:45', subject: 'Gujarati' },
  { day_of_week: 'friday',    period_number: 2, start_time: '09:45', end_time: '10:30', subject: 'Hindi' },
  { day_of_week: 'friday',    period_number: 3, start_time: '10:45', end_time: '11:30', subject: 'Science' },
  { day_of_week: 'friday',    period_number: 4, start_time: '11:30', end_time: '12:15', subject: 'English' },
  { day_of_week: 'friday',    period_number: 5, start_time: '12:30', end_time: '13:15', subject: 'Maths' },
  { day_of_week: 'saturday',  period_number: 1, start_time: '09:00', end_time: '09:45', subject: 'Maths' },
  { day_of_week: 'saturday',  period_number: 2, start_time: '09:45', end_time: '10:30', subject: 'Science' },
  { day_of_week: 'saturday',  period_number: 3, start_time: '10:45', end_time: '11:30', subject: 'Hindi' },
  { day_of_week: 'saturday',  period_number: 4, start_time: '11:30', end_time: '12:15', subject: 'Gujarati' },
];

async function seedTimetable(
  schoolId: string,
  className: string,
  section: string,
  periods: PeriodDef[],
  subjectIds: Record<string, string>,
  teacherIdBySubject: Record<string, string>,
  createdById: string
): Promise<void> {
  console.log(`\n── Timetable ${className}${section} ──────────────────────────────────────`);

  // Check if timetable already exists for this class
  const { count: existing } = await supabaseAdmin
    .from('timetable')
    .select('id', { count: 'exact', head: true })
    .eq('school_id', schoolId)
    .eq('class_name', className)
    .eq('section', section);

  if ((existing ?? 0) > 0) {
    console.log(`  [skip] Timetable for ${className}${section} already exists (${existing} periods)`);
    return;
  }

  const rows = periods.map((p) => ({
    school_id: schoolId,
    class_name: className,
    section,
    day_of_week: p.day_of_week,
    period_number: p.period_number,
    start_time: p.start_time,
    end_time: p.end_time,
    subject_id: subjectIds[p.subject],
    teacher_id: teacherIdBySubject[p.subject] ?? createdById,
    created_by: createdById,
    created_at: new Date().toISOString(),
  }));

  // Filter out any rows where subject_id is missing
  const validRows = rows.filter((r) => r.subject_id);
  const skipped = rows.length - validRows.length;
  if (skipped > 0) console.warn(`  [warn] Skipped ${skipped} periods with missing subject_id`);

  const { error } = await supabaseAdmin.from('timetable').insert(validRows);
  if (error) console.warn(`  [warn] Timetable insert for ${className}${section}: ${error.message}`);
  else console.log(`  [done] ${validRows.length} periods inserted for ${className}${section}`);
}

// ── Step 9: Seed homework for Class 10A ───────────────────────────────────────
// 5 items: 2 pending (future due), 2 completed (past due), 1 due today
// 3 students acknowledge each homework

async function seedHomework(
  schoolId: string,
  subjectIds: Record<string, string>,
  teacherIdBySubject: Record<string, string>,
  class10AStudentIds: string[],
  createdById: string
): Promise<void> {
  console.log('\n── Homework (Class 10A) ─────────────────────────────────────');

  interface HomeworkDef {
    title: string;
    description: string;
    subject: string;
    due_date: string;
    label: string;
  }

  const homeworkDefs: HomeworkDef[] = [
    {
      title: 'Algebra Practice Set',
      description: 'Complete exercises 5.1 to 5.4 from the textbook.',
      subject: 'Maths',
      due_date: daysFromNow(5),
      label: 'pending (future)',
    },
    {
      title: 'Newton\'s Laws Essay',
      description: 'Write a 300-word essay on Newton\'s three laws of motion with examples.',
      subject: 'Science',
      due_date: daysFromNow(3),
      label: 'pending (future)',
    },
    {
      title: 'Grammar Worksheet',
      description: 'Complete the tenses worksheet on pages 42-44.',
      subject: 'English',
      due_date: daysAgo(7),
      label: 'completed (past)',
    },
    {
      title: 'Hindi Poem Recitation',
      description: 'Memorise and write the poem "Nadi" from chapter 3.',
      subject: 'Hindi',
      due_date: daysAgo(3),
      label: 'completed (past)',
    },
    {
      title: 'Gujarati Nibandh',
      description: 'Write a short essay on "Mara Sapna nu Bharat" (200 words).',
      subject: 'Gujarati',
      due_date: today(),
      label: 'due today',
    },
  ];

  const homeworkIds: string[] = [];

  for (const def of homeworkDefs) {
    const subjectId = subjectIds[def.subject];
    if (!subjectId) {
      console.warn(`  [warn] Subject "${def.subject}" not found — skipping homework "${def.title}"`);
      continue;
    }

    const { data: existing } = await supabaseAdmin
      .from('homework')
      .select('id')
      .eq('school_id', schoolId)
      .eq('title', def.title)
      .eq('class_name', '10')
      .eq('section', 'A')
      .maybeSingle();

    if (existing) {
      console.log(`  [skip] Homework "${def.title}" already exists`);
      homeworkIds.push(existing.id as string);
      continue;
    }

    const teacherId = teacherIdBySubject[def.subject] ?? createdById;

    const { data: hw, error } = await supabaseAdmin
      .from('homework')
      .insert({
        school_id: schoolId,
        subject_id: subjectId,
        class_name: '10',
        section: 'A',
        title: def.title,
        description: def.description,
        due_date: def.due_date,
        created_by: teacherId,
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error || !hw) {
      console.warn(`  [warn] Homework insert "${def.title}": ${error?.message}`);
      continue;
    }

    homeworkIds.push(hw.id as string);
    console.log(`  [done] "${def.title}" — ${def.label} (due: ${def.due_date})`);
  }

  // Seed acknowledgements: 3 students per homework
  console.log('\n── Homework Acknowledgements ────────────────────────────────');
  const ackStudents = class10AStudentIds.slice(0, 3);

  for (const hwId of homeworkIds) {
    for (const studentId of ackStudents) {
      const { data: existingAck } = await supabaseAdmin
        .from('homework_acknowledgements')
        .select('id')
        .eq('homework_id', hwId)
        .eq('student_id', studentId)
        .maybeSingle();

      if (existingAck) continue;

      const { error } = await supabaseAdmin.from('homework_acknowledgements').insert({
        homework_id: hwId,
        student_id: studentId,
        acknowledged_at: new Date().toISOString(),
      });

      if (error) console.warn(`  [warn] Ack insert: ${error.message}`);
    }
    console.log(`  [done] 3 acknowledgements for homework ${hwId}`);
  }
}

// ── Step 10: Seed complaints ──────────────────────────────────────────────────
// 2 to class_teacher, 2 to school_admin — mix of pending and resolved

async function seedComplaints(
  schoolId: string,
  studentIds: string[],
  teacherId: string,
  schoolAdminId: string
): Promise<void> {
  console.log('\n── Complaints ───────────────────────────────────────────────');

  interface ComplaintDef {
    subject: string;
    message: string;
    recipient_type: 'class_teacher' | 'school_admin';
    status: 'pending' | 'reviewed' | 'resolved';
    response_message: string | null;
    student_index: number;
  }

  const complaintDefs: ComplaintDef[] = [
    {
      subject: 'Homework overload',
      message: 'We are getting too much homework every day. It is affecting my health.',
      recipient_type: 'class_teacher',
      status: 'pending',
      response_message: null,
      student_index: 0,
    },
    {
      subject: 'Classroom noise issue',
      message: 'The classroom is very noisy during self-study periods. Hard to concentrate.',
      recipient_type: 'class_teacher',
      status: 'resolved',
      response_message: 'Thank you for bringing this up. We have assigned a monitor for self-study periods.',
      student_index: 2,
    },
    {
      subject: 'Fee receipt not received',
      message: 'I paid the Term 1 fees last week but have not received a receipt yet.',
      recipient_type: 'school_admin',
      status: 'pending',
      response_message: null,
      student_index: 1,
    },
    {
      subject: 'Canteen food quality',
      message: 'The canteen food quality has gone down recently. Please look into it.',
      recipient_type: 'school_admin',
      status: 'reviewed',
      response_message: 'We have noted your concern and will speak with the canteen vendor.',
      student_index: 3,
    },
  ];

  for (const def of complaintDefs) {
    const studentId = studentIds[def.student_index];
    if (!studentId) continue;

    const { data: existing } = await supabaseAdmin
      .from('complaints')
      .select('id')
      .eq('school_id', schoolId)
      .eq('subject', def.subject)
      .eq('student_id', studentId)
      .maybeSingle();

    if (existing) {
      console.log(`  [skip] Complaint "${def.subject}" already exists`);
      continue;
    }

    const insertData: Record<string, unknown> = {
      subject: def.subject,
      message: def.message,
      school_id: schoolId,
      student_id: studentId,
      recipient_type: def.recipient_type,
      teacher_id: def.recipient_type === 'class_teacher' ? teacherId : null,
      status: def.status,
      response_message: def.response_message,
      // complaints table also has a 'body' column (legacy) — keep in sync
      body: def.message,
      // submitted_by is required FK to users — use schoolAdminId as system placeholder
      // (students don't have a users row; this is a known limitation noted in the route)
      submitted_by: schoolAdminId,
    };

    if (def.status !== 'pending') {
      insertData.reviewed_by = def.recipient_type === 'class_teacher' ? teacherId : schoolAdminId;
      insertData.reviewed_at = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    }

    const { error } = await supabaseAdmin.from('complaints').insert(insertData);
    if (error) console.warn(`  [warn] Complaint insert "${def.subject}": ${error.message}`);
    else console.log(`  [done] "${def.subject}" → ${def.recipient_type} (${def.status})`);
  }
}

// ── Step 11: Seed marks import session audit logs ─────────────────────────────
// 2 completed bulk_marks_import entries in audit_logs for the teacher
// These show up in the import history on the web dashboard

async function seedMarksImportSessions(
  teacherId: string,
  schoolId: string
): Promise<void> {
  console.log('\n── Marks Import Sessions (audit_logs) ───────────────────────');

  const { count: existing } = await supabaseAdmin
    .from('audit_logs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', teacherId)
    .eq('action', 'bulk_marks_import');

  if ((existing ?? 0) >= 2) {
    console.log(`  [skip] Marks import sessions already seeded (${existing} found)`);
    return;
  }

  const sessions = [
    {
      action: 'bulk_marks_import',
      details: {
        count: 5,
        updated: 0,
        class: '10',
        section: 'A',
        subject: 'Maths',
        exam_type: 'unit_test',
        term: 'Term 1',
        test_name: 'Maths Unit Test 1',
        school_id: schoolId,
      },
      created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      action: 'bulk_marks_import',
      details: {
        count: 5,
        updated: 2,
        class: '10',
        section: 'A',
        subject: 'Science',
        exam_type: 'mid_term',
        term: 'Term 1',
        test_name: 'Science Mid-Term',
        school_id: schoolId,
      },
      created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ];

  for (const session of sessions) {
    const { error } = await supabaseAdmin.from('audit_logs').insert({
      user_id: teacherId,
      action: session.action,
      details: session.details,
      created_at: session.created_at,
    });
    if (error) console.warn(`  [warn] Import session insert: ${error.message}`);
    else console.log(`  [done] Import session: ${session.details.subject} ${session.details.exam_type}`);
  }
}

// ── Step 12: Seed tests + questions ──────────────────────────────────────────

interface TestDef {
  title: string;
  subject: string;
  class: string;
  section: string;
  term: string;
  date: string;
}

function buildQuestions(subject: string): object[] {
  return [
    { type: 'mcq', text: `${subject} MCQ 1: Which of the following is correct?`, marks: 2, options: [{ text: 'Option A' }, { text: 'Option B' }, { text: 'Option C' }, { text: 'Option D' }], correct_option: 0 },
    { type: 'mcq', text: `${subject} MCQ 2: Choose the best answer.`, marks: 2, options: [{ text: 'Choice 1' }, { text: 'Choice 2' }, { text: 'Choice 3' }, { text: 'Choice 4' }], correct_option: 1 },
    { type: 'mcq', text: `${subject} MCQ 3: Identify the correct statement.`, marks: 2, options: [{ text: 'Statement A' }, { text: 'Statement B' }, { text: 'Statement C' }, { text: 'Statement D' }], correct_option: 2 },
    { type: 'mcq', text: `${subject} MCQ 4: Select the right option.`, marks: 2, options: [{ text: 'Answer A' }, { text: 'Answer B' }, { text: 'Answer C' }, { text: 'Answer D' }], correct_option: 3 },
    { type: 'mcq', text: `${subject} MCQ 5: Which option is true?`, marks: 2, options: [{ text: 'True A' }, { text: 'True B' }, { text: 'True C' }, { text: 'True D' }], correct_option: 0 },
    { type: 'theory', text: `${subject} Theory 1: Explain the concept in detail.`, marks: 5, options: null, correct_option: null },
    { type: 'theory', text: `${subject} Theory 2: Describe with examples.`, marks: 5, options: null, correct_option: null },
  ];
}

async function seedTests(
  schoolId: string,
  createdById: string,
  testDefs: TestDef[]
): Promise<string[]> {
  console.log('\n── Tests ────────────────────────────────────────────────────');
  const testIds: string[] = [];

  for (const def of testDefs) {
    const { data: existing } = await supabaseAdmin
      .from('tests')
      .select('id')
      .eq('school_id', schoolId)
      .eq('title', def.title)
      .eq('class_name', def.class)
      .eq('section', def.section)
      .maybeSingle();

    if (existing) {
      console.log(`  [skip] Test "${def.title}" already exists`);
      testIds.push(existing.id as string);
      continue;
    }

    const { data: test, error: testErr } = await supabaseAdmin
      .from('tests')
      .insert({ title: def.title, subject: def.subject, class_name: def.class, section: def.section, term: def.term, date: def.date, school_id: schoolId, created_by: createdById })
      .select('id')
      .single();

    if (testErr || !test) { console.warn(`  [warn] Test insert failed: ${testErr?.message}`); continue; }

    const questions = buildQuestions(def.subject);
    const questionRows = (questions as Record<string, unknown>[]).map((q, idx) => ({
      test_id: test.id, order_index: idx, type: q.type, text: q.text, marks: q.marks,
      options: q.options ?? null, correct_option: q.correct_option ?? null,
    }));

    const { error: qErr } = await supabaseAdmin.from('test_questions').insert(questionRows);
    if (qErr) { console.warn(`  [warn] Questions insert failed: ${qErr.message}`); await supabaseAdmin.from('tests').delete().eq('id', test.id); continue; }

    testIds.push(test.id as string);
    console.log(`  [done] Test "${def.title}" (${def.class}${def.section})`);
  }

  return testIds;
}

// ── Step 13: Seed test attempts ───────────────────────────────────────────────

async function seedTestAttempts(
  testId: string,
  studentIds: string[]
): Promise<void> {
  const { data: questions, error: qErr } = await supabaseAdmin
    .from('test_questions')
    .select('id, type, correct_option, marks')
    .eq('test_id', testId)
    .order('order_index');

  if (qErr || !questions || questions.length === 0) {
    console.warn(`  [warn] Could not load questions for test ${testId}`);
    return;
  }

  type QuestionRow = { id: string; type: string; correct_option: number | null; marks: number };
  const qs = questions as QuestionRow[];

  for (const studentId of studentIds) {
    const { data: existing } = await supabaseAdmin
      .from('test_attempts')
      .select('id')
      .eq('test_id', testId)
      .eq('student_id', studentId)
      .maybeSingle();

    if (existing) { console.log(`    [skip] Attempt already exists for student ${studentId}`); continue; }

    const startedAt = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    const submittedAt = new Date(Date.now() - 15 * 60 * 1000).toISOString();

    const { data: attempt, error: aErr } = await supabaseAdmin
      .from('test_attempts')
      .insert({ test_id: testId, student_id: studentId, started_at: startedAt, is_submitted: true, submitted_at: submittedAt })
      .select('id')
      .single();

    if (aErr || !attempt) { console.warn(`    [warn] Attempt insert failed: ${aErr?.message}`); continue; }

    const mcqOptions = ['a', 'b', 'c', 'd'] as const;
    let mcqScore = 0;
    let totalScore = 0;

    const answerRows = qs.map((q) => {
      if (q.type === 'mcq') {
        const correctLetter = mcqOptions[q.correct_option ?? 0];
        const isCorrect = Math.random() < 0.6;
        const selectedOption = isCorrect ? correctLetter : mcqOptions[(mcqOptions.indexOf(correctLetter) + 1) % 4];
        const marksAwarded = isCorrect ? q.marks : 0;
        mcqScore += marksAwarded;
        totalScore += marksAwarded;
        return { attempt_id: attempt.id, question_id: q.id, selected_option: selectedOption, theory_answer: null, is_correct: isCorrect, marks_awarded: marksAwarded };
      } else {
        const marksAwarded = Math.floor(q.marks * (0.5 + Math.random() * 0.5));
        totalScore += marksAwarded;
        return { attempt_id: attempt.id, question_id: q.id, selected_option: null, theory_answer: 'Sample theory answer for seeding purposes.', is_correct: null, marks_awarded: marksAwarded };
      }
    });

    const { error: ansErr } = await supabaseAdmin.from('student_answers').insert(answerRows);
    if (ansErr) { console.warn(`    [warn] Answers insert failed: ${ansErr.message}`); continue; }

    await supabaseAdmin.from('test_attempts').update({ mcq_score: mcqScore, total_score: totalScore }).eq('id', attempt.id);
    console.log(`    [done] Attempt for student ${studentId} — score: ${totalScore}`);
  }
}

// ── Step 14: Seed announcements ───────────────────────────────────────────────

async function seedAnnouncements(schoolId: string, createdById: string): Promise<void> {
  console.log('\n── Announcements ────────────────────────────────────────────');
  const defs = [
    { title: 'Annual Sports Day', message: 'Annual Sports Day will be held on 15th June. All students must participate.' },
    { title: 'Parent-Teacher Meeting', message: 'PTM is scheduled for 20th June. Parents are requested to attend.' },
  ];
  for (const def of defs) {
    const { data: existing } = await supabaseAdmin.from('announcements').select('id').eq('school_id', schoolId).eq('title', def.title).maybeSingle();
    if (existing) { console.log(`  [skip] "${def.title}" already exists`); continue; }
    const { error } = await supabaseAdmin.from('announcements').insert({ title: def.title, message: def.message, school_id: schoolId, created_by: createdById });
    if (error) console.warn(`  [warn] Announcement: ${error.message}`);
    else console.log(`  [done] "${def.title}"`);
  }
}

// ── Step 15: Seed onboarding_progress ────────────────────────────────────────

async function seedOnboardingProgress(testSchoolId: string, demoSchoolId: string): Promise<void> {
  console.log('\n── Onboarding Progress ──────────────────────────────────────');
  const now = new Date().toISOString();

  const { data: existingTest } = await supabaseAdmin.from('onboarding_progress').select('school_id').eq('school_id', testSchoolId).maybeSingle();
  if (existingTest) { console.log('  [skip] onboarding_progress for Test School already exists'); }
  else {
    const { error } = await supabaseAdmin.from('onboarding_progress').insert({ school_id: testSchoolId, school_created: true, teachers_imported: true, students_imported: true, classes_created: true, teachers_assigned: true, completed: true, created_at: now, updated_at: now });
    if (error) console.warn(`  [warn] onboarding_progress (Test School): ${error.message}`);
    else console.log('  [done] Test School — all steps completed');
  }

  const { data: existingDemo } = await supabaseAdmin.from('onboarding_progress').select('school_id').eq('school_id', demoSchoolId).maybeSingle();
  if (existingDemo) { console.log('  [skip] onboarding_progress for Demo Coaching already exists'); }
  else {
    const { error } = await supabaseAdmin.from('onboarding_progress').insert({ school_id: demoSchoolId, school_created: true, teachers_imported: false, students_imported: false, classes_created: false, teachers_assigned: false, completed: false, created_at: now, updated_at: now });
    if (error) console.warn(`  [warn] onboarding_progress (Demo Coaching): ${error.message}`);
    else console.log('  [done] Demo Coaching — school_created only (onboarding incomplete)');
  }
}

// ── Step 16: Seed AI usage records ───────────────────────────────────────────

async function seedAiUsage(teacherId: string, schoolId: string): Promise<void> {
  console.log('\n── AI Usage ─────────────────────────────────────────────────');
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const { count: existing } = await supabaseAdmin.from('ai_usage').select('id', { count: 'exact', head: true }).eq('user_id', teacherId).eq('school_id', schoolId).gte('created_at', startOfDay.toISOString());
  if ((existing ?? 0) >= 3) { console.log(`  [skip] ai_usage already has ${existing} records for today`); return; }
  const needed = 3 - (existing ?? 0);
  const now = new Date();
  for (let i = 0; i < needed; i++) {
    const createdAt = new Date(now.getTime() - (needed - 1 - i) * 60 * 60 * 1000).toISOString();
    const { error } = await supabaseAdmin.from('ai_usage').insert({ user_id: teacherId, school_id: schoolId, feature: 'question_generation', tokens_used: Math.floor(800 + Math.random() * 400), prompt_hash: `seed_placeholder_hash_${i}_${Date.now()}`, cached_result: null, created_at: createdAt });
    if (error) console.warn(`  [warn] ai_usage insert ${i + 1}: ${error.message}`);
    else console.log(`  [done] ai_usage record ${i + 1}/3`);
  }
  console.log('  [info] Teacher now shows "3 / 10 generations used today"');
}

// ── Step 17: Seed legal pages ─────────────────────────────────────────────────

async function seedLegalPages(): Promise<void> {
  console.log('\n── Legal Pages ──────────────────────────────────────────────');
  const pages = [
    { page_type: 'privacy_policy', content: '# Privacy Policy\n\nEduvo is committed to protecting your personal information. This policy explains how we collect, use, and safeguard data on the Eduvo school management platform.\n\n## Data We Collect\n- Account information: name, email, role\n- School data: attendance, marks, fees, test results\n- Device information (mobile app only)\n\n## Contact\nprivacy@eduvo.com' },
    { page_type: 'terms_of_service', content: '# Terms of Service\n\nBy using Eduvo you agree to these terms. Eduvo is a school management platform for attendance, marks, fees, and parent communication.\n\n## Acceptable Use\nDo not misuse the platform or misrepresent student data.\n\n## Contact\nlegal@eduvo.com' },
  ];
  for (const page of pages) {
    const { data: existing } = await supabaseAdmin.from('legal_pages').select('page_type').eq('page_type', page.page_type).maybeSingle();
    if (existing) { console.log(`  [skip] legal_pages "${page.page_type}" already exists`); continue; }
    const { error } = await supabaseAdmin.from('legal_pages').insert({ page_type: page.page_type, content: page.content, updated_at: new Date().toISOString() });
    if (error) console.warn(`  [warn] legal_pages "${page.page_type}": ${error.message}`);
    else console.log(`  [done] legal_pages: "${page.page_type}"`);
  }
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║       Eduvo — Comprehensive Data Seeder              ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  // Warm schema cache
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/`, {
      method: 'GET',
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''}`, 'Accept-Profile': 'public' },
    });
    console.log('  [info] Schema cache warmed');
  } catch { console.warn('  [warn] Schema cache reload skipped'); }

  // ── Resolve existing required users ──────────────────────────────────────
  const schoolAdminId = await getUserIdByEmail('schooladmin@eduvo.com');
  const teacherSeedId = await getUserIdByEmail('teacher@eduvo.com');
  const superAdminId  = await getUserIdByEmail('superadmin@eduvo.com');

  if (!schoolAdminId) throw new Error('schooladmin@eduvo.com not found — run base seed first');
  if (!superAdminId)  throw new Error('superadmin@eduvo.com not found — run base seed first');

  // ── Schools ───────────────────────────────────────────────────────────────
  const schoolIds    = await seedSchools();
  const testSchoolId = schoolIds['Test School'];
  const demoSchoolId = schoolIds['Demo Coaching'];

  // ── Back-fill school_id for base-seed users ───────────────────────────────
  console.log('\n── Back-fill school_id for base-seed users ──────────────────');
  for (const email of ['schooladmin@eduvo.com', 'teacher@eduvo.com']) {
    const { data: u } = await supabaseAdmin.from('users').select('id, school_id').eq('email', email).maybeSingle();
    if (!u) { console.log(`  [skip] ${email} not found`); continue; }
    if (u.school_id === testSchoolId) { console.log(`  [ok]   ${email} already linked`); continue; }
    const { error } = await supabaseAdmin.from('users').update({ school_id: testSchoolId }).eq('id', u.id);
    if (error) console.warn(`  [warn] ${email}: ${error.message}`);
    else console.log(`  [fix]  ${email} → school_id set to Test School`);
  }

  // ── Subjects ──────────────────────────────────────────────────────────────
  console.log('\n── Subjects ─────────────────────────────────────────────────');
  const testSubjectIds = await seedSubjects(testSchoolId);
  const demoSubjectIds = await seedSubjects(demoSchoolId);

  // ── admin2@eduvo.com ──────────────────────────────────────────────────────
  await seedAdmin2(demoSchoolId, superAdminId);

  // ── Teachers for Test School ──────────────────────────────────────────────
  const testTeacherDefs: TeacherDef[] = [
    {
      email: 'teacher@eduvo.com',
      name: 'Test Teacher',
      assignments: [
        { subject: 'Maths',   class: '10', section: 'A' },
        { subject: 'Science', class: '10', section: 'A' },
        { subject: 'Maths',   class: '10', section: 'B' },
        { subject: 'Science', class: '10', section: 'B' },
      ],
    },
    {
      email: 'teacher2@eduvo.com',
      name: 'Teacher Two',
      assignments: [
        { subject: 'English', class: '10', section: 'A' },
        { subject: 'English', class: '10', section: 'B' },
      ],
    },
    {
      email: 'teacher3@eduvo.com',
      name: 'Teacher Three',
      assignments: [
        { subject: 'Hindi',    class: '9', section: 'A' },
        { subject: 'Gujarati', class: '9', section: 'A' },
        { subject: 'Hindi',    class: '10', section: 'A' },
        { subject: 'Gujarati', class: '10', section: 'A' },
        { subject: 'Hindi',    class: '10', section: 'B' },
        { subject: 'Gujarati', class: '10', section: 'B' },
      ],
    },
    {
      email: 'teacher4@eduvo.com',
      name: 'Teacher Four',
      assignments: [
        { subject: 'Maths',   class: '9', section: 'A' },
        { subject: 'Science', class: '9', section: 'A' },
        { subject: 'English', class: '9', section: 'A' },
      ],
    },
  ];

  const testTeacherIds = await seedTeachers(testSchoolId, schoolAdminId, testTeacherDefs);
  if (teacherSeedId) testTeacherIds['teacher@eduvo.com'] = teacherSeedId;

  // ── Teachers for Demo School ──────────────────────────────────────────────
  const demoTeacherDefs: TeacherDef[] = [
    { email: 'demoteacher1@eduvo.com', name: 'Demo Teacher One',   assignments: [{ subject: 'Maths', class: '10', section: 'A' }, { subject: 'Maths', class: '10', section: 'B' }] },
    { email: 'demoteacher2@eduvo.com', name: 'Demo Teacher Two',   assignments: [{ subject: 'Science', class: '10', section: 'A' }, { subject: 'English', class: '10', section: 'A' }] },
    { email: 'demoteacher3@eduvo.com', name: 'Demo Teacher Three', assignments: [{ subject: 'Hindi', class: '9', section: 'A' }, { subject: 'Gujarati', class: '9', section: 'A' }] },
  ];
  await seedTeachers(demoSchoolId, schoolAdminId, demoTeacherDefs);

  // ── Students for Test School (phone-based login, no parent accounts) ─────
  const testStudentIds = await seedStudents(testSchoolId, TEST_STUDENT_DEFS);

  // Indices: 10A = [0..4], 10B = [5..9], 9A = [10..14]
  const class10AStudentIds = testStudentIds.slice(0, 5);
  const class10BStudentIds = testStudentIds.slice(5, 10);
  const class9AStudentIds  = testStudentIds.slice(10, 15);

  // ── Students for Demo School ──────────────────────────────────────────────
  const demoStudentDefs: StudentDef[] = [
    { full_name: 'Demo Student 1',  class: '9',  section: 'A', roll_number: 'D9A01',  phone_number: '9866778899', date_of_birth: '2010-03-10', is_first_login: false },
    { full_name: 'Demo Student 2',  class: '9',  section: 'A', roll_number: 'D9A02',  phone_number: '9877889900', date_of_birth: '2010-07-22', is_first_login: false },
    { full_name: 'Demo Student 3',  class: '9',  section: 'A', roll_number: 'D9A03',  phone_number: '9888990011', date_of_birth: '2010-11-05', is_first_login: false },
    { full_name: 'Demo Student 4',  class: '9',  section: 'A', roll_number: 'D9A04',  phone_number: '9899001122', date_of_birth: '2011-02-14', is_first_login: false },
    { full_name: 'Demo Student 5',  class: '9',  section: 'A', roll_number: 'D9A05',  phone_number: '9800112233', date_of_birth: '2010-09-30', is_first_login: false },
    { full_name: 'Demo Student 6',  class: '10', section: 'A', roll_number: 'D10A01', phone_number: '9811223300', date_of_birth: '2009-04-18', is_first_login: false },
    { full_name: 'Demo Student 7',  class: '10', section: 'A', roll_number: 'D10A02', phone_number: '9822334411', date_of_birth: '2009-08-25', is_first_login: false },
    { full_name: 'Demo Student 8',  class: '10', section: 'A', roll_number: 'D10A03', phone_number: '9833445522', date_of_birth: '2008-12-12', is_first_login: false },
    { full_name: 'Demo Student 9',  class: '10', section: 'A', roll_number: 'D10A04', phone_number: '9844556633', date_of_birth: '2009-06-07', is_first_login: false },
    { full_name: 'Demo Student 10', class: '10', section: 'A', roll_number: 'D10A05', phone_number: '9855667744', date_of_birth: '2008-10-20', is_first_login: false },
    { full_name: 'Demo Student 11', class: '10', section: 'B', roll_number: 'D10B01', phone_number: '9866778855', date_of_birth: '2009-01-15', is_first_login: false },
    { full_name: 'Demo Student 12', class: '10', section: 'B', roll_number: 'D10B02', phone_number: '9877889966', date_of_birth: '2008-05-28', is_first_login: false },
    { full_name: 'Demo Student 13', class: '10', section: 'B', roll_number: 'D10B03', phone_number: '9888990077', date_of_birth: '2009-09-03', is_first_login: false },
    { full_name: 'Demo Student 14', class: '10', section: 'B', roll_number: 'D10B04', phone_number: '9899001188', date_of_birth: '2008-07-16', is_first_login: false },
    { full_name: 'Demo Student 15', class: '10', section: 'B', roll_number: 'D10B05', phone_number: '9800112299', date_of_birth: '2009-11-22', is_first_login: false },
  ];
  const demoStudentIds = await seedStudents(demoSchoolId, demoStudentDefs);

  // ── Historical Attendance ─────────────────────────────────────────────────
  const attendanceRecorderId = teacherSeedId ?? schoolAdminId;
  await seedAttendance(testStudentIds, attendanceRecorderId);
  await seedAttendance(demoStudentIds, schoolAdminId);

  // ── Current-week attendance ───────────────────────────────────────────────
  await seedWeeklyAttendance(class10AStudentIds, class10BStudentIds, attendanceRecorderId);

  // ── Fees ──────────────────────────────────────────────────────────────────
  // Test School: student index 1 (Priya Patel / 10A02) has fee NOT paid
  await seedFees(testStudentIds, testSchoolId, schoolAdminId, [1]);
  await seedFees(demoStudentIds, demoSchoolId, schoolAdminId, []);

  // ── Timetable ─────────────────────────────────────────────────────────────
  // teacher@eduvo.com → Maths + Science for 10A/10B
  // teacher3@eduvo.com → Hindi + Gujarati for 10A/10B/9A
  // teacher4@eduvo.com → Maths + Science + English for 9A
  const teacher3Id = await getUserIdByEmail('teacher3@eduvo.com') ?? schoolAdminId;
  const teacher4Id = await getUserIdByEmail('teacher4@eduvo.com') ?? schoolAdminId;
  const teacher2Id = await getUserIdByEmail('teacher2@eduvo.com') ?? schoolAdminId;

  const teacherBySubject10: Record<string, string> = {
    'Maths':    testTeacherIds['teacher@eduvo.com'] ?? schoolAdminId,
    'Science':  testTeacherIds['teacher@eduvo.com'] ?? schoolAdminId,
    'English':  teacher2Id,
    'Hindi':    teacher3Id,
    'Gujarati': teacher3Id,
  };
  const teacherBySubject9A: Record<string, string> = {
    'Maths':    teacher4Id,
    'Science':  teacher4Id,
    'English':  teacher4Id,
    'Hindi':    teacher3Id,
    'Gujarati': teacher3Id,
  };

  await seedTimetable(testSchoolId, '10', 'A', TIMETABLE_10, testSubjectIds, teacherBySubject10, schoolAdminId);
  await seedTimetable(testSchoolId, '10', 'B', TIMETABLE_10, testSubjectIds, teacherBySubject10, schoolAdminId);
  await seedTimetable(testSchoolId, '9',  'A', TIMETABLE_9A, testSubjectIds, teacherBySubject9A, schoolAdminId);

  // ── Homework for Class 10A ────────────────────────────────────────────────
  await seedHomework(
    testSchoolId,
    testSubjectIds,
    teacherBySubject10,
    class10AStudentIds,
    attendanceRecorderId
  );

  // ── Complaints ────────────────────────────────────────────────────────────
  const mainTeacherId = testTeacherIds['teacher@eduvo.com'] ?? schoolAdminId;
  await seedComplaints(testSchoolId, testStudentIds, mainTeacherId, schoolAdminId);

  // ── Marks Import Sessions ─────────────────────────────────────────────────
  await seedMarksImportSessions(mainTeacherId, testSchoolId);

  // ── Tests ─────────────────────────────────────────────────────────────────
  const testCreatorId = teacherSeedId ?? schoolAdminId;
  const testSchoolTestDefs: TestDef[] = [
    { title: 'Maths Unit Test 1',  subject: 'Maths',    class: '9',  section: 'A', term: 'Term 1', date: daysAgo(20) },
    { title: 'Hindi Mid-Term',     subject: 'Hindi',    class: '9',  section: 'A', term: 'Term 1', date: daysAgo(15) },
    { title: 'Gujarati Quiz 1',    subject: 'Gujarati', class: '9',  section: 'A', term: 'Term 1', date: daysAgo(10) },
    { title: 'Maths Unit Test 1',  subject: 'Maths',    class: '10', section: 'A', term: 'Term 1', date: daysAgo(20) },
    { title: 'Science Mid-Term',   subject: 'Science',  class: '10', section: 'A', term: 'Term 1', date: daysAgo(15) },
    { title: 'English Quiz 1',     subject: 'English',  class: '10', section: 'A', term: 'Term 1', date: daysAgo(10) },
    { title: 'Maths Unit Test 1',  subject: 'Maths',    class: '10', section: 'B', term: 'Term 1', date: daysAgo(20) },
    { title: 'Science Mid-Term',   subject: 'Science',  class: '10', section: 'B', term: 'Term 1', date: daysAgo(15) },
    { title: 'English Quiz 1',     subject: 'English',  class: '10', section: 'B', term: 'Term 1', date: daysAgo(10) },
  ];
  const testSchoolTestIds = await seedTests(testSchoolId, testCreatorId, testSchoolTestDefs);

  const demoTeacher1Id = await getUserIdByEmail('demoteacher1@eduvo.com') ?? schoolAdminId;
  const demoSchoolTestDefs: TestDef[] = [
    { title: 'Maths Unit Test 1',  subject: 'Maths',    class: '9',  section: 'A', term: 'Term 1', date: daysAgo(20) },
    { title: 'Hindi Mid-Term',     subject: 'Hindi',    class: '9',  section: 'A', term: 'Term 1', date: daysAgo(15) },
    { title: 'Gujarati Quiz 1',    subject: 'Gujarati', class: '9',  section: 'A', term: 'Term 1', date: daysAgo(10) },
    { title: 'Maths Unit Test 1',  subject: 'Maths',    class: '10', section: 'A', term: 'Term 1', date: daysAgo(20) },
    { title: 'Science Mid-Term',   subject: 'Science',  class: '10', section: 'A', term: 'Term 1', date: daysAgo(15) },
    { title: 'English Quiz 1',     subject: 'English',  class: '10', section: 'A', term: 'Term 1', date: daysAgo(10) },
    { title: 'Maths Unit Test 1',  subject: 'Maths',    class: '10', section: 'B', term: 'Term 1', date: daysAgo(20) },
    { title: 'Science Mid-Term',   subject: 'Science',  class: '10', section: 'B', term: 'Term 1', date: daysAgo(15) },
    { title: 'English Quiz 1',     subject: 'English',  class: '10', section: 'B', term: 'Term 1', date: daysAgo(10) },
  ];
  const demoSchoolTestIds = await seedTests(demoSchoolId, demoTeacher1Id, demoSchoolTestDefs);

  // ── Test Attempts ─────────────────────────────────────────────────────────
  console.log('\n── Test Attempts ────────────────────────────────────────────');
  const testGroups = [
    { testIds: testSchoolTestIds.slice(0, 3), students: class9AStudentIds },
    { testIds: testSchoolTestIds.slice(3, 6), students: class10AStudentIds },
    { testIds: testSchoolTestIds.slice(6, 9), students: class10BStudentIds },
  ];
  for (const group of testGroups) {
    for (const testId of group.testIds) {
      if (!testId) continue;
      console.log(`  Test ${testId} — attempting with 3 students`);
      await seedTestAttempts(testId, group.students.slice(0, 3));
    }
  }

  const demoClass9A  = demoStudentIds.slice(0, 5);
  const demoClass10A = demoStudentIds.slice(5, 10);
  const demoClass10B = demoStudentIds.slice(10, 15);
  const demoGroups = [
    { testIds: demoSchoolTestIds.slice(0, 3), students: demoClass9A },
    { testIds: demoSchoolTestIds.slice(3, 6), students: demoClass10A },
    { testIds: demoSchoolTestIds.slice(6, 9), students: demoClass10B },
  ];
  for (const group of demoGroups) {
    for (const testId of group.testIds) {
      if (!testId) continue;
      await seedTestAttempts(testId, group.students.slice(0, 3));
    }
  }

  // ── Announcements ─────────────────────────────────────────────────────────
  await seedAnnouncements(testSchoolId, schoolAdminId);
  await seedAnnouncements(demoSchoolId, schoolAdminId);

  // ── Onboarding Progress ───────────────────────────────────────────────────
  await seedOnboardingProgress(testSchoolId, demoSchoolId);

  // ── AI Usage ──────────────────────────────────────────────────────────────
  await seedAiUsage(mainTeacherId, testSchoolId);

  // ── Legal Pages ───────────────────────────────────────────────────────────
  await seedLegalPages();

  // ── Credentials summary ───────────────────────────────────────────────────
  const s1 = TEST_STUDENT_DEFS[0];   // Rahul Sharma  10A01
  const s2 = TEST_STUDENT_DEFS[1];   // Priya Patel   10A02
  const s3 = TEST_STUDENT_DEFS[10];  // Arjun Shah     9A01
  const s4 = TEST_STUDENT_DEFS[3];   // Arjun Nair    10A04 (is_first_login=true)
  const s5 = TEST_STUDENT_DEFS[4];   // Meera Iyer    10A05 (is_first_login=true)

  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║              === TEST LOGIN CREDENTIALS ===                      ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log('║  Staff Login (Email + Password):                                 ║');
  console.log('║  superadmin@eduvo.com  / Test@1234  → Super Admin               ║');
  console.log('║  schooladmin@eduvo.com / Test@1234  → School Admin              ║');
  console.log('║  teacher@eduvo.com     / Test@1234  → Teacher (10A Maths+Sci)   ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log('║  Student/Parent Login (Phone + Password):                        ║');
  console.log(`║  ${s1.phone_number} / ${s1.phone_number.slice(-5)}  → ${s1.full_name}, Class 10A (fee PAID)    ║`);
  console.log(`║  ${s2.phone_number} / ${s2.phone_number.slice(-5)}  → ${s2.full_name}, Class 10A (fee NOT paid) ║`);
  console.log(`║  ${s3.phone_number} / ${s3.phone_number.slice(-5)}  → ${s3.full_name}, Class 9A              ║`);
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log(`║  Note: ${s4.full_name} (${s4.phone_number}) → is_first_login=true         ║`);
  console.log(`║  Note: ${s5.full_name} (${s5.phone_number}) → is_first_login=true          ║`);
  console.log('║  These students will see the Change Password screen on login.    ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log('║  Note: Student 1 phone (9812345678) is linked to 2 children     ║');
  console.log('║  (Rahul Sharma 10A + Arjun Shah 9A) — test multi-child switcher ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log('║  Extra teachers:  teacher2@eduvo.com / Test@1234                ║');
  console.log('║                   teacher3@eduvo.com / Test@1234                ║');
  console.log('║                   teacher4@eduvo.com / Test@1234                ║');
  console.log('║  Demo school:     demoteacher1-3@eduvo.com / Test@1234          ║');
  console.log('║                   admin2@eduvo.com / Test@1234                  ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log('║  Test School  → 15 students, timetable seeded (10A/10B/9A)      ║');
  console.log('║    Class 10A: 5 homework items (2 pending, 2 past, 1 today)     ║');
  console.log('║    Class 10A: 5 days attendance this week (all submitted)       ║');
  console.log('║    Class 10B: 4 days this week (Friday PENDING — not sent)      ║');
  console.log('║    Complaints: 2 to class_teacher, 2 to school_admin            ║');
  console.log('║    Marks import: 2 sessions in audit_logs for teacher           ║');
  console.log('║  Demo Coaching → 15 students, 9 tests, attendance seeded        ║');
  console.log('║  Onboarding: Test School=DONE, Demo Coaching=INCOMPLETE         ║');
  console.log('║  AI Usage: teacher has 3/10 generations used today              ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
}

main().catch((err: Error) => {
  console.error('[fatal] Seed script crashed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
