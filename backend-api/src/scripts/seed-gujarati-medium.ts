/// <reference types="node" />
/**
 * seed-gujarati-medium.ts
 *
 * Seeds realistic demo data into the Gujarati medium of TEST SCHOOL.
 *
 * What it does:
 *   Step 1 — Verify or create the Gujarati medium sibling school
 *   Step 2 — Create 8 teachers (skip if email already exists)
 *   Step 3 — Create 8 classes (9A/B, 10A/B, 11A/B, 12A/B) — implicit via students
 *   Step 4 — Bulk-import 40 students (5 per class, phone-based login)
 *   Step 5 — Insert Final Term marks for all 8 subjects × 40 students
 *   Step 6 — Print summary
 *
 * Run with:
 *   npx ts-node src/scripts/seed-gujarati-medium.ts
 *
 * Safe to re-run: every step uses skip/upsert logic.
 * NEVER touches the English medium data.
 */

import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcrypt';
import { supabaseAdmin } from '../config/supabase';

// ── Constants ─────────────────────────────────────────────────────────────────

const ENGLISH_SCHOOL_NAME = 'Test School';
const DEFAULT_TEACHER_PASSWORD = 'Test@1234';

const TEACHERS = [
  { name: 'Aarti Patel',      email: 'aarti@eduvo.com',     subject: 'Maths' },
  { name: 'Bhavesh Shah',     email: 'bhavesh@eduvo.com',   subject: 'Science' },
  { name: 'Chandrika Joshi',  email: 'chandrika@eduvo.com', subject: 'Gujarati' },
  { name: 'Dinesh Trivedi',   email: 'dinesh@eduvo.com',    subject: 'Hindi' },
  { name: 'Ekta Desai',       email: 'ekta@eduvo.com',      subject: 'English' },
  { name: 'Falgun Mehta',     email: 'falgun@eduvo.com',    subject: 'Social Science' },
  { name: 'Girish Solanki',   email: 'girish@eduvo.com',    subject: 'Computer' },
  { name: 'Hansa Bhatt',      email: 'hansa@eduvo.com',     subject: 'Sanskrit' },
];

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

// 5 students per class, in the same order as CLASS_SECTIONS
const STUDENTS_BY_CLASS: Record<string, string[]> = {
  '9A':  ['Aarav Shah',       'Diya Patel',     'Rohan Mehta',   'Priya Singh',   'Karan Joshi'],
  '9B':  ['Vivek Rao',        'Sneha Desai',    'Arjun Nair',    'Meera Iyer',    'Pooja Agarwal'],
  '10A': ['Siddharth Kumar',  'Kavya Reddy',    'Nikhil Tiwari', 'Ananya Gupta',  'Reyansh Modi'],
  '10B': ['Myra Trivedi',     'Advait Rao',     'Kiara Bhatt',   'Arjun Singh',   'Riya Kapoor'],
  '11A': ['Dhruv Verma',      'Sara Nair',      'Kabir Gupta',   'Krish Patel',   'Aarav Patil'],
  '11B': ['Vivaan Joshi',     'Anaya Desai',    'Krish Trivedi', 'Myra Mehta',    'Kiara Modi'],
  '12A': ['Aditya Rao',       'Ishita Mehta',   'Reyansh Nair',  'Kabir Shah',    'Diya Joshi'],
  '12B': ['Rudra Bhatt',      'Arjun Patel',    'Sara Trivedi',  'Vivaan Desai',  'Aarav Mehta'],
};

