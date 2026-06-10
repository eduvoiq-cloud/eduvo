/// <reference types="node" />
/**
 * verify-gujarati-medium.ts
 *
 * Verification script for the Gujarati medium demo seed.
 * Checks every seeded entity directly against the database.
 *
 * Run with:
 *   npx ts-node src/scripts/verify-gujarati-medium.ts
 */

import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { supabaseAdmin } from '../config/supabase';

const ENGLISH_SCHOOL_NAME = 'Test School';
const GUJ_PARENT_SCHOOL_ID = '8b7094ff-cf5b-454e-97db-c1eb0fba73f8';
const GUJ_SCHOOL_ID        = '775794fd-aa3c-4245-8f93-e60515b7aac6';
const ADMIN_EMAIL          = 'schooladmin@eduvo.com';

const EXPECTED_TEACHERS = [
  { name: 'Aarti Patel',     email: 'aarti@eduvo.com',     subject: 'Maths' },
  { name: 'Bhavesh Shah',    email: 'bhavesh@eduvo.com',   subject: 'Science' },
  { name: 'Chandrika Joshi', email: 'chandrika@eduvo.com', subject: 'Gujarati' },
  { name: 'Dinesh Trivedi',  email: 'dinesh@eduvo.com',    subject: 'Hindi' },
  { name: 'Ekta Desai',      email: 'ekta@eduvo.com',      subject: 'English' },
  { name: 'Falgun Mehta',    email: 'falgun@eduvo.com',    subject: 'Social Science' },
  { name: 'Girish Solanki',  email: 'girish@eduvo.com',    subject: 'Computer' },
  { name: 'Hansa Bhatt',     email: 'hansa@eduvo.com',     subject: 'Sanskrit' },
];

const PHONE_NUMBERS: Record<string, string> = {
  'Aarav Shah': '9876541001', 'Diya Patel': '9823451002', 'Rohan Mehta': '9712341003',
  'Priya Singh': '9654321004', 'Karan Joshi': '9543211005',
  'Vivek Rao': '9432101006', 'Sneha Desai': '9321001007', 'Arjun Nair': '9210001008',
  'Meera Iyer': '9876541009', 'Pooja Agarwal': '9823451010',
  'Siddharth Kumar': '9765431011', 'Kavya Reddy': '9654321012', 'Nikhil Tiwari': '9543211013',
  'Ananya Gupta': '9432101014', 'Reyansh Modi': '9321001015',
  'Myra Trivedi': '9210001016', 'Advait Rao': '9876541017', 'Kiara Bhatt': '9823451018',
  'Arjun Singh': '9765431019', 'Riya Kapoor': '9654321020',
  'Dhruv Verma': '9543211021', 'Sara Nair': '9432101022', 'Kabir Gupta': '9321001023',
  'Krish Patel': '9210001024', 'Aarav Patil': '9876542025',
  'Vivaan Joshi': '9823452026', 'Anaya Desai': '9765432027', 'Krish Trivedi': '9654322028',
  'Myra Mehta': '9543212029', 'Kiara Modi': '9432102030',
  'Aditya Rao': '9321002031', 'Ishita Mehta': '9210002032', 'Reyansh Nair': '9876542033',
  'Kabir Shah': '9823452034', 'Diya Joshi': '9765432035',
  'Rudra Bhatt': '9654322036', 'Arjun Patel': '9543212037', 'Sara Trivedi': '9432102038',
  'Vivaan Desai': '9321002039', 'Aarav Mehta': '9210002040',
};

const CLASS_SECTIONS = [
  { class_name: '9',  section: 'A' },
  { class_name: '9',  section: 'B' },
  { class_name: '10', section: 'A' },
  { class_name: '10', section: 'B' },
  { class_name: '11', section: 'A' },
  { class_name: '11', section: 'B' },
  { class_name: '12', section: 'A' },
  { class_name: '12', section: 'B' },
];

let passCount = 0;
let failCount = 0;

function pass(msg: string) {
  console.log(`  ✓ PASS  ${msg}`);
  passCount++;
}

function fail(msg: string) {
  console.log(`  ✗ FAIL  ${msg}`);
  failCount++;
}

