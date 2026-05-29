/// <reference types="node" />
/**
 * seed.ts — Comprehensive test data seeder for Eduvo.
 *
 * Run with:
 *   npx ts-node src/scripts/seed.ts
 *
 * Safe to re-run: uses skip logic for anything that already exists.
 * Does NOT recreate: superadmin@eduvo.com, schooladmin@eduvo.com,
 *                    teacher@eduvo.com, student@eduvo.com
 * ADDS: parent@eduvo.com + all test data below.
 */

import 'dotenv/config';
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

function randomHex8(): string {
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0')
    .toUpperCase();
}

/** Returns a date string YYYY-MM-DD offset by `daysAgo` from today. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
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

// ── Constants ─────────────────────────────────────────────────────────────────

const SUBJECTS = ['Maths', 'Science', 'English', 'Hindi', 'Gujarati'];

const SCHOOLS = [
  { name: 'Test School',    address: '123 Test Street, Test City' },
  { name: 'Demo Coaching',  address: '456 Demo Avenue, Demo City' },
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

// ── Step 3: Seed parent@eduvo.com ─────────────────────────────────────────────

async function seedParentUser(schoolId: string): Promise<string> {
  console.log('\n── Parent user ──────────────────────────────────────────────');
  const email = 'parent@eduvo.com';

  const existingId = await getUserIdByEmail(email);
  if (existingId) {
    console.log(`  [skip] ${email} already exists (id: ${existingId})`);
    return existingId;
  }

  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password: 'Test@1234',
    email_confirm: true,
  });

  if (authError || !authData?.user) {
    throw new Error(`Auth creation failed for ${email}: ${authError?.message}`);
  }

  const userId = authData.user.id;

  const { error: profileError } = await supabaseAdmin.from('users').insert({
    id: userId,
    name: 'Test Parent',
    email,
    role: 'parent',
    school_id: schoolId,
  });

  if (profileError) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Profile insert failed for ${email}: ${profileError.message}`);
  }

  await logAudit(userId, 'SEED_USER_CREATED', { email, role: 'parent' });
  console.log(`  [done] Created ${email} (id: ${userId})`);
  return userId;
}

// ── Step 4: Seed extra teachers ───────────────────────────────────────────────

interface TeacherDef {
  email: string;
  name: string;
  assignments: { subject: string; class_name: string; section: string }[];
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

      if (authErr || !authData?.user) {
        throw new Error(`Auth creation failed for ${def.email}: ${authErr?.message}`);
      }

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

    // Seed teacher_assignments
    for (const a of def.assignments) {
      const { data: existing } = await supabaseAdmin
        .from('teacher_assignments')
        .select('id')
        .eq('teacher_id', userId)
        .eq('school_id', schoolId)
        .eq('class_name', a.class_name)
        .eq('section', a.section)
        .eq('subject', a.subject)
        .maybeSingle();

      if (existing) continue;

      const { error } = await supabaseAdmin.from('teacher_assignments').insert({
        teacher_id: userId,
        school_id: schoolId,
        class_name: a.class_name,
        section: a.section,
        subject: a.subject,
      });

      if (error) console.warn(`  [warn] Assignment insert: ${error.message}`);
      else console.log(`    → Assigned ${a.subject} / ${a.class_name} ${a.section}`);
    }
  }

  return ids;
}

// ── Step 5: Seed extra parents ────────────────────────────────────────────────

async function seedExtraParent(
  email: string,
  name: string,
  schoolId: string,
  schoolAdminId: string
): Promise<string> {
  let userId = await getUserIdByEmail(email);

  if (userId) {
    console.log(`  [skip] ${email} already exists (id: ${userId})`);
    return userId;
  }

  const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password: 'Test@1234',
    email_confirm: true,
  });

  if (authErr || !authData?.user) {
    throw new Error(`Auth creation failed for ${email}: ${authErr?.message}`);
  }

  userId = authData.user.id;

  const { error: profileErr } = await supabaseAdmin.from('users').insert({
    id: userId,
    name,
    email,
    role: 'parent',
    school_id: schoolId,
    created_by: schoolAdminId,
  });

  if (profileErr) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Profile insert failed for ${email}: ${profileErr.message}`);
  }

  await logAudit(userId, 'SEED_USER_CREATED', { email, role: 'parent' });
  console.log(`  [done] Created parent ${email} (id: ${userId})`);
  return userId;
}

// ── Step 6: Seed students ─────────────────────────────────────────────────────

interface StudentDef {
  full_name: string;
  class_name: string;
  section: string;
  roll_number: string;
  parentEmail: string; // which parent owns this student
}

async function seedStudents(
  schoolId: string,
  studentDefs: StudentDef[],
  parentIds: Record<string, string>
): Promise<string[]> {
  console.log('\n── Students ─────────────────────────────────────────────────');
  const ids: string[] = [];

  for (const def of studentDefs) {
    // Check by roll_number + school_id + class_name to avoid duplicates
    const { data: existing } = await supabaseAdmin
      .from('students')
      .select('id')
      .eq('school_id', schoolId)
      .eq('full_name', def.full_name)
      .eq('class_name', def.class_name)
      .eq('section', def.section)
      .maybeSingle();

    if (existing) {
      console.log(`  [skip] Student "${def.full_name}" already exists`);
      ids.push(existing.id as string);
      continue;
    }

    const parentId = parentIds[def.parentEmail] ?? null;
    const rfid = randomHex8();

    const { data: student, error } = await supabaseAdmin
      .from('students')
      .insert({
        full_name: def.full_name,
        class_name: def.class_name,
        section: def.section,
        roll_number: def.roll_number,
        school_id: schoolId,
        parent_id: parentId,
        rfid_uid: rfid,
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

    // Link parent → student in junction table
    if (parentId) {
      await supabaseAdmin
        .from('parent_students')
        .upsert({ parent_id: parentId, student_id: student.id });
    }

    ids.push(student.id as string);
    console.log(`  [done] ${def.full_name} (${def.class_name} ${def.section}) rfid: ${rfid}`);
  }

  return ids;
}

// ── Step 7: Seed attendance ───────────────────────────────────────────────────

async function seedAttendance(
  studentIds: string[],
  recordedById: string
): Promise<void> {
  console.log('\n── Attendance ───────────────────────────────────────────────');

  for (const studentId of studentIds) {
    // Build 30 days: 22 present, 8 absent, shuffled
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

    // Check how many records already exist for this student
    const { count } = await supabaseAdmin
      .from('attendance')
      .select('id', { count: 'exact', head: true })
      .eq('student_id', studentId);

    if ((count ?? 0) >= 30) {
      console.log(`  [skip] Attendance already seeded for student ${studentId}`);
      continue;
    }

    // Upsert to avoid unique constraint errors on (student_id, date)
    const { error } = await supabaseAdmin
      .from('attendance')
      .upsert(rows, { onConflict: 'student_id,date', ignoreDuplicates: true });

    if (error) console.warn(`  [warn] Attendance insert: ${error.message}`);
    else console.log(`  [done] 30 records for student ${studentId}`);
  }
}

// ── Step 8: Seed fees ─────────────────────────────────────────────────────────

async function seedFees(
  studentIds: string[],
  schoolId: string,
  updatedById: string
): Promise<void> {
  console.log('\n── Fees ─────────────────────────────────────────────────────');

  // 12 paid, 3 unpaid per school (15 students total per school)
  const paidCount = 12;

  for (let i = 0; i < studentIds.length; i++) {
    const studentId = studentIds[i];
    const feePaid = i < paidCount;

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

// ── Step 9: Seed tests + questions ───────────────────────────────────────────

interface TestDef {
  title: string;
  subject: string;
  class_name: string;
  section: string;
  term: string;
  date: string;
}

function buildQuestions(subject: string): object[] {
  return [
    // 5 MCQ questions
    {
      type: 'mcq',
      text: `${subject} MCQ 1: Which of the following is correct?`,
      marks: 2,
      options: [{ text: 'Option A' }, { text: 'Option B' }, { text: 'Option C' }, { text: 'Option D' }],
      correct_option: 0,
    },
    {
      type: 'mcq',
      text: `${subject} MCQ 2: Choose the best answer.`,
      marks: 2,
      options: [{ text: 'Choice 1' }, { text: 'Choice 2' }, { text: 'Choice 3' }, { text: 'Choice 4' }],
      correct_option: 1,
    },
    {
      type: 'mcq',
      text: `${subject} MCQ 3: Identify the correct statement.`,
      marks: 2,
      options: [{ text: 'Statement A' }, { text: 'Statement B' }, { text: 'Statement C' }, { text: 'Statement D' }],
      correct_option: 2,
    },
    {
      type: 'mcq',
      text: `${subject} MCQ 4: Select the right option.`,
      marks: 2,
      options: [{ text: 'Answer A' }, { text: 'Answer B' }, { text: 'Answer C' }, { text: 'Answer D' }],
      correct_option: 3,
    },
    {
      type: 'mcq',
      text: `${subject} MCQ 5: Which option is true?`,
      marks: 2,
      options: [{ text: 'True A' }, { text: 'True B' }, { text: 'True C' }, { text: 'True D' }],
      correct_option: 0,
    },
    // 2 theory questions
    {
      type: 'theory',
      text: `${subject} Theory 1: Explain the concept in detail.`,
      marks: 5,
      options: null,
      correct_option: null,
    },
    {
      type: 'theory',
      text: `${subject} Theory 2: Describe with examples.`,
      marks: 5,
      options: null,
      correct_option: null,
    },
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
      .eq('class_name', def.class_name)
      .eq('section', def.section)
      .maybeSingle();

    if (existing) {
      console.log(`  [skip] Test "${def.title}" already exists`);
      testIds.push(existing.id as string);
      continue;
    }

    const { data: test, error: testErr } = await supabaseAdmin
      .from('tests')
      .insert({
        title: def.title,
        subject: def.subject,
        class_name: def.class_name,
        section: def.section,
        term: def.term,
        date: def.date,
        school_id: schoolId,
        created_by: createdById,
      })
      .select('id')
      .single();

    if (testErr || !test) {
      console.warn(`  [warn] Test insert failed: ${testErr?.message}`);
      continue;
    }

    const questions = buildQuestions(def.subject);
    const questionRows = (questions as Record<string, unknown>[]).map((q, idx) => ({
      test_id: test.id,
      order_index: idx,
      type: q.type,
      text: q.text,
      marks: q.marks,
      options: q.options ?? null,
      correct_option: q.correct_option ?? null,
    }));

    const { error: qErr } = await supabaseAdmin.from('test_questions').insert(questionRows);
    if (qErr) {
      console.warn(`  [warn] Questions insert failed: ${qErr.message}`);
      await supabaseAdmin.from('tests').delete().eq('id', test.id);
      continue;
    }

    testIds.push(test.id as string);
    console.log(`  [done] Test "${def.title}" (${def.class_name} ${def.section})`);
  }

  return testIds;
}

// ── Step 10: Seed test attempts ───────────────────────────────────────────────

async function seedTestAttempts(
  testId: string,
  studentIds: string[], // 3 students per test
  schoolId: string
): Promise<void> {
  // Fetch questions for this test
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
    // Check if attempt already exists
    const { data: existing } = await supabaseAdmin
      .from('test_attempts')
      .select('id')
      .eq('test_id', testId)
      .eq('student_id', studentId)
      .maybeSingle();

    if (existing) {
      console.log(`    [skip] Attempt already exists for student ${studentId}`);
      continue;
    }

    const startedAt = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    const submittedAt = new Date(Date.now() - 15 * 60 * 1000).toISOString();

    // Create attempt
    const { data: attempt, error: aErr } = await supabaseAdmin
      .from('test_attempts')
      .insert({
        test_id: testId,
        student_id: studentId,
        started_at: startedAt,
        is_submitted: true,
        submitted_at: submittedAt,
      })
      .select('id')
      .single();

    if (aErr || !attempt) {
      console.warn(`    [warn] Attempt insert failed: ${aErr?.message}`);
      continue;
    }

    // Build answers
    const mcqOptions = ['a', 'b', 'c', 'd'] as const;
    let mcqScore = 0;
    let totalScore = 0;

    const answerRows = qs.map((q) => {
      if (q.type === 'mcq') {
        // Randomly pick an option (roughly 60% chance of correct)
        const correctLetter = mcqOptions[q.correct_option ?? 0];
        const isCorrect = Math.random() < 0.6;
        const selectedOption = isCorrect
          ? correctLetter
          : mcqOptions[(mcqOptions.indexOf(correctLetter) + 1) % 4];
        const marksAwarded = isCorrect ? q.marks : 0;
        mcqScore += marksAwarded;
        totalScore += marksAwarded;
        return {
          attempt_id: attempt.id,
          question_id: q.id,
          selected_option: selectedOption,
          theory_answer: null,
          is_correct: isCorrect,
          marks_awarded: marksAwarded,
        };
      } else {
        // Theory: award partial marks
        const marksAwarded = Math.floor(q.marks * (0.5 + Math.random() * 0.5));
        totalScore += marksAwarded;
        return {
          attempt_id: attempt.id,
          question_id: q.id,
          selected_option: null,
          theory_answer: 'This is a sample theory answer for seeding purposes.',
          is_correct: null,
          marks_awarded: marksAwarded,
        };
      }
    });

    const { error: ansErr } = await supabaseAdmin
      .from('student_answers')
      .insert(answerRows);

    if (ansErr) {
      console.warn(`    [warn] Answers insert failed: ${ansErr.message}`);
      continue;
    }

    // Update attempt with scores
    await supabaseAdmin
      .from('test_attempts')
      .update({ mcq_score: mcqScore, total_score: totalScore })
      .eq('id', attempt.id);

    console.log(`    [done] Attempt for student ${studentId} — score: ${totalScore}`);
  }
}

// ── Step 11: Seed complaints ──────────────────────────────────────────────────

async function seedComplaints(
  schoolId: string,
  parentIds: string[],
  studentIds: string[],
  schoolAdminId: string
): Promise<void> {
  console.log('\n── Complaints ───────────────────────────────────────────────');

  const complaintDefs = [
    { subject: 'Homework overload', body: 'My child is getting too much homework every day.' },
    { subject: 'Bullying concern', body: 'There seems to be a bullying issue in the classroom.' },
    { subject: 'Fee receipt not received', body: 'I paid the fees but did not receive a receipt.' },
  ];

  for (let i = 0; i < complaintDefs.length; i++) {
    const def = complaintDefs[i];
    const parentId = parentIds[i % parentIds.length];
    const studentId = studentIds[i % studentIds.length];

    const { data: existing } = await supabaseAdmin
      .from('complaints')
      .select('id')
      .eq('school_id', schoolId)
      .eq('subject', def.subject)
      .eq('submitted_by', parentId)
      .maybeSingle();

    if (existing) {
      console.log(`  [skip] Complaint "${def.subject}" already exists`);
      continue;
    }

    const { error } = await supabaseAdmin.from('complaints').insert({
      subject: def.subject,
      body: def.body,
      school_id: schoolId,
      submitted_by: parentId,
      student_id: studentId,
      status: 'pending',
    });

    if (error) console.warn(`  [warn] Complaint insert: ${error.message}`);
    else console.log(`  [done] Complaint: "${def.subject}"`);
  }
}

// ── Step 12: Seed announcements ───────────────────────────────────────────────

async function seedAnnouncements(
  schoolId: string,
  createdById: string
): Promise<void> {
  console.log('\n── Announcements ────────────────────────────────────────────');

  const announcementDefs = [
    {
      title: 'Annual Sports Day',
      message: 'Annual Sports Day will be held on 15th June. All students must participate.',
    },
    {
      title: 'Parent-Teacher Meeting',
      message: 'PTM is scheduled for 20th June. Parents are requested to attend.',
    },
  ];

  for (const def of announcementDefs) {
    const { data: existing } = await supabaseAdmin
      .from('announcements')
      .select('id')
      .eq('school_id', schoolId)
      .eq('title', def.title)
      .maybeSingle();

    if (existing) {
      console.log(`  [skip] Announcement "${def.title}" already exists`);
      continue;
    }

    const { error } = await supabaseAdmin.from('announcements').insert({
      title: def.title,
      message: def.message,
      school_id: schoolId,
      created_by: createdById,
    });

    if (error) console.warn(`  [warn] Announcement insert: ${error.message}`);
    else console.log(`  [done] Announcement: "${def.title}"`);
  }
}

// ── Step 13: Seed notifications ───────────────────────────────────────────────

async function seedNotifications(
  parentIds: string[],
  senderId: string
): Promise<void> {
  console.log('\n── Notifications ────────────────────────────────────────────');

  const notifDefs = [
    { title: 'Attendance Alert', body: 'Your child was absent today.', type: 'attendance' as const },
    { title: 'New Test Available', body: 'A new test has been published for your child\'s class.', type: 'reminder' as const },
    { title: 'Fee Reminder', body: 'Term 1 fees are due. Please pay at the earliest.', type: 'reminder' as const },
  ];

  for (const parentId of parentIds) {
    for (const def of notifDefs) {
      const { data: existing } = await supabaseAdmin
        .from('notifications')
        .select('id')
        .eq('recipient_id', parentId)
        .eq('title', def.title)
        .maybeSingle();

      if (existing) continue;

      const { error } = await supabaseAdmin.from('notifications').insert({
        title: def.title,
        body: def.body,
        type: def.type,
        recipient_id: parentId,
        sender_id: senderId,
        is_read: false,
      });

      if (error) console.warn(`  [warn] Notification insert: ${error.message}`);
    }
    console.log(`  [done] Notifications for parent ${parentId}`);
  }
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║       Eduvo — Comprehensive Data Seeder              ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  // ── Resolve existing required users ──────────────────────────────────────
  const schoolAdminId = await getUserIdByEmail('schooladmin@eduvo.com');
  const teacherSeedId = await getUserIdByEmail('teacher@eduvo.com');
  const studentSeedId = await getUserIdByEmail('student@eduvo.com');
  const superAdminId  = await getUserIdByEmail('superadmin@eduvo.com');

  if (!schoolAdminId) throw new Error('schooladmin@eduvo.com not found — run base seed first');
  if (!superAdminId)  throw new Error('superadmin@eduvo.com not found — run base seed first');

  // ── Schools ───────────────────────────────────────────────────────────────
  const schoolIds = await seedSchools();
  const testSchoolId = schoolIds['Test School'];
  const demoSchoolId = schoolIds['Demo Coaching'];

  // ── Subjects (for both schools) ───────────────────────────────────────────
  console.log('\n── Subjects ─────────────────────────────────────────────────');
  await seedSubjects(testSchoolId);
  await seedSubjects(demoSchoolId);

  // ── Parent user (parent@eduvo.com) — linked to Test School ───────────────
  const mainParentId = await seedParentUser(testSchoolId);

  // ── Extra parents (5 total: mainParent + 4 more, some share children) ────
  console.log('\n── Extra parents ────────────────────────────────────────────');
  const parent2Id = await seedExtraParent('parent2@eduvo.com', 'Parent Two',   testSchoolId, schoolAdminId);
  const parent3Id = await seedExtraParent('parent3@eduvo.com', 'Parent Three', testSchoolId, schoolAdminId);
  const parent4Id = await seedExtraParent('parent4@eduvo.com', 'Parent Four',  testSchoolId, schoolAdminId);
  const parent5Id = await seedExtraParent('parent5@eduvo.com', 'Parent Five',  testSchoolId, schoolAdminId);

  // Demo school parents
  const demoParent1Id = await seedExtraParent('demoparent1@eduvo.com', 'Demo Parent One', demoSchoolId, schoolAdminId);
  const demoParent2Id = await seedExtraParent('demoparent2@eduvo.com', 'Demo Parent Two', demoSchoolId, schoolAdminId);

  // ── Teachers for Test School ──────────────────────────────────────────────
  const testTeacherDefs: TeacherDef[] = [
    {
      email: 'teacher@eduvo.com', // existing — just ensure assignments
      name: 'Test Teacher',
      assignments: [
        { subject: 'Maths', class_name: '10', section: 'A' },
        { subject: 'Maths', class_name: '10', section: 'B' },
      ],
    },
    {
      email: 'teacher2@eduvo.com',
      name: 'Teacher Two',
      assignments: [
        { subject: 'Science', class_name: '10', section: 'A' },
        { subject: 'English', class_name: '10', section: 'A' },
      ],
    },
    {
      email: 'teacher3@eduvo.com',
      name: 'Teacher Three',
      assignments: [
        { subject: 'Hindi',    class_name: '9', section: 'A' },
        { subject: 'Gujarati', class_name: '9', section: 'A' },
      ],
    },
  ];

  // For teacher@eduvo.com we only add assignments, not recreate the user
  const testTeacherIds = await seedTeachers(testSchoolId, schoolAdminId, testTeacherDefs);
  // Ensure existing teacher@eduvo.com id is in the map
  if (teacherSeedId) testTeacherIds['teacher@eduvo.com'] = teacherSeedId;

  // ── Teachers for Demo School ──────────────────────────────────────────────
  const demoTeacherDefs: TeacherDef[] = [
    {
      email: 'demoteacher1@eduvo.com',
      name: 'Demo Teacher One',
      assignments: [
        { subject: 'Maths',   class_name: '10', section: 'A' },
        { subject: 'Maths',   class_name: '10', section: 'B' },
      ],
    },
    {
      email: 'demoteacher2@eduvo.com',
      name: 'Demo Teacher Two',
      assignments: [
        { subject: 'Science', class_name: '10', section: 'A' },
        { subject: 'English', class_name: '10', section: 'A' },
      ],
    },
    {
      email: 'demoteacher3@eduvo.com',
      name: 'Demo Teacher Three',
      assignments: [
        { subject: 'Hindi',    class_name: '9', section: 'A' },
        { subject: 'Gujarati', class_name: '9', section: 'A' },
      ],
    },
  ];
  await seedTeachers(demoSchoolId, schoolAdminId, demoTeacherDefs);

  // ── Students for Test School ──────────────────────────────────────────────
  // 5 in Class 9A, 5 in Class 10A, 5 in Class 10B = 15 total
  // parent@eduvo.com has 2 children (multi-child test)
  // parent2 has 2 children, rest have 1 each
  const testStudentDefs: StudentDef[] = [
    // Class 9A — 5 students
    { full_name: 'Aarav Sharma',   class_name: '9',  section: 'A', roll_number: '9A01', parentEmail: 'parent@eduvo.com' },
    { full_name: 'Diya Patel',     class_name: '9',  section: 'A', roll_number: '9A02', parentEmail: 'parent@eduvo.com' }, // 2nd child of mainParent
    { full_name: 'Rohan Mehta',    class_name: '9',  section: 'A', roll_number: '9A03', parentEmail: 'parent2@eduvo.com' },
    { full_name: 'Priya Singh',    class_name: '9',  section: 'A', roll_number: '9A04', parentEmail: 'parent2@eduvo.com' }, // 2nd child of parent2
    { full_name: 'Karan Joshi',    class_name: '9',  section: 'A', roll_number: '9A05', parentEmail: 'parent3@eduvo.com' },
    // Class 10A — 5 students
    { full_name: 'Ananya Gupta',   class_name: '10', section: 'A', roll_number: '10A01', parentEmail: 'parent3@eduvo.com' },
    { full_name: 'Vivek Rao',      class_name: '10', section: 'A', roll_number: '10A02', parentEmail: 'parent4@eduvo.com' },
    { full_name: 'Sneha Desai',    class_name: '10', section: 'A', roll_number: '10A03', parentEmail: 'parent4@eduvo.com' },
    { full_name: 'Arjun Nair',     class_name: '10', section: 'A', roll_number: '10A04', parentEmail: 'parent5@eduvo.com' },
    { full_name: 'Meera Iyer',     class_name: '10', section: 'A', roll_number: '10A05', parentEmail: 'parent5@eduvo.com' },
    // Class 10B — 5 students
    { full_name: 'Rahul Verma',    class_name: '10', section: 'B', roll_number: '10B01', parentEmail: 'parent@eduvo.com' },
    { full_name: 'Pooja Agarwal',  class_name: '10', section: 'B', roll_number: '10B02', parentEmail: 'parent2@eduvo.com' },
    { full_name: 'Siddharth Bose', class_name: '10', section: 'B', roll_number: '10B03', parentEmail: 'parent3@eduvo.com' },
    { full_name: 'Kavya Reddy',    class_name: '10', section: 'B', roll_number: '10B04', parentEmail: 'parent4@eduvo.com' },
    { full_name: 'Nikhil Tiwari',  class_name: '10', section: 'B', roll_number: '10B05', parentEmail: 'parent5@eduvo.com' },
  ];

  const testParentIds: Record<string, string> = {
    'parent@eduvo.com':  mainParentId,
    'parent2@eduvo.com': parent2Id,
    'parent3@eduvo.com': parent3Id,
    'parent4@eduvo.com': parent4Id,
    'parent5@eduvo.com': parent5Id,
  };

  const testStudentIds = await seedStudents(testSchoolId, testStudentDefs, testParentIds);

  // ── Students for Demo School ──────────────────────────────────────────────
  const demoStudentDefs: StudentDef[] = [
    { full_name: 'Demo Student 1',  class_name: '9',  section: 'A', roll_number: 'D9A01',  parentEmail: 'demoparent1@eduvo.com' },
    { full_name: 'Demo Student 2',  class_name: '9',  section: 'A', roll_number: 'D9A02',  parentEmail: 'demoparent1@eduvo.com' },
    { full_name: 'Demo Student 3',  class_name: '9',  section: 'A', roll_number: 'D9A03',  parentEmail: 'demoparent2@eduvo.com' },
    { full_name: 'Demo Student 4',  class_name: '9',  section: 'A', roll_number: 'D9A04',  parentEmail: 'demoparent2@eduvo.com' },
    { full_name: 'Demo Student 5',  class_name: '9',  section: 'A', roll_number: 'D9A05',  parentEmail: 'demoparent1@eduvo.com' },
    { full_name: 'Demo Student 6',  class_name: '10', section: 'A', roll_number: 'D10A01', parentEmail: 'demoparent1@eduvo.com' },
    { full_name: 'Demo Student 7',  class_name: '10', section: 'A', roll_number: 'D10A02', parentEmail: 'demoparent2@eduvo.com' },
    { full_name: 'Demo Student 8',  class_name: '10', section: 'A', roll_number: 'D10A03', parentEmail: 'demoparent2@eduvo.com' },
    { full_name: 'Demo Student 9',  class_name: '10', section: 'A', roll_number: 'D10A04', parentEmail: 'demoparent1@eduvo.com' },
    { full_name: 'Demo Student 10', class_name: '10', section: 'A', roll_number: 'D10A05', parentEmail: 'demoparent2@eduvo.com' },
    { full_name: 'Demo Student 11', class_name: '10', section: 'B', roll_number: 'D10B01', parentEmail: 'demoparent1@eduvo.com' },
    { full_name: 'Demo Student 12', class_name: '10', section: 'B', roll_number: 'D10B02', parentEmail: 'demoparent2@eduvo.com' },
    { full_name: 'Demo Student 13', class_name: '10', section: 'B', roll_number: 'D10B03', parentEmail: 'demoparent1@eduvo.com' },
    { full_name: 'Demo Student 14', class_name: '10', section: 'B', roll_number: 'D10B04', parentEmail: 'demoparent2@eduvo.com' },
    { full_name: 'Demo Student 15', class_name: '10', section: 'B', roll_number: 'D10B05', parentEmail: 'demoparent1@eduvo.com' },
  ];

  const demoParentIds: Record<string, string> = {
    'demoparent1@eduvo.com': demoParent1Id,
    'demoparent2@eduvo.com': demoParent2Id,
  };

  const demoStudentIds = await seedStudents(demoSchoolId, demoStudentDefs, demoParentIds);

  // ── Attendance ────────────────────────────────────────────────────────────
  const attendanceRecorderId = teacherSeedId ?? schoolAdminId;
  await seedAttendance(testStudentIds, attendanceRecorderId);
  await seedAttendance(demoStudentIds, schoolAdminId);

  // ── Fees ──────────────────────────────────────────────────────────────────
  await seedFees(testStudentIds, testSchoolId, schoolAdminId);
  await seedFees(demoStudentIds, demoSchoolId, schoolAdminId);

  // ── Tests for Test School ─────────────────────────────────────────────────
  const testSchoolTestDefs: TestDef[] = [
    // Class 9A — 3 tests
    { title: 'Maths Unit Test 1',    subject: 'Maths',    class_name: '9',  section: 'A', term: 'Term 1', date: daysAgo(20) },
    { title: 'Hindi Mid-Term',       subject: 'Hindi',    class_name: '9',  section: 'A', term: 'Term 1', date: daysAgo(15) },
    { title: 'Gujarati Quiz 1',      subject: 'Gujarati', class_name: '9',  section: 'A', term: 'Term 1', date: daysAgo(10) },
    // Class 10A — 3 tests
    { title: 'Maths Unit Test 1',    subject: 'Maths',    class_name: '10', section: 'A', term: 'Term 1', date: daysAgo(20) },
    { title: 'Science Mid-Term',     subject: 'Science',  class_name: '10', section: 'A', term: 'Term 1', date: daysAgo(15) },
    { title: 'English Quiz 1',       subject: 'English',  class_name: '10', section: 'A', term: 'Term 1', date: daysAgo(10) },
    // Class 10B — 3 tests
    { title: 'Maths Unit Test 1',    subject: 'Maths',    class_name: '10', section: 'B', term: 'Term 1', date: daysAgo(20) },
    { title: 'Science Mid-Term',     subject: 'Science',  class_name: '10', section: 'B', term: 'Term 1', date: daysAgo(15) },
    { title: 'English Quiz 1',       subject: 'English',  class_name: '10', section: 'B', term: 'Term 1', date: daysAgo(10) },
  ];

  const testCreatorId = teacherSeedId ?? schoolAdminId;
  const testSchoolTestIds = await seedTests(testSchoolId, testCreatorId, testSchoolTestDefs);

  // ── Tests for Demo School ─────────────────────────────────────────────────
  const demoSchoolTestDefs: TestDef[] = [
    { title: 'Maths Unit Test 1',    subject: 'Maths',    class_name: '9',  section: 'A', term: 'Term 1', date: daysAgo(20) },
    { title: 'Hindi Mid-Term',       subject: 'Hindi',    class_name: '9',  section: 'A', term: 'Term 1', date: daysAgo(15) },
    { title: 'Gujarati Quiz 1',      subject: 'Gujarati', class_name: '9',  section: 'A', term: 'Term 1', date: daysAgo(10) },
    { title: 'Maths Unit Test 1',    subject: 'Maths',    class_name: '10', section: 'A', term: 'Term 1', date: daysAgo(20) },
    { title: 'Science Mid-Term',     subject: 'Science',  class_name: '10', section: 'A', term: 'Term 1', date: daysAgo(15) },
    { title: 'English Quiz 1',       subject: 'English',  class_name: '10', section: 'A', term: 'Term 1', date: daysAgo(10) },
    { title: 'Maths Unit Test 1',    subject: 'Maths',    class_name: '10', section: 'B', term: 'Term 1', date: daysAgo(20) },
    { title: 'Science Mid-Term',     subject: 'Science',  class_name: '10', section: 'B', term: 'Term 1', date: daysAgo(15) },
    { title: 'English Quiz 1',       subject: 'English',  class_name: '10', section: 'B', term: 'Term 1', date: daysAgo(10) },
  ];

  const demoTeacher1Id = await getUserIdByEmail('demoteacher1@eduvo.com') ?? schoolAdminId;
  const demoSchoolTestIds = await seedTests(demoSchoolId, demoTeacher1Id, demoSchoolTestDefs);

  // ── Test attempts: 3 students per test ───────────────────────────────────
  console.log('\n── Test Attempts ────────────────────────────────────────────');

  // Test School: group students by class/section
  const class9AStudents  = testStudentIds.slice(0, 5);   // indices 0-4
  const class10AStudents = testStudentIds.slice(5, 10);  // indices 5-9
  const class10BStudents = testStudentIds.slice(10, 15); // indices 10-14

  // Tests 0-2 are for 9A, 3-5 for 10A, 6-8 for 10B
  const testSchoolGroups = [
    { testIds: testSchoolTestIds.slice(0, 3), students: class9AStudents },
    { testIds: testSchoolTestIds.slice(3, 6), students: class10AStudents },
    { testIds: testSchoolTestIds.slice(6, 9), students: class10BStudents },
  ];

  for (const group of testSchoolGroups) {
    for (const testId of group.testIds) {
      if (!testId) continue;
      const attemptStudents = group.students.slice(0, 3); // 3 students per test
      console.log(`  Test ${testId} — attempting with 3 students`);
      await seedTestAttempts(testId, attemptStudents, testSchoolId);
    }
  }

  // Demo School attempts
  const demoClass9AStudents  = demoStudentIds.slice(0, 5);
  const demoClass10AStudents = demoStudentIds.slice(5, 10);
  const demoClass10BStudents = demoStudentIds.slice(10, 15);

  const demoSchoolGroups = [
    { testIds: demoSchoolTestIds.slice(0, 3), students: demoClass9AStudents },
    { testIds: demoSchoolTestIds.slice(3, 6), students: demoClass10AStudents },
    { testIds: demoSchoolTestIds.slice(6, 9), students: demoClass10BStudents },
  ];

  for (const group of demoSchoolGroups) {
    for (const testId of group.testIds) {
      if (!testId) continue;
      const attemptStudents = group.students.slice(0, 3);
      console.log(`  Test ${testId} — attempting with 3 students`);
      await seedTestAttempts(testId, attemptStudents, demoSchoolId);
    }
  }

  // ── Complaints ────────────────────────────────────────────────────────────
  await seedComplaints(
    testSchoolId,
    [mainParentId, parent2Id, parent3Id],
    testStudentIds,
    schoolAdminId
  );
  await seedComplaints(
    demoSchoolId,
    [demoParent1Id, demoParent2Id, demoParent1Id],
    demoStudentIds,
    schoolAdminId
  );

  // ── Announcements ─────────────────────────────────────────────────────────
  await seedAnnouncements(testSchoolId, schoolAdminId);
  await seedAnnouncements(demoSchoolId, schoolAdminId);

  // ── Notifications ─────────────────────────────────────────────────────────
  const allTestParentIds = [mainParentId, parent2Id, parent3Id, parent4Id, parent5Id];
  await seedNotifications(allTestParentIds, schoolAdminId);
  await seedNotifications([demoParent1Id, demoParent2Id], schoolAdminId);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║              Seed Complete — Login Credentials       ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  superadmin@eduvo.com     / Test@1234  (superadmin)  ║');
  console.log('║  schooladmin@eduvo.com    / Test@1234  (schooladmin) ║');
  console.log('║  teacher@eduvo.com        / Test@1234  (teacher)     ║');
  console.log('║  parent@eduvo.com         / Test@1234  (parent)      ║');
  console.log('║    └─ has 2 children: Aarav Sharma + Diya Patel      ║');
  console.log('║  student@eduvo.com        / Test@1234  (student)     ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  Extra teachers: teacher2@eduvo.com / Test@1234      ║');
  console.log('║                  teacher3@eduvo.com / Test@1234      ║');
  console.log('║  Extra parents:  parent2-5@eduvo.com / Test@1234     ║');
  console.log('║  Demo school:    demoteacher1-3@eduvo.com / Test@1234║');
  console.log('║                  demoparent1-2@eduvo.com / Test@1234 ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  Test School  → 15 students, 9 tests, 30 att/student ║');
  console.log('║  Demo Coaching → 15 students, 9 tests, 30 att/student║');
  console.log('╚══════════════════════════════════════════════════════╝');
}

main().catch((err: Error) => {
  console.error('[fatal] Seed script crashed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