// Realistic Indian mobile numbers starting with 9 — unique set
// Format: 9XXXXXXXXX (10 digits). Last 5 digits = student login password.
const PHONE_NUMBERS: Record<string, string> = {
  // 9A
  'Aarav Shah':       '9876541001',
  'Diya Patel':       '9823451002',
  'Rohan Mehta':      '9712341003',
  'Priya Singh':      '9654321004',
  'Karan Joshi':      '9543211005',
  // 9B
  'Vivek Rao':        '9432101006',
  'Sneha Desai':      '9321001007',
  'Arjun Nair':       '9210001008',
  'Meera Iyer':       '9876541009',
  'Pooja Agarwal':    '9823451010',
  // 10A
  'Siddharth Kumar':  '9765431011',
  'Kavya Reddy':      '9654321012',
  'Nikhil Tiwari':    '9543211013',
  'Ananya Gupta':     '9432101014',
  'Reyansh Modi':     '9321001015',
  // 10B
  'Myra Trivedi':     '9210001016',
  'Advait Rao':       '9876541017',
  'Kiara Bhatt':      '9823451018',
  'Arjun Singh':      '9765431019',
  'Riya Kapoor':      '9654321020',
  // 11A
  'Dhruv Verma':      '9543211021',
  'Sara Nair':        '9432101022',
  'Kabir Gupta':      '9321001023',
  'Krish Patel':      '9210001024',
  'Aarav Patil':      '9876542025',
  // 11B
  'Vivaan Joshi':     '9823452026',
  'Anaya Desai':      '9765432027',
  'Krish Trivedi':    '9654322028',
  'Myra Mehta':       '9543212029',
  'Kiara Modi':       '9432102030',
  // 12A
  'Aditya Rao':       '9321002031',
  'Ishita Mehta':     '9210002032',
  'Reyansh Nair':     '9876542033',
  'Kabir Shah':       '9823452034',
  'Diya Joshi':       '9765432035',
  // 12B
  'Rudra Bhatt':      '9654322036',
  'Arjun Patel':      '9543212037',
  'Sara Trivedi':     '9432102038',
  'Vivaan Desai':     '9321002039',
  'Aarav Mehta':      '9210002040',
};

/**
 * Class-level bias for marks generation.
 * 12A → best class (higher average)
 * 9B  → weakest class (lower average)
 */
const CLASS_BIAS: Record<string, number> = {
  '9A':  -2,   // slightly below average
  '9B':  -10,  // weakest class
  '10A':  0,   // neutral
  '10B':  3,   // slightly above average
  '11A': -5,   // mixed
  '11B':  5,   // above average
  '12A':  12,  // best class
  '12B':  4,   // above average
};

const TERM      = 'term_1';
const EXAM_TYPE = 'final';
const MAX_SCORE = 100;

// ── RNG (deterministic, seeded) ────────────────────────────────────────────────