function section(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 55 - title.length))}`);
}

// ─────────────────────────────────────────────────────────────────────────────

async function verifySchool(): Promise<void> {
  section('CHECK 1: School Records');

  // English school
  const { data: eng } = await supabaseAdmin
    .from('schools')
    .select('id, name, medium, parent_school_id')
    .eq('id', GUJ_PARENT_SCHOOL_ID)
    .maybeSingle();

  if (eng) {
    pass(`English school exists: "${eng.name}" (${eng.id})`);
    const med = (eng as Record<string, unknown>).medium;
    if (med === 'english' || med === null) pass(`English school medium = "${med ?? 'null (pre-migration default)'}"`);
    else fail(`English school medium = "${med}" (expected english or null)`);
  } else {
    fail(`English school ${GUJ_PARENT_SCHOOL_ID} NOT FOUND`);
  }

  // Gujarati school
  const { data: guj } = await supabaseAdmin
    .from('schools')
    .select('id, name, medium, parent_school_id')
    .eq('id', GUJ_SCHOOL_ID)
    .maybeSingle();

  if (guj) {
    const g = guj as Record<string, unknown>;
    pass(`Gujarati school exists (${g.id})`);
    if ((g.medium as string) === 'gujarati') pass(`Gujarati school medium = "gujarati"`);
    else fail(`Gujarati school medium = "${g.medium}" (expected gujarati)`);
    if ((g.parent_school_id as string) === GUJ_PARENT_SCHOOL_ID) pass(`parent_school_id correctly linked to English school`);
    else fail(`parent_school_id = "${g.parent_school_id}" (expected ${GUJ_PARENT_SCHOOL_ID})`);
  } else {
    fail(`Gujarati school ${GUJ_SCHOOL_ID} NOT FOUND`);
  }
}

async function verifyAdminAccess(): Promise<void> {
  section('CHECK 2: Admin Account & School Access');

  const { data: admin } = await supabaseAdmin
    .from('users')
    .select('id, email, role, school_id')
    .eq('email', ADMIN_EMAIL)
    .eq('role', 'schooladmin')
    .maybeSingle();

  if (admin) {
    const a = admin as Record<string, unknown>;
    pass(`Admin exists: ${a.email} (${a.id})`);

    // Check school_admin_access for both schools
    const { data: accessRows } = await supabaseAdmin
      .from('school_admin_access')
      .select('school_id')
      .eq('admin_id', a.id as string);

    const accessIds = (accessRows ?? []).map((r: Record<string, unknown>) => r.school_id as string);

    if (accessIds.includes(GUJ_PARENT_SCHOOL_ID)) {
      pass(`Admin has access to English school via school_admin_access`);
    } else {
      fail(`Admin MISSING access to English school in school_admin_access`);
    }

    if (accessIds.includes(GUJ_SCHOOL_ID)) {
      pass(`Admin has access to Gujarati school via school_admin_access`);
    } else {
      fail(`Admin MISSING access to Gujarati school in school_admin_access`);
    }
  } else {
    fail(`Admin ${ADMIN_EMAIL} NOT FOUND or not a schooladmin`);
  }
}

async function verifyTeachers(): Promise<Map<string, string>> {
  section('CHECK 3: Teachers (8 expected)');

  const teacherIdByEmail = new Map<string, string>();

  const { data: teachers, error } = await supabaseAdmin
    .from('users')
    .select('id, name, email, role, school_id')
    .eq('school_id', GUJ_SCHOOL_ID)
    .eq('role', 'teacher')
    .eq('is_deleted', false);

  if (error) { fail(`Failed to fetch teachers: ${error.message}`); return teacherIdByEmail; }

  const count = (teachers ?? []).length;
  if (count === 8) pass(`Correct teacher count: 8`);
  else fail(`Teacher count: ${count} (expected 8)`);

  for (const expected of EXPECTED_TEACHERS) {
    const found = (teachers ?? []).find(
      (t: Record<string, unknown>) => (t.email as string).toLowerCase() === expected.email.toLowerCase()
    ) as Record<string, unknown> | undefined;

    if (found) {
      pass(`Teacher exists: ${expected.name} <${expected.email}>`);
      teacherIdByEmail.set(expected.email, found.id as string);

      if ((found.school_id as string) === GUJ_SCHOOL_ID) {
        pass(`  school_id correctly scoped to Gujarati school`);
      } else {
        fail(`  school_id = ${found.school_id} (expected Gujarati ${GUJ_SCHOOL_ID})`);
      }
    } else {
      fail(`Teacher MISSING: ${expected.name} <${expected.email}>`);
    }
  }

  return teacherIdByEmail;
}

async function verifyTeacherPasswords(): Promise<void> {
  section('CHECK 4: Teacher Auth (password = Test@1234)');

  for (const t of EXPECTED_TEACHERS) {
    try {
      const { data: authResp, error } = await supabaseAdmin.auth.signInWithPassword({
        email:    t.email,
        password: 'Test@1234',
      });
      if (error || !authResp?.session) {
        fail(`Login FAILED for ${t.email}: ${error?.message ?? 'no session'}`);
      } else {
        pass(`Login OK: ${t.email}`);
        // Sign out immediately to avoid session pollution
        await supabaseAdmin.auth.signOut();
      }
    } catch (err) {
      fail(`Login ERROR for ${t.email}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function verifyAssignments(teacherIdByEmail: Map<string, string>): Promise<void> {
  section('CHECK 5: Teacher Assignments (8 teachers × 8 classes = 64)');

  const { data: assignments, error } = await supabaseAdmin
    .from('teacher_assignments')
    .select('teacher_id, class_name, section, subject')
    .eq('school_id', GUJ_SCHOOL_ID);

  if (error) { fail(`Failed to fetch assignments: ${error.message}`); return; }

  const totalAssignments = (assignments ?? []).length;
  if (totalAssignments === 64) pass(`Total assignments: 64`);
  else fail(`Total assignments: ${totalAssignments} (expected 64)`);

  // Check each teacher has 8 class assignments
  for (const t of EXPECTED_TEACHERS) {
    const tid = teacherIdByEmail.get(t.email);
    if (!tid) continue;
    const teacherAssignments = (assignments ?? []).filter(
      (a: Record<string, unknown>) => (a.teacher_id as string) === tid
    );
    if (teacherAssignments.length === 8) {
      pass(`${t.name} (${t.subject}) → 8 class assignments`);
    } else {
      fail(`${t.name} → ${teacherAssignments.length} assignments (expected 8)`);
    }
  }
}

