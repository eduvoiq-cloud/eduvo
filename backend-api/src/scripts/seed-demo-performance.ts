/// <reference types="node" />
/**
 * seed-demo-performance.ts
 *
 * Seeds demo teachers, teacher assignments, and marks into TEST SCHOOL
 * to showcase the Monthly Performance Snapshot feature.
 *
 * Run with:
 *   npx ts-node src/scripts/seed-demo-performance.ts
 *
 * Safe to re-run: uses skip logic throughout.
 * NEVER creates new students or new classes — only reads existing ones.
 */

import 'dotenv/config';
import { supabaseAdmin } from '../config/supabase';

// ── Constants ──────────────────────────────────────────────────────────────────

const SCHOOL_NAME = 'Test School';
const DEFAULT_PASSWORD = 'Test@1234';

/** The 8 demo teachers we want to create. */
const DEMO_TEACHERS = [
  { name: 'Ramesh Patel',   email: 'rameshpatel@eduvo.com',   subject: 'Mathematics' },
  { name: 'Sunita Shah',    email: 'sunitashah@eduvo.com',    subject: 'Science' },
  { name: 'Meena Joshi',    email: 'meenajoshi@eduvo.com',    subject: 'Gujarati' },
  { name: 'Arvind Trivedi', email: 'arvindtrivedi@eduvo.com', subject: 'Hindi' },
  { name: 'Priya Desai',    email: 'priyadesai@eduvo.com',    subject: 'English' },
  { name: 'Kiran Mehta',    email: 'kiranmehta@eduvo.com',    subject: 'Social Science' },
  { name: 'Nilesh Solanki', email: 'nileshsolanki@eduvo.com', subject: 'Computer' },
  { name: 'Hetal Bhatt',    email: 'hetalbhatt@eduvo.com',    subject: 'Sanskrit' },
];

/** All 6 classes that exist in TEST SCHOOL. */
const CLASS_SECTIONS = [
  { class_name: '9',  section: 'A' },
  { class_name: '9',  section: 'B' },
  { class_name: '10', section: 'A' },
  { class_name: '10', section: 'B' },
  { class_name: '12', section: 'A' },
  { class_name: '12', section: 'B' },
];

/**
 * Class-level bias for marks generation.
 * Positive bias = class scores higher than baseline.
 * 12A → good, 10A → weak, others → mixed.
 */
const CLASS_BIAS: Record<string, number> = {
  '9A':  0,   // neutral
  '9B':  2,   // slight positive
  '10A': -12, // weakest class
  '10B': -3,  // slightly below average
  '12A': 10,  // best class
  '12B': 4,   // above average
};

// ── Mark generation helpers ────────────────────────────────────────────────────

/**
 * Seeded pseudo-random number generator (Mulberry32).
 * Same seed → same sequence, so the script is fully deterministic.
 */
function createRng(seed: number) {
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate a realistic mark (out of 100) based on:
 *   - a class-level bias applied to baseline ranges
 *   - a per-student consistent score tier
 */
function generateMark(
  studentSeed: number,
  subjectIndex: number,
  classBias: number,
  rng: () => number
): number {
  // Combine student seed + subject to get tier
  const tierRoll = (studentSeed + subjectIndex * 37) % 100;

  let baseMin: number;
  let baseMax: number;

  if (tierRoll < 10) {
    // Bottom 10%: 15–34 (red)
    baseMin = 15;
    baseMax = 34;
  } else if (tierRoll < 30) {
    // Next 20%: 35–49 (amber)
    baseMin = 35;
    baseMax = 49;
  } else if (tierRoll < 80) {
    // Middle 50%: 50–74 (average)
    baseMin = 50;
    baseMax = 74;
  } else {
    // Top 20%: 75–95 (good)
    baseMin = 75;
    baseMax = 95;
  }

  // Apply class bias
  const min = Math.max(10, Math.min(baseMin + classBias, 90));
  const max = Math.max(min + 5, Math.min(baseMax + classBias, 100));

  // Random value within band
  const score = Math.round(min + rng() * (max - min));
  return Math.max(10, Math.min(100, score));
}

// ── Database helpers ───────────────────────────────────────────────────────────

async function getSchoolId(): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('schools')
    .select('id')
    .ilike('name', SCHOOL_NAME)
    .single();

  if (error || !data) {
    throw new Error(`School "${SCHOOL_NAME}" not found. Have you run the main seed script?`);
  }
  return data.id as string;
}