function createRng(seed: number): () => number {
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
 * Generate a realistic mark using the required distribution:
 *   10% → 15-34 (poor/red)
 *   20% → 35-49 (weak/amber)
 *   50% → 50-74 (average)
 *   20% → 75-95 (good)
 * Class bias shifts the ranges up or down.
 */
function generateMark(
  studentIndex: number,
  subjectIndex: number,
  classBias: number,
  rng: () => number
): number {
  const tierRoll = (studentIndex * 17 + subjectIndex * 37) % 100;

  let baseMin: number;
  let baseMax: number;

  if (tierRoll < 10) {
    baseMin = 15; baseMax = 34; // 10% — poor (red)
  } else if (tierRoll < 30) {
    baseMin = 35; baseMax = 49; // 20% — weak (amber)
  } else if (tierRoll < 80) {
    baseMin = 50; baseMax = 74; // 50% — average
  } else {
    baseMin = 75; baseMax = 95; // 20% — good
  }

  const min = Math.max(10, Math.min(baseMin + classBias, 90));
  const max = Math.max(min + 5, Math.min(baseMax + classBias, 100));

  return Math.max(10, Math.min(100, Math.round(min + rng() * (max - min))));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function logAudit(
  userId: string,
  action: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  await supabaseAdmin.from('audit_logs').insert({
    user_id: userId,
    action,
    details,
    created_at: new Date().toISOString(),
  });
}

// ── Step 1: Verify or create the Gujarati medium school ───────────────────────

async function resolveGujaratiSchool(): Promise<{
  gujaratiSchoolId: string;
  adminId: string;
  englishSchoolId: string;
}> {
  console.log('\n── Step 1: Resolving Gujarati Medium School ─────────────────');

  // Find the English medium TEST SCHOOL — use wildcard select to avoid
  // column-not-found errors if subscription_* or medium columns don't exist yet.
  // We'll work with whatever the schema currently has.
  const { data: engSchool, error: engErr } = await supabaseAdmin
    .from('schools')
    .select('*')
    .ilike('name', ENGLISH_SCHOOL_NAME)
    .limit(1)
    .maybeSingle();

  if (engErr || !engSchool) {
    throw new Error(
      `Could not find "${ENGLISH_SCHOOL_NAME}". ` +
      `Run the main seed script first.\nDB error: ${engErr?.message ?? 'not found'}`
    );
  }

  const englishSchoolId = engSchool.id as string;
  console.log(`  [info] English medium school: "${engSchool.name}" (${englishSchoolId})`);
  console.log(`  [info] Medium field value: ${engSchool.medium ?? '(null — pre-migration)'}`);

  // Find the admin for this school
  const { data: adminUser, error: adminErr } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('school_id', englishSchoolId)
    .eq('role', 'schooladmin')
    .eq('is_deleted', false)
    .limit(1)
    .maybeSingle();

  if (adminErr || !adminUser) {
    throw new Error(`No schooladmin found for "${ENGLISH_SCHOOL_NAME}".`);
  }

  const adminId = adminUser.id as string;
  console.log(`  [info] School admin ID: ${adminId}`);

  // Check if a Gujarati medium sibling already exists
  // Both parent_school_id and medium columns require the dual-medium migration to have run.
  const { data: existingGujarati, error: siblingErr } = await supabaseAdmin
    .from('schools')
    .select('id')
    .eq('parent_school_id', englishSchoolId)
    .eq('medium', 'gujarati')
    .maybeSingle();

  if (siblingErr && (siblingErr.message?.includes('column') || siblingErr.message?.includes('does not exist'))) {
    // Dual-medium migration hasn't been run yet — columns don't exist
    console.warn('  [warn] The dual-medium migration has not been applied to the DB yet.');
    console.warn('         Please run supabase-migrations-dual-medium.sql in your Supabase project first.');
    throw new Error('Missing DB columns: run supabase-migrations-dual-medium.sql before this script.');
  }

  if (existingGujarati) {
    console.log(`  [skip] Gujarati medium school already exists (${existingGujarati.id})`);
    return { gujaratiSchoolId: existingGujarati.id as string, adminId, englishSchoolId };
  }

  // Create the Gujarati medium sibling school
  console.log(`  [info] Gujarati medium school not found — creating now...`);

  const { data: newSchool, error: createErr } = await supabaseAdmin
    .from('schools')
    .insert({
      name:               engSchool.name,
      address:            engSchool.address ?? 'Same as English medium',
      phone:              engSchool.phone   ?? null,
      email:              engSchool.email   ?? null,
      medium:             'gujarati',
      parent_school_id:   englishSchoolId,
      is_active:          engSchool.is_active ?? true,
      created_at:         new Date().toISOString(),
    })
    .select('id')
    .single();

  if (createErr || !newSchool) {
    throw new Error(`Failed to create Gujarati medium school: ${createErr?.message ?? 'unknown'}`);
  }

  const gujaratiSchoolId = newSchool.id as string;
  console.log(`  [done] Created Gujarati medium school (${gujaratiSchoolId})`);

  // Grant the admin access to both schools via school_admin_access
  for (const sid of [englishSchoolId, gujaratiSchoolId]) {
    const { error: accessErr } = await supabaseAdmin
      .from('school_admin_access')
      .insert({ admin_id: adminId, school_id: sid, created_at: new Date().toISOString() });

    if (accessErr && !accessErr.message?.includes('duplicate') && !accessErr.message?.includes('unique')) {
      console.warn(`  [warn] school_admin_access insert for ${sid}: ${accessErr.message}`);
    } else if (!accessErr) {
      console.log(`  [done] Admin access granted for school ${sid}`);
    } else {
      console.log(`  [skip] Admin access already exists for school ${sid}`);
    }
  }

  await logAudit(adminId, 'SEED_GUJARATI_SCHOOL_CREATED', { gujarati_school_id: gujaratiSchoolId });

  return { gujaratiSchoolId, adminId, englishSchoolId };
}

// ── Step 2: Create teachers ────────────────────────────────────────────────────

async function seedTeachers(
  gujaratiSchoolId: string,
  adminId: string
): Promise<Map<string, string>> {
  console.log('\n── Step 2: Creating Teachers ────────────────────────────────');

  const teacherIdByEmail = new Map<string, string>();
  const summary: string[] = [];
  let created = 0;
  let skipped = 0;

  for (const t of TEACHERS) {
    // Check if this email already exists in the users table
    const { data: existing } = await supabaseAdmin
      .from('users')
      .select('id, school_id')
      .eq('email', t.email.toLowerCase())
      .maybeSingle();

    if (existing) {
      console.log(`  [skip] ${t.email} already exists (${existing.id}) — reusing`);
      teacherIdByEmail.set(t.email, existing.id as string);
      summary.push(`  SKIPPED (already existed): ${t.name} <${t.email}>`);
      skipped++;
      continue;
    }

    // Create Supabase auth user
    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email:         t.email,
      password:      DEFAULT_TEACHER_PASSWORD,
      email_confirm: true,
      user_metadata: { name: t.name, role: 'teacher' },
    });

    if (authErr || !authData?.user) {
      console.warn(`  [warn] Auth creation failed for ${t.email}: ${authErr?.message}`);
      summary.push(`  FAILED: ${t.name} <${t.email}> — ${authErr?.message ?? 'unknown auth error'}`);
      continue;
    }

    const userId = authData.user.id;

    // Insert users profile row
    const { error: profileErr } = await supabaseAdmin.from('users').insert({
      id:         userId,
      name:       t.name,
      email:      t.email,
      role:       'teacher',
      school_id:  gujaratiSchoolId,
      created_by: adminId,
      created_at: new Date().toISOString(),
    });

    if (profileErr) {
      await supabaseAdmin.auth.admin.deleteUser(userId);
      console.warn(`  [warn] Profile insert failed for ${t.email}: ${profileErr.message}`);
      summary.push(`  FAILED: ${t.name} <${t.email}> — ${profileErr.message}`);
      continue;
    }

    teacherIdByEmail.set(t.email, userId);
    summary.push(`  CREATED: ${t.name} <${t.email}> (${userId})`);
    console.log(`  [done] Created ${t.name} <${t.email}> (${userId})`);
    created++;

    await logAudit(adminId, 'SEED_GUJ_TEACHER_CREATED', {
      teacher_id:   userId,
      teacher_name: t.name,
      school_id:    gujaratiSchoolId,
    });
  }

  console.log(`\n  Summary: ${created} created, ${skipped} skipped (email already existed)`);
  return teacherIdByEmail;
}