async function verifyStudents(): Promise<Map<string, Array<{ id: string; full_name: string; phone_number: string; password_hash: string }>>> {
  section('CHECK 6: Students (40 expected, 5 per class)');

  const studentsByClass = new Map<string, Array<{ id: string; full_name: string; phone_number: string; password_hash: string }>>();

  const { data: allStudents, error } = await supabaseAdmin
    .from('students')
    .select('id, full_name, class_name, section, roll_number, phone_number, password_hash, school_id')
    .eq('school_id', GUJ_SCHOOL_ID)
    .eq('is_deleted', false);

  if (error) { fail(`Failed to fetch students: ${error.message}`); return studentsByClass; }

  const total = (allStudents ?? []).length;
  if (total === 40) pass(`Total students: 40`);
  else fail(`Total students: ${total} (expected 40)`);

  for (const cls of CLASS_SECTIONS) {
    const key = `${cls.class_name}${cls.section}`;
    const classStudents = (allStudents ?? []).filter(
      (s: Record<string, unknown>) =>
        (s.class_name as string) === cls.class_name && (s.section as string) === cls.section
    ) as Array<{ id: string; full_name: string; phone_number: string; password_hash: string }>;

    if (classStudents.length === 5) pass(`Class ${key}: 5 students`);
    else fail(`Class ${key}: ${classStudents.length} students (expected 5)`);

    studentsByClass.set(key, classStudents);
  }

  // Verify school isolation — no Gujarati students in English school
  const { data: engStudents } = await supabaseAdmin
    .from('students')
    .select('id')
    .eq('school_id', GUJ_PARENT_SCHOOL_ID)
    .in('phone_number', Object.values(PHONE_NUMBERS))
    .eq('is_deleted', false);

  if ((engStudents ?? []).length === 0) {
    pass(`English school data not polluted (0 Gujarati students found there)`);
  } else {
    fail(`${(engStudents ?? []).length} Gujarati students found in English school — data pollution!`);
  }

  return studentsByClass;
}

async function verifyStudentPasswords(
  studentsByClass: Map<string, Array<{ id: string; full_name: string; phone_number: string; password_hash: string }>>
): Promise<void> {
  section('CHECK 7: Student Passwords (last 5 digits of phone)');

  let pwPass = 0;
  let pwFail = 0;

  for (const [classKey, students] of studentsByClass.entries()) {
    for (const student of students) {
      const expectedPw = student.phone_number.slice(-5);
      try {
        const matches = await bcrypt.compare(expectedPw, student.password_hash);
        if (matches) {
          pwPass++;
        } else {
          fail(`Password mismatch for ${student.full_name} (class ${classKey})`);
          pwFail++;
        }
      } catch (err) {
        fail(`bcrypt error for ${student.full_name}: ${err}`);
        pwFail++;
      }
    }
  }

  if (pwFail === 0) {
    pass(`All ${pwPass} student passwords verified — last 5 digits of phone`);
  } else {
    fail(`${pwFail} password mismatches out of ${pwPass + pwFail} students`);
  }
}

