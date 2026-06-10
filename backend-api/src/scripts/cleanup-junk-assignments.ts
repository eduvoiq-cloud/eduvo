/// <reference types="node" />
/**
 * cleanup-junk-assignments.ts
 *
 * Removes stale/junk teacher assignments and subject entries that have
 * no marks behind them and use inconsistent naming (lowercase, typos, etc.)
 *
 * Safe to re-run.
 */
import 'dotenv/config';
import { supabaseAdmin } from '../config/supabase';

const SCHOOL_ID = '8b7094ff-cf5b-454e-97db-c1eb0fba73f8';

// Junk assignment subjects to delete (no marks exist under these names)
const JUNK_SUBJECTS = ['gujarati', 'math', 'maths', 'secretarial practice'];

async function main() {
  console.log('── Cleaning junk teacher_assignments ────────────────────────');
  for (const subject of JUNK_SUBJECTS) {
    const { data, error } = await supabaseAdmin
      .from('teacher_assignments')
      .delete()
      .eq('school_id', SCHOOL_ID)
      .eq('subject', subject)
      .select('id');

    if (error) {
      console.log(`  [warn] Could not delete assignments for "${subject}": ${error.message}`);
    } else {
      console.log(`  [done] Deleted ${data?.length ?? 0} assignment(s) with subject="${subject}"`);
    }
  }

  console.log('\n── Cleaning junk subjects table entries ─────────────────────');
  for (const name of JUNK_SUBJECTS) {
    const { data: existing } = await supabaseAdmin
      .from('subjects')
      .select('id')
      .eq('school_id', SCHOOL_ID)
      .eq('name', name)
      .maybeSingle();

    if (!existing) {
      console.log(`  [skip] "${name}" not in subjects table`);
      continue;
    }

    const { error } = await supabaseAdmin
      .from('subjects')
      .delete()
      .eq('id', existing.id);

    if (error) {
      console.log(`  [warn] Could not delete subject "${name}": ${error.message}`);
    } else {
      console.log(`  [done] Deleted subject "${name}"`);
    }
  }

  // Final state
  console.log('\n── Final assignment subjects ─────────────────────────────────');
  const { data: assignments } = await supabaseAdmin
    .from('teacher_assignments')
    .select('subject')
    .eq('school_id', SCHOOL_ID);
  const subjects = [...new Set((assignments ?? []).map((a: { subject: string }) => a.subject))].sort();
  console.log(' ', subjects.join(', '));

  console.log('\n── Final subjects table ──────────────────────────────────────');
  const { data: subjectsTable } = await supabaseAdmin
    .from('subjects')
    .select('name')
    .eq('school_id', SCHOOL_ID)
    .order('name');
  console.log(' ', (subjectsTable ?? []).map((s: { name: string }) => s.name).join(', '));

  console.log('\nDone.\n');
}

main().catch((err: Error) => { console.error(err.message); process.exit(1); });