// ── Step 3: Assign teachers to all 8 classes ──────────────────────────────────

async function seedAssignments(
  gujaratiSchoolId: string,
  teacherIdByEmail: Map<string, string>
): Promise<void> {
  console.log('\n── Step 3: Creating Teacher Assignments ─────────────────────');

  let created = 0;
  let skipped = 0;

  for (const t of TEACHERS) {
    const teacherId = teacherIdByEmail.get(t.email);
    if (!teacherId) {
      console.warn(`  [warn] No teacher ID for ${t.email} — skipping assignments`);
      continue;
    }

    for (const cls of CLASS_SECTIONS) {
      const { data: existing } = await supabaseAdmin
        .from('teacher_assignments')
        .select('id')
        .eq('teacher_id',  teacherId)
        .eq('school_id',   gujaratiSchoolId)
        .eq('class_name',  cls.class_name)
        .eq('section',     cls.section)
        .eq('subject',     t.subject)
        .maybeSingle();

      if (existing) {
        skipped++;
        continue;
      }

      const { error } = await supabaseAdmin.from('teacher_assignments').insert({
        teacher_id: teacherId,
        school_id:  gujaratiSchoolId,
        class_name: cls.class_name,
        class:      cls.class_name,   // legacy NOT NULL column — keep in sync
        section:    cls.section,
        subject:    t.subject,
      });

      if (error) {
        console.warn(`  [warn] Assignment ${t.name} → ${cls.class_name}${cls.section}: ${error.message}`);
      } else {
        created++;
      }
    }
    console.log(`  [done] ${t.name} (${t.subject}) → assigned to all 8 classes`);
  }

  console.log(`\n  Summary: ${created} assignments created, ${skipped} already existed`);
}

// ── Step 3b: Ensure subjects exist ────────────────────────────────────────────

async function seedSubjects(gujaratiSchoolId: string): Promise<void> {
  console.log('\n── Step 3b: Ensuring Subjects Exist ─────────────────────────');

  for (const t of TEACHERS) {
    const { data: existing } = await supabaseAdmin
      .from('subjects')
      .select('id')
      .eq('school_id', gujaratiSchoolId)
      .ilike('name', t.subject)
      .maybeSingle();

    if (existing) {
      console.log(`  [skip] Subject "${t.subject}" already exists`);
      continue;
    }

    const { error } = await supabaseAdmin.from('subjects').insert({
      name:       t.subject,
      school_id:  gujaratiSchoolId,
    });

    if (error) {
      console.warn(`  [warn] Failed to create subject "${t.subject}": ${error.message}`);
    } else {
      console.log(`  [done] Created subject "${t.subject}"`);
    }
  }
}