async function getSchoolAdminId(schoolId: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('school_id', schoolId)
    .eq('role', 'schooladmin')
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    throw new Error(`No schooladmin found for TEST SCHOOL. Cannot proceed.`);
  }
  return data.id as string;
}

async function getUserIdByEmail(email: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('email', email)
    .maybeSingle();
  return data?.id ?? null;
}

// ── Step 1: Create demo teachers ───────────────────────────────────────────────

async function seedTeachers(
  schoolId: string,
  adminId: string
): Promise<Map<string, string>> {
  console.log('\n── Step 1: Creating Demo Teachers ───────────────────────────');
  const teacherIdByEmail = new Map<string, string>();
  let created = 0;
  let skipped = 0;

  for (const t of DEMO_TEACHERS) {
    let userId = await getUserIdByEmail(t.email);

    if (userId) {
      console.log(`  [skip] ${t.email} already exists (${userId})`);
      skipped++;
    } else {
      // Create Supabase auth user
      const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
        email: t.email,
        password: DEFAULT_PASSWORD,
        email_confirm: true,
      });

      if (authErr || !authData?.user) {
        console.warn(`  [warn] Auth creation failed for ${t.email}: ${authErr?.message}`);
        continue;
      }

      userId = authData.user.id;

      // Insert users profile row
      const { error: profileErr } = await supabaseAdmin.from('users').insert({
        id: userId,
        name: t.name,
        email: t.email,
        role: 'teacher',
        school_id: schoolId,
        created_by: adminId,
        created_at: new Date().toISOString(),
      });

      if (profileErr) {
        await supabaseAdmin.auth.admin.deleteUser(userId);
        console.warn(`  [warn] Profile insert failed for ${t.email}: ${profileErr.message}`);
        continue;
      }

      console.log(`  [done] Created ${t.name} <${t.email}> (${userId})`);
      created++;
    }

    teacherIdByEmail.set(t.email, userId!);
  }

  console.log(`\n  Summary: ${created} teachers created, ${skipped} already existed.`);
  return teacherIdByEmail;
}

// ── Step 2: Assign teachers to all classes ─────────────────────────────────────

async function seedAssignments(
  schoolId: string,
  teacherIdByEmail: Map<string, string>
): Promise<void> {
  console.log('\n── Step 2: Assigning Teachers to Classes ────────────────────');
  let created = 0;
  let skipped = 0;

  for (const t of DEMO_TEACHERS) {
    const teacherId = teacherIdByEmail.get(t.email);
    if (!teacherId) {
      console.warn(`  [warn] No teacher ID for ${t.email} — skipping assignments`);
      continue;
    }

    for (const cls of CLASS_SECTIONS) {
      // Check if assignment already exists
      const { data: existing } = await supabaseAdmin
        .from('teacher_assignments')
        .select('id')
        .eq('teacher_id', teacherId)
        .eq('school_id', schoolId)
        .eq('class_name', cls.class_name)
        .eq('section', cls.section)
        .eq('subject', t.subject)
        .maybeSingle();

      if (existing) {
        skipped++;
        continue;
      }

      const { error } = await supabaseAdmin.from('teacher_assignments').insert({
        teacher_id: teacherId,
        school_id: schoolId,
        class_name: cls.class_name,
        class: cls.class_name,   // legacy NOT NULL column — keep in sync
        section: cls.section,
        subject: t.subject,
      });

      if (error) {
        console.warn(`  [warn] Assignment ${t.name} → ${cls.class_name}${cls.section}: ${error.message}`);
      } else {
        console.log(`  [done] ${t.name} (${t.subject}) → Class ${cls.class_name}${cls.section}`);
        created++;
      }
    }
  }

  console.log(`\n  Summary: ${created} assignments created, ${skipped} already existed.`);
}

// ── Step 3: Ensure all subjects exist in this school ──────────────────────────