async function verifyMarks(
  studentsByClass: Map<string, Array<{ id: string; full_name: string; phone_number: string; password_hash: string }>>
): Promise<void> {
  section('CHECK 8: Marks (40 students × 8 subjects = 320 expected)');

  const allStudentIds: string[] = [];
  for (const students of studentsByClass.values()) {
    allStudentIds.push(...students.map((s) => s.id));
  }

  const { data: marks, error } = await supabaseAdmin
    .from('marks')
    .select('id, student_id, subject, score, max_score, term, exam_type')
    .in('student_id', allStudentIds)
    .eq('term', 'term_1')
    .eq('exam_type', 'final');

  if (error) { fail(`Failed to fetch marks: ${error.message}`); return; }

  const totalMarks = (marks ?? []).length;
  if (totalMarks === 320) pass(`Total mark entries: 320`);
  else fail(`Total mark entries: ${totalMarks} (expected 320)`);

  // Verify each student has exactly 8 marks
  let studentsWith8 = 0;
  for (const sid of allStudentIds) {
    const studentMarks = (marks ?? []).filter((m: Record<string, unknown>) => m.student_id === sid);
    if (studentMarks.length === 8) studentsWith8++;
    else fail(`Student ${sid} has ${studentMarks.length} marks (expected 8)`);
  }
  if (studentsWith8 === 40) pass(`All 40 students have exactly 8 marks each`);

  // Verify max_score = 100
  const wrongMaxScore = (marks ?? []).filter((m: Record<string, unknown>) => Number(m.max_score) !== 100);
  if (wrongMaxScore.length === 0) pass(`All marks have max_score = 100`);
  else fail(`${wrongMaxScore.length} marks with wrong max_score`);

  // Verify score range 10-100
  const outOfRange = (marks ?? []).filter((m: Record<string, unknown>) => {
    const s = Number(m.score);
    return s < 10 || s > 100;
  });
  if (outOfRange.length === 0) pass(`All marks have score in range 10-100`);
  else fail(`${outOfRange.length} marks with out-of-range scores`);

  // Class averages
  console.log('\n  Class averages (Final Term 1):');
  const classAvgs: Array<{ key: string; avg: number }> = [];

  for (const cls of CLASS_SECTIONS) {
    const key = `${cls.class_name}${cls.section}`;
    const students = studentsByClass.get(key) ?? [];
    const sids = students.map((s) => s.id);
    const classMarks = (marks ?? []).filter((m: Record<string, unknown>) => sids.includes(m.student_id as string));
    if (classMarks.length === 0) continue;

    const totalScore = classMarks.reduce((acc: number, m: Record<string, unknown>) => acc + Number(m.score), 0);
    const avg = totalScore / classMarks.length;
    classAvgs.push({ key, avg });
  }

  classAvgs.sort((a, b) => b.avg - a.avg);
  classAvgs.forEach((c, i) => {
    const tag = i === 0 ? '  ← BEST' : i === classAvgs.length - 1 ? '  ← LOWEST' : '';
    console.log(`    ${i + 1}. Class ${c.key} — ${c.avg.toFixed(1)} avg score${tag}`);
  });

  const best  = classAvgs[0];
  const worst = classAvgs[classAvgs.length - 1];

  if (best?.key === '12A') pass(`12A is highest avg class (as specified)`);
  else fail(`Expected 12A to be highest but got ${best?.key}`);

  if (worst?.key === '9B') pass(`9B is lowest avg class (as specified)`);
  else fail(`Expected 9B to be lowest but got ${worst?.key}`);
}

async function verifySubjects(): Promise<void> {
  section('CHECK 9: Subjects Table');

  const expectedSubjects = ['Maths', 'Science', 'Gujarati', 'Hindi', 'English', 'Social Science', 'Computer', 'Sanskrit'];

  const { data: subjects, error } = await supabaseAdmin
    .from('subjects')
    .select('name')
    .eq('school_id', GUJ_SCHOOL_ID);

  if (error) { fail(`Failed to fetch subjects: ${error.message}`); return; }

  const names = (subjects ?? []).map((s: Record<string, unknown>) => s.name as string);

  for (const expected of expectedSubjects) {
    if (names.some((n) => n.toLowerCase() === expected.toLowerCase())) {
      pass(`Subject "${expected}" exists`);
    } else {
      fail(`Subject "${expected}" MISSING`);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Eduvo — Gujarati Medium Verification Report                 ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  await verifySchool();
  await verifyAdminAccess();
  const teacherIdByEmail = await verifyTeachers();
  await verifyTeacherPasswords();
  await verifyAssignments(teacherIdByEmail);
  const studentsByClass = await verifyStudents();
  await verifyStudentPasswords(studentsByClass);
  await verifyMarks(studentsByClass);
  await verifySubjects();

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  RESULT: ${passCount} PASSED  |  ${failCount} FAILED`);
  if (failCount === 0) {
    console.log('  ✅ ALL CHECKS PASSED — Gujarati medium data is correct');
  } else {
    console.log('  ❌ SOME CHECKS FAILED — review above');
  }
  console.log('══════════════════════════════════════════════════════════════\n');
}

main().catch((err: Error) => {
  console.error('\n[fatal]', err.message);
  process.exit(1);
});