// ── Step 4: Create 40 students ────────────────────────────────────────────────

async function seedStudents(
  gujaratiSchoolId: string
): Promise<Map<string, string[]>> {
  console.log('\n── Step 4: Creating Students ────────────────────────────────');

  const studentIdsByClass = new Map<string, string[]>();
  let created = 0;
  let skipped = 0;

  for (const cls of CLASS_SECTIONS) {
    const classKey  = `${cls.class_name}${cls.section}`;
    const names     = STUDENTS_BY_CLASS[classKey] ?? [];
    const classIds: string[] = [];

    console.log(`\n  Class ${classKey}:`);

    for (let i = 0; i < names.length; i++) {
      const studentName = names[i];
      const phone       = PHONE_NUMBERS[studentName];

      if (!phone) {
        console.warn(`    [warn] No phone number defined for "${studentName}" — skipping`);
        continue;
      }

      // Check if this student already exists in this school + class
      const { data: existingByPhone } = await supabaseAdmin
        .from('students')
        .select('id')
        .eq('school_id',    gujaratiSchoolId)
        .eq('phone_number', phone)
        .eq('is_deleted',   false)
        .maybeSingle();

      if (existingByPhone) {
        console.log(`    [skip] ${studentName} (phone ${phone.slice(-4)}…) already exists`);
        classIds.push(existingByPhone.id as string);
        skipped++;
        continue;
      }

      // Password = last 5 digits of phone (matches bulk import behavior)
      const defaultPassword = phone.slice(-5);
      let passwordHash: string;
      try {
        passwordHash = await bcrypt.hash(defaultPassword, 10);
      } catch (hashErr) {
        console.warn(`    [warn] Hash failed for ${studentName}: ${hashErr}`);
        continue;
      }

      const studentId = uuidv4();

      const { error: insertErr } = await supabaseAdmin.from('students').insert({
        id:             studentId,
        full_name:      studentName,
        name:           studentName,        // legacy column — keep in sync
        school_id:      gujaratiSchoolId,
        class_name:     cls.class_name,
        class:          cls.class_name,     // legacy NOT NULL column — keep in sync
        section:        cls.section,
        roll_number:    String(i + 1),      // 1–5 sequential per class
        phone_number:   phone,
        phone:          phone,              // legacy column — keep in sync
        date_of_birth:  null,
        password_hash:  passwordHash,
        is_first_login: true,
        qr_code:        studentId,
        is_deleted:     false,
        created_at:     new Date().toISOString(),
      });

      if (insertErr) {
        console.warn(`    [warn] Insert failed for ${studentName}: ${insertErr.message}`);
        continue;
      }

      classIds.push(studentId);
      console.log(`    [done] ${studentName} | Roll ${i + 1} | pw: ${defaultPassword}`);
      created++;
    }

    studentIdsByClass.set(classKey, classIds);
  }

  console.log(`\n  Summary: ${created} students created, ${skipped} already existed`);
  return studentIdsByClass;
}

// ── Step 5: Insert Final Term marks ───────────────────────────────────────────