async function seedSubjects(schoolId: string): Promise<void> {
  console.log('\n── Step 3: Ensuring Subjects Exist in School ────────────────');
  const subjectNames = DEMO_TEACHERS.map((t) => t.subject);

  for (const name of subjectNames) {
    const { data: existing } = await supabaseAdmin
      .from('subjects')
      .select('id')
      .eq('school_id', schoolId)
      .ilike('name', name)
      .maybeSingle();

    if (existing) {
      console.log(`  [skip] Subject "${name}" already exists`);
      continue;
    }

    const { error } = await supabaseAdmin.from('subjects').insert({
      name,
      school_id: schoolId,
    });

    if (error) {
      console.warn(`  [warn] Failed to create subject "${name}": ${error.message}`);
    } else {
      console.log(`  [done] Created subject "${name}"`);
    }
  }
}

// ── Step 4: Fetch all existing students per class ──────────────────────────────

async function fetchStudentsByClass(
  schoolId: string
): Promise<Map<string, Array<{ id: string; full_name: string }>>> {
  console.log('\n── Step 4: Fetching Existing Students ───────────────────────');
  const result = new Map<string, Array<{ id: string; full_name: string }>>();

  for (const cls of CLASS_SECTIONS) {
    const { data: students, error } = await supabaseAdmin
      .from('students')
      .select('id, full_name')
      .eq('school_id', schoolId)
      .eq('class_name', cls.class_name)
      .eq('section', cls.section)
      .eq('is_deleted', false)
      .order('roll_number', { ascending: true });

    if (error) {
      console.warn(`  [warn] Failed to fetch students for ${cls.class_name}${cls.section}: ${error.message}`);
      continue;
    }

    const key = `${cls.class_name}${cls.section}`;
    result.set(key, students ?? []);
    console.log(`  ${key}: ${(students ?? []).length} students found`);
  }

  return result;
}

// ── Step 5: Insert marks for all students ─────────────────────────────────────

async function seedMarks(
  adminId: string,
  studentsByClass: Map<string, Array<{ id: string; full_name: string }>>
): Promise<number> {
  console.log('\n── Step 5: Entering Marks ────────────────────────────────────');

  // All marks go in for the current month so the snapshot shows them immediately
  const now = new Date();
  const markDate = new Date(now.getFullYear(), now.getMonth(), 15).toISOString(); // 15th of current month

  const subjects = DEMO_TEACHERS.map((t) => t.subject);
  const TERM = 'term_1';
  const EXAM_TYPE = 'final';
  const MAX_SCORE = 100;

  let totalInserted = 0;
  let totalSkipped = 0;

  for (const cls of CLASS_SECTIONS) {
    const classKey = `${cls.class_name}${cls.section}`;
    const students = studentsByClass.get(classKey) ?? [];
    const classBias = CLASS_BIAS[classKey] ?? 0;

    if (students.length === 0) {
      console.log(`  [skip] No students found for ${classKey}`);
      continue;
    }

    console.log(`\n  Processing ${classKey} (${students.length} students, bias: ${classBias > 0 ? '+' : ''}${classBias})...`);

    for (let si = 0; si < students.length; si++) {
      const student = students[si];

      // Use a deterministic seed derived from student position + class to generate
      // consistent marks across re-runs. Same student always gets same tier.
      const studentSeed = (si + 1) * 31 + classKey.charCodeAt(0) + classKey.charCodeAt(1);
      const rng = createRng(studentSeed * 9973);

      for (let subIdx = 0; subIdx < subjects.length; subIdx++) {
        const subject = subjects[subIdx];

        // Check if this student already has a mark for this subject + term + exam_type
        const { data: existing } = await supabaseAdmin
          .from('marks')
          .select('id')
          .eq('student_id', student.id)
          .eq('subject', subject)
          .eq('term', TERM)
          .eq('exam_type', EXAM_TYPE)
          .maybeSingle();

        if (existing) {
          totalSkipped++;
          continue;
        }

        const score = generateMark(studentSeed, subIdx, classBias, rng);

        const { error } = await supabaseAdmin.from('marks').insert({
          student_id: student.id,
          subject,
          score,
          max_score: MAX_SCORE,
          term: TERM,
          exam_type: EXAM_TYPE,
          notes: `Demo mark — Final Exam Term 1`,
          recorded_by: adminId,
          created_at: markDate,
        });

        if (error) {
          console.warn(`    [warn] Mark insert for ${student.full_name} / ${subject}: ${error.message}`);
        } else {
          totalInserted++;
        }
      }
    }

    console.log(`  [done] ${classKey} marks processed`);
  }

  console.log(`\n  Total marks inserted: ${totalInserted}, skipped (already existed): ${totalSkipped}`);
  return totalInserted;
}

