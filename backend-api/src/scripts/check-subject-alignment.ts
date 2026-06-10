/// <reference types="node" />
import 'dotenv/config';
import { supabaseAdmin } from '../config/supabase';

async function main() {
  const schoolId = '8b7094ff-cf5b-454e-97db-c1eb0fba73f8';

  // 1. Subjects in subjects table
  const { data: subjectsTable } = await supabaseAdmin
    .from('subjects').select('name').eq('school_id', schoolId).order('name');
  const subjectsTableNames: string[] = (subjectsTable ?? []).map((s: { name: string }) => s.name);
  console.log('\nSUBJECTS TABLE :', subjectsTableNames.join(', '));

  // 2. Distinct subjects in marks (scoped to this school's students)
  const { data: students } = await supabaseAdmin
    .from('students').select('id').eq('school_id', schoolId).eq('is_deleted', false);
  const studentIds: string[] = (students ?? []).map((s: { id: string }) => s.id);

  const { data: marks } = await supabaseAdmin
    .from('marks').select('subject').in('student_id', studentIds);
  const marksSubjects: string[] = [...new Set((marks ?? []).map((m: { subject: string }) => m.subject))].sort();
  console.log('MARKS TABLE    :', marksSubjects.join(', '));

  // 3. Distinct subjects in teacher_assignments
  const { data: assignments } = await supabaseAdmin
    .from('teacher_assignments').select('subject').eq('school_id', schoolId);
  const assignSubjects: string[] = [...new Set((assignments ?? []).map((a: { subject: string }) => a.subject))].sort();
  console.log('ASSIGNMENTS    :', assignSubjects.join(', '));

  // 4. Counts per subject in marks
  const subjectCountMap: Record<string, number> = {};
  for (const m of (marks ?? []) as { subject: string }[]) {
    subjectCountMap[m.subject] = (subjectCountMap[m.subject] ?? 0) + 1;
  }

  // 5. Mismatch analysis
  console.log('\n─── MISMATCH ANALYSIS ──────────────────────────────────────');
  const assignSet = new Set(assignSubjects);
  const subjectsTableSet = new Set(subjectsTableNames);

  let problems = 0;
  for (const ms of marksSubjects) {
    const inAssign = assignSet.has(ms);
    const inSubjectsTable = subjectsTableSet.has(ms);
    const count = subjectCountMap[ms] ?? 0;
    if (!inAssign || !inSubjectsTable) {
      console.log(`  ✗ PROBLEM  subject="${ms}" (${count} marks) | in_assignments=${inAssign} | in_subjects_table=${inSubjectsTable}`);
      problems++;
    } else {
      console.log(`  ✓ OK       subject="${ms}" (${count} marks)`);
    }
  }

  // 6. Check assignments for subjects NOT in marks (teacher assigned but no marks entered)
  console.log('\n─── ASSIGNMENTS WITH NO MARKS YET ─────────────────────────');
  const marksSet = new Set(marksSubjects);
  for (const as of assignSubjects) {
    if (!marksSet.has(as)) {
      console.log(`  ⚠ assignment subject="${as}" has no marks in the marks table`);
    }
  }

  console.log(`\n${problems === 0 ? '✔ All good — no mismatches found.' : `✗ ${problems} problem(s) found — run fix script.`}\n`);
}

main().catch((err: Error) => { console.error(err.message); process.exit(1); });