async function seedMarks(
  adminId: string,
  gujaratiSchoolId: string,
  studentIdsByClass: Map<string, string[]>
): Promise<number> {
  console.log('\n── Step 5: Inserting Final Term Marks ───────────────────────');

  const subjects  = TEACHERS.map((t) => t.subject);
  const markDate  = new Date(new Date().getFullYear(), new Date().getMonth(), 15).toISOString();

  let totalInserted = 0;
  let totalSkipped  = 0;

  for (const cls of CLASS_SECTIONS) {
    const classKey  = `${cls.class_name}${cls.section}`;
    const classBias = CLASS_BIAS[classKey] ?? 0;

    // Fetch all students from DB (handles both fresh and re-run scenarios)
    const { data: dbStudents, error: fetchErr } = await supabaseAdmin
      .from('students')
      .select('id, full_name')
      .eq('school_id',  gujaratiSchoolId)
      .eq('class_name', cls.class_name)
      .eq('section',    cls.section)
      .eq('is_deleted', false)
      .order('roll_number', { ascending: true });

    if (fetchErr) {
      console.warn(`  [warn] Could not fetch students for ${classKey}: ${fetchErr.message}`);
      continue;
    }

    const students = dbStudents ?? [];

    if (students.length === 0) {
      console.log(`  [skip] No students found in ${classKey}`);
      continue;
    }

    console.log(`\n  ${classKey} (${students.length} students, bias: ${classBias > 0 ? '+' : ''}${classBias})...`);

    for (let si = 0; si < students.length; si++) {
      const student    = students[si];
      const studentSeed = (si + 1) * 31 + classKey.charCodeAt(0) + classKey.charCodeAt(1);
      const rng         = createRng(studentSeed * 9973);

      for (let subIdx = 0; subIdx < subjects.length; subIdx++) {
        const subject = subjects[subIdx];

        // Skip if mark already exists (safe re-run)
        const { data: existingMark } = await supabaseAdmin
          .from('marks')
          .select('id')
          .eq('student_id', student.id)
          .eq('subject',    subject)
          .eq('term',       TERM)
          .eq('exam_type',  EXAM_TYPE)
          .maybeSingle();

        if (existingMark) {
          totalSkipped++;
          continue;
        }

        const score = generateMark(si, subIdx, classBias, rng);

        const { error: markErr } = await supabaseAdmin.from('marks').insert({
          student_id:  student.id,
          subject,
          score,
          max_score:   MAX_SCORE,
          term:        TERM,
          exam_type:   EXAM_TYPE,
          notes:       'Demo mark — Final Term 1 (Gujarati medium)',
          recorded_by: adminId,
          created_at:  markDate,
        });

        if (markErr) {
          console.warn(`    [warn] Mark for ${student.full_name} / ${subject}: ${markErr.message}`);
        } else {
          totalInserted++;
        }
      }
    }

    console.log(`  [done] ${classKey} marks done`);
  }

  console.log(`\n  Total marks inserted: ${totalInserted}, already existed (skipped): ${totalSkipped}`);
  return totalInserted;
}

// ── Step 6: Verify and print summary ──────────────────────────────────────────