// ── Step 6: Print summary ──────────────────────────────────────────────────────

async function printSummary(
  schoolId: string,
  teachersCreated: number,
  marksInserted: number
): Promise<void> {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  SEED COMPLETE — SUMMARY');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Teachers created  : ${teachersCreated}`);
  console.log(`  Mark entries added: ${marksInserted}`);

  // Calculate per-class averages
  const classAvgs: Array<{ classKey: string; avg: number; studentCount: number }> = [];

  for (const cls of CLASS_SECTIONS) {
    const classKey = `${cls.class_name}${cls.section}`;

    // Get all students in this class
    const { data: students } = await supabaseAdmin
      .from('students')
      .select('id')
      .eq('school_id', schoolId)
      .eq('class_name', cls.class_name)
      .eq('section', cls.section)
      .eq('is_deleted', false);

    if (!students || students.length === 0) continue;

    const studentIds = students.map((s: { id: string }) => s.id);

    // Get marks for this month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();

    const { data: marks } = await supabaseAdmin
      .from('marks')
      .select('score, max_score')
      .in('student_id', studentIds)
      .gte('created_at', monthStart)
      .lte('created_at', monthEnd);

    if (!marks || marks.length === 0) continue;

    const totalScore = marks.reduce((s: number, m: { score: number }) => s + Number(m.score), 0);
    const totalMax   = marks.reduce((s: number, m: { max_score: number }) => s + Number(m.max_score), 0);
    const avg = totalMax > 0 ? Math.round((totalScore / totalMax) * 1000) / 10 : 0;

    classAvgs.push({ classKey, avg, studentCount: students.length });
  }

  if (classAvgs.length > 0) {
    classAvgs.sort((a, b) => b.avg - a.avg);
    console.log('\n  Class Rankings (highest → lowest avg %):');
    classAvgs.forEach((c, i) => {
      const label = i === 0 ? '  ← BEST' : i === classAvgs.length - 1 ? '  ← LOWEST' : '';
      console.log(`    ${i + 1}. Class ${c.classKey} — ${c.avg.toFixed(1)}% (${c.studentCount} students)${label}`);
    });

    const best   = classAvgs[0];
    const worst  = classAvgs[classAvgs.length - 1];
    console.log(`\n  Highest avg class : ${best.classKey}  (${best.avg.toFixed(1)}%)`);
    console.log(`  Lowest avg class  : ${worst.classKey} (${worst.avg.toFixed(1)}%)`);
  }

  console.log('\n  ✔ Open the admin dashboard → Monthly Performance Snapshot');
  console.log('    to verify rankings, top 10, and bottom 10 students.');
  console.log('══════════════════════════════════════════════════════════════\n');
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Eduvo — Demo Performance Seed Script                        ║');
  console.log('║  Target school: TEST SCHOOL                                  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // 1. Resolve school
  const schoolId = await getSchoolId();
  console.log(`\n  School ID: ${schoolId}`);

  const adminId = await getSchoolAdminId(schoolId);
  console.log(`  Admin  ID: ${adminId}`);

  // 2. Ensure subjects exist
  await seedSubjects(schoolId);

  // 3. Create teachers
  const teacherIdByEmail = await seedTeachers(schoolId, adminId);
  const teachersCreated = [...teacherIdByEmail.values()].length;

  // 4. Assign teachers to all 6 classes
  await seedAssignments(schoolId, teacherIdByEmail);

  // 5. Fetch existing students per class
  const studentsByClass = await fetchStudentsByClass(schoolId);

  // 6. Insert marks
  const marksInserted = await seedMarks(adminId, studentsByClass);

  // 7. Print summary
  await printSummary(schoolId, teachersCreated, marksInserted);
}

main().catch((err: Error) => {
  console.error('[fatal]', err.message);
  console.error(err.stack);
  process.exit(1);
});
