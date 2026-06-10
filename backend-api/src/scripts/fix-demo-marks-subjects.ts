/// <reference types="node" />
/**
 * fix-demo-marks-subjects.ts
 *
 * Renames subject values in the marks table to match the school's
 * existing subject names used by teacher assignments and the UI.
 *
 * Mapping (seed name → correct name):
 *   Mathematics  → Maths
 *
 * Also fixes teacher_assignments for the demo teachers.
 *
 * Safe to re-run — only updates rows that still have the old name.
 *
 * Run with:
 *   npx ts-node src/scripts/fix-demo-marks-subjects.ts
 */

import 'dotenv/config';
import { supabaseAdmin } from '../config/supabase';

const SCHOOL_NAME = 'Test School';

// Subject renames: old → new
const RENAMES: Record<string, string> = {
  'Mathematics': 'Maths',
};

async function getSchoolId(): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('schools')
    .select('id')
    .ilike('name', SCHOOL_NAME)
    .single();
  if (error || !data) throw new Error(`School "${SCHOOL_NAME}" not found`);
  return data.id as string;
}

async function fixMarks(): Promise<void> {
  console.log('\n── Fixing marks table subject names ────────────────────────');

  for (const [oldName, newName] of Object.entries(RENAMES)) {
    // Count affected rows first
    const { count } = await supabaseAdmin
      .from('marks')
      .select('id', { count: 'exact', head: true })
      .eq('subject', oldName);

    if (!count || count === 0) {
      console.log(`  [skip] No marks with subject="${oldName}"`);
      continue;
    }

    console.log(`  Renaming "${oldName}" → "${newName}" (${count} rows)...`);

    const { error } = await supabaseAdmin
      .from('marks')
      .update({ subject: newName })
      .eq('subject', oldName);

    if (error) {
      console.warn(`  [warn] Failed to rename marks: ${error.message}`);
    } else {
      console.log(`  [done] Updated ${count} mark rows: "${oldName}" → "${newName}"`);
    }
  }
}

async function fixAssignments(schoolId: string): Promise<void> {
  console.log('\n── Fixing teacher_assignments subject names ──────────────────');

  for (const [oldName, newName] of Object.entries(RENAMES)) {
    const { count } = await supabaseAdmin
      .from('teacher_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId)
      .eq('subject', oldName);

    if (!count || count === 0) {
      console.log(`  [skip] No assignments with subject="${oldName}"`);
      continue;
    }

    console.log(`  Renaming "${oldName}" → "${newName}" in assignments (${count} rows)...`);

    const { error } = await supabaseAdmin
      .from('teacher_assignments')
      .update({ subject: newName })
      .eq('school_id', schoolId)
      .eq('subject', oldName);

    if (error) {
      console.warn(`  [warn] Failed: ${error.message}`);
    } else {
      console.log(`  [done] Updated ${count} assignment rows`);
    }
  }
}

async function fixSubjects(schoolId: string): Promise<void> {
  console.log('\n── Fixing subjects table ─────────────────────────────────────');

  for (const [oldName, newName] of Object.entries(RENAMES)) {
    // Check if old subject exists
    const { data: old } = await supabaseAdmin
      .from('subjects')
      .select('id')
      .eq('school_id', schoolId)
      .eq('name', oldName)
      .maybeSingle();

    if (!old) {
      console.log(`  [skip] Subject "${oldName}" not found`);
      continue;
    }

    // Check if new name already exists (to avoid duplicate)
    const { data: already } = await supabaseAdmin
      .from('subjects')
      .select('id')
      .eq('school_id', schoolId)
      .eq('name', newName)
      .maybeSingle();

    if (already) {
      // New name already exists — just delete the old duplicate
      const { error } = await supabaseAdmin
        .from('subjects')
        .delete()
        .eq('id', old.id);
      if (error) console.warn(`  [warn] Could not delete old subject: ${error.message}`);
      else console.log(`  [done] Deleted duplicate subject "${oldName}" (kept existing "${newName}")`);
    } else {
      // Rename
      const { error } = await supabaseAdmin
        .from('subjects')
        .update({ name: newName })
        .eq('id', old.id);
      if (error) console.warn(`  [warn] Could not rename subject: ${error.message}`);
      else console.log(`  [done] Renamed subject "${oldName}" → "${newName}"`);
    }
  }
}

async function verify(): Promise<void> {
  console.log('\n── Verification ──────────────────────────────────────────────');

  for (const [oldName] of Object.entries(RENAMES)) {
    const { count: remaining } = await supabaseAdmin
      .from('marks')
      .select('id', { count: 'exact', head: true })
      .eq('subject', oldName);
    console.log(`  marks with "${oldName}" remaining: ${remaining ?? 0}`);
  }

  // Show distinct subjects now in marks for class 10-A
  const { data: students } = await supabaseAdmin
    .from('students')
    .select('id')
    .eq('class_name', '10')
    .eq('section', 'A')
    .eq('is_deleted', false);

  if (students && students.length > 0) {
    const ids = students.map((s: { id: string }) => s.id);
    const { data: marks } = await supabaseAdmin
      .from('marks')
      .select('subject')
      .in('student_id', ids)
      .eq('exam_type', 'final');

    const subjects = [...new Set((marks ?? []).map((m: { subject: string }) => m.subject))].sort();
    console.log(`\n  Subjects in marks for Class 10A (final): ${subjects.join(', ')}`);
  }
}

async function main() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║  Fix Demo Marks — Subject Name Alignment              ║');
  console.log('╚═══════════════════════════════════════════════════════╝');

  const schoolId = await getSchoolId();
  console.log(`School ID: ${schoolId}`);

  await fixMarks();
  await fixAssignments(schoolId);
  await fixSubjects(schoolId);
  await verify();

  console.log('\n  Done. View Marks should now show correct data.\n');
}

main().catch((err: Error) => {
  console.error('[fatal]', err.message);
  process.exit(1);
});