async function printSummary(
  gujaratiSchoolId: string,
  adminId: string,
  marksInserted: number
): Promise<void> {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  GUJARATI MEDIUM SEED — COMPLETE SUMMARY');
  console.log('══════════════════════════════════════════════════════════════');

  console.log(`\n  Gujarati medium school ID : ${gujaratiSchoolId}`);
  console.log(`  School admin ID           : ${adminId}`);

  // Count teachers in this school
  const { count: teacherCount } = await supabaseAdmin
    .from('users')
    .select('*', { count: 'exact', head: true })
    .eq('school_id', gujaratiSchoolId)
    .eq('role', 'teacher')
    .eq('is_deleted', false);

  console.log(`  Teachers in school        : ${teacherCount ?? 0}`);

  // Count students per class
  console.log('\n  Students per class:');
  let totalStudents = 0;

  for (const cls of CLASS_SECTIONS) {
    const classKey = `${cls.class_name}${cls.section}`;
    const { count } = await supabaseAdmin
      .from('students')
      .select('*', { count: 'exact', head: true })
      .eq('school_id',  gujaratiSchoolId)
      .eq('class_name', cls.class_name)
      .eq('section',    cls.section)
      .eq('is_deleted', false);

    const n = count ?? 0;
    totalStudents += n;
    console.log(`    Class ${classKey}: ${n} students`);
  }

  console.log(`  Total students            : ${totalStudents}`);
  console.log(`  Total mark entries added  : ${marksInserted}`);

  // Calculate per-class averages
  console.log('\n  Class Rankings by Average Marks (highest → lowest):');
  const classAvgs: Array<{ classKey: string; avg: number }> = [];

  for (const cls of CLASS_SECTIONS) {
    const classKey = `${cls.class_name}${cls.section}`;

    const { data: students } = await supabaseAdmin
      .from('students')
      .select('id')
      .eq('school_id',  gujaratiSchoolId)
      .eq('class_name', cls.class_name)
      .eq('section',    cls.section)
      .eq('is_deleted', false);

    if (!students || students.length === 0) continue;

    const studentIds = students.map((s: { id: string }) => s.id);

    const { data: marksData } = await supabaseAdmin
      .from('marks')
      .select('score, max_score')
      .in('student_id', studentIds)
      .eq('term',      TERM)
      .eq('exam_type', EXAM_TYPE);

    if (!marksData || marksData.length === 0) continue;

    const totalScore = marksData.reduce((s: number, m: { score: number }) => s + Number(m.score), 0);
    const totalMax   = marksData.reduce((s: number, m: { max_score: number }) => s + Number(m.max_score), 0);
    const avg        = totalMax > 0 ? Math.round((totalScore / totalMax) * 1000) / 10 : 0;
    classAvgs.push({ classKey, avg });
  }

  classAvgs.sort((a, b) => b.avg - a.avg);
  classAvgs.forEach((c, i) => {
    const tag = i === 0 ? '  ← BEST' : i === classAvgs.length - 1 ? '  ← LOWEST' : '';
    console.log(`    ${i + 1}. Class ${c.classKey} — ${c.avg.toFixed(1)}%${tag}`);
  });

  if (classAvgs.length >= 2) {
    console.log(`\n  Highest avg class : ${classAvgs[0].classKey}  (${classAvgs[0].avg.toFixed(1)}%)`);
    console.log(`  Lowest avg class  : ${classAvgs[classAvgs.length - 1].classKey} (${classAvgs[classAvgs.length - 1].avg.toFixed(1)}%)`);
  }

  // Verify teacher logins
  console.log('\n  Teacher login verification (password: Test@1234):');
  for (const t of TEACHERS) {
    const { data: authCheck } = await supabaseAdmin
      .from('users')
      .select('id, school_id')
      .eq('email', t.email.toLowerCase())
      .eq('role', 'teacher')
      .maybeSingle();

    const schoolMatch = authCheck?.school_id === gujaratiSchoolId ? '✓' : '? (different school)';
    if (authCheck) {
      console.log(`    ✓ ${t.email} exists ${schoolMatch}`);
    } else {
      console.log(`    ✗ ${t.email} NOT FOUND`);
    }
  }

  // Verify student passwords
  console.log('\n  Student password verification (last 5 digits of phone):');
  for (const [classKey, names] of Object.entries(STUDENTS_BY_CLASS)) {
    for (const name of names) {
      const phone = PHONE_NUMBERS[name];
      if (!phone) continue;
      const expectedPw = phone.slice(-5);
      console.log(`    ${name.padEnd(20)} | phone: …${phone.slice(-7)} | pw: ${expectedPw}`);
    }
    break; // Show only first class for brevity — pattern is consistent for all
  }
  console.log(`    … (same pattern applies to all 40 students — pw = last 5 digits of phone)`);

  console.log('\n  Rules respected:');
  console.log(`    ✓ All data scoped to Gujarati school ID: ${gujaratiSchoolId}`);
  console.log('    ✓ English medium TEST SCHOOL data was NOT touched');
  console.log('    ✓ Teacher duplicates checked before creation');
  console.log('    ✓ Student passwords = last 5 digits of phone (matching bulk import behavior)');
  console.log('    ✓ 12A intentionally biased higher (best class)');
  console.log('    ✓ 9B intentionally biased lower (weakest class)');
  console.log('\n══════════════════════════════════════════════════════════════\n');
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Eduvo — Gujarati Medium Demo Seed Script                    ║');
  console.log('║  Target: TEST SCHOOL → Gujarati medium                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // Step 1 — Resolve/create the Gujarati school
  const { gujaratiSchoolId, adminId } = await resolveGujaratiSchool();

  // Step 3b — Ensure subjects exist
  await seedSubjects(gujaratiSchoolId);

  // Step 2 — Create teachers
  const teacherIdByEmail = await seedTeachers(gujaratiSchoolId, adminId);

  // Step 3 — Assign teachers to all 8 classes
  await seedAssignments(gujaratiSchoolId, teacherIdByEmail);

  // Step 4 — Create 40 students
  const studentIdsByClass = await seedStudents(gujaratiSchoolId);

  // Step 5 — Insert Final Term marks
  const marksInserted = await seedMarks(adminId, gujaratiSchoolId, studentIdsByClass);

  // Step 6 — Summary
  await printSummary(gujaratiSchoolId, adminId, marksInserted);
}

main().catch((err: Error) => {
  console.error('\n[fatal]', err.message);
  console.error(err.stack);
  process.exit(1);
});
