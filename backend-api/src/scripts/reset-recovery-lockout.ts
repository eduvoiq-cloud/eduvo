/**
 * reset-recovery-lockout.ts
 *
 * One-time script: clear the 30-day lockout on a recovery cycle so a
 * teacher can regenerate immediately (useful for testing/demos).
 *
 * Usage:
 *   npx ts-node src/scripts/reset-recovery-lockout.ts <class> <section> [school_name_or_id]
 *
 * Examples:
 *   npx ts-node src/scripts/reset-recovery-lockout.ts 10 A
 *   npx ts-node src/scripts/reset-recovery-lockout.ts 10 A "Test School"
 *   npx ts-node src/scripts/reset-recovery-lockout.ts 10 A 8b7094ff-cf5b-454e-97db-c1eb0fba73f8
 *
 * If multiple schools share the same name, pass the school UUID directly.
 * Run with --list-schools to see all school IDs.
 */

import 'dotenv/config';
import { supabaseAdmin } from '../config/supabase';

async function main() {
  const args = process.argv.slice(2);

  // --list-cycles: show all recovery cycles so the user can identify the right one
  if (args[0] === '--list-cycles') {
    const { data: cycles } = await supabaseAdmin
      .from('recovery_cycles')
      .select('id, school_id, class, section, status, lockout_until, pack_generated_at, created_at')
      .order('created_at', { ascending: false })
      .limit(20);
    console.log('Recent recovery cycles:');
    console.table(cycles?.map((c) => ({
      id: c.id,
      school_id: c.school_id,
      class: c.class,
      section: c.section,
      status: c.status,
      lockout_until: c.lockout_until ?? '—',
    })));
    process.exit(0);
  }

  const [className, section, schoolArg] = args;

  if (!className || !section) {
    console.error('Usage: npx ts-node src/scripts/reset-recovery-lockout.ts <class> <section> [school_name_or_id]');
    console.error('       npx ts-node src/scripts/reset-recovery-lockout.ts --list-cycles');
    process.exit(1);
  }

  const targetSchool = schoolArg ?? 'Test School';

  // 1. Resolve school ID — accepts UUID directly or school name
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let schoolId: string;
  let schoolDisplayName: string;

  if (uuidPattern.test(targetSchool)) {
    // Passed a UUID directly
    schoolId = targetSchool;
    schoolDisplayName = `(${schoolId})`;
  } else {
    let { data: school } = await supabaseAdmin
      .from('schools')
      .select('id, name')
      .eq('name', targetSchool)
      .maybeSingle();

    if (!school) {
      // Partial match fallback
      const { data: matches } = await supabaseAdmin
        .from('schools')
        .select('id, name')
        .ilike('name', `%${targetSchool}%`);

      if (matches && matches.length === 1) {
        school = matches[0];
      } else if (matches && matches.length > 1) {
        console.error(`[error] Multiple schools match "${targetSchool}":`);
        matches.forEach((s) => console.error(`  - ${s.name} (${s.id})`));
        console.error('\nPass the school UUID directly, or run with --list-cycles to see all cycles.');
        process.exit(1);
      }
    }

    if (!school) {
      console.error(`[error] School "${targetSchool}" not found.`);
      process.exit(1);
    }

    schoolId = school.id;
    schoolDisplayName = school.name;
  }

  console.log(`✔ School: ${schoolDisplayName} (${schoolId})`);

  // 2. Find the most recent cycle for this class+section
  const { data: cycle, error: cycleErr } = await supabaseAdmin
    .from('recovery_cycles')
    .select('id, status, lockout_until, pack_generated_at, created_at')
    .eq('school_id', schoolId)
    .eq('class', className)
    .eq('section', section)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (cycleErr) {
    console.error('[error] Failed to fetch cycle:', cycleErr.message);
    process.exit(1);
  }

  if (!cycle) {
    console.error(`[error] No recovery cycle found for Class ${className}-${section} in "${schoolDisplayName}".`);
    process.exit(1);
  }

  console.log(`\nFound cycle:`);
  console.log(`  ID:            ${cycle.id}`);
  console.log(`  Status:        ${cycle.status}`);
  console.log(`  Generated at:  ${cycle.pack_generated_at ?? '—'}`);
  console.log(`  Locked until:  ${cycle.lockout_until ?? '(not locked)'}`);

  if (!cycle.lockout_until) {
    console.log('\n✔ Cycle is not locked — no reset needed. You can generate immediately.');
    process.exit(0);
  }

  // 3. Clear the lockout
  const { error: updateErr } = await supabaseAdmin
    .from('recovery_cycles')
    .update({
      lockout_until: null,
      status: 'pack_ready',   // keep it in a usable, non-error state
      updated_at: new Date().toISOString(),
    })
    .eq('id', cycle.id);

  if (updateErr) {
    console.error('[error] Failed to clear lockout:', updateErr.message);
    process.exit(1);
  }

  console.log(`\n✅ Lockout cleared for Class ${className}-${section}!`);
  console.log(`   You can now hit "Generate Recovery Tests" on the recovery schedule page.`);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
