/// <reference types="node" />
/**
 * fix-school-links.ts
 *
 * One-shot repair script: ensures all seed users have the correct school_id.
 *
 * The base seed creates schooladmin@eduvo.com, teacher@eduvo.com, and
 * student@eduvo.com WITHOUT a school_id (because the school didn't exist yet).
 * The comprehensive seed.ts creates the schools but never back-fills these users.
 * Result: school_id = null → every dashboard guard silently bails → 0 users shown.
 *
 * Run with:
 *   npx ts-node src/scripts/fix-school-links.ts
 */

import 'dotenv/config';
import { supabaseAdmin } from '../config/supabase';

async function getUserIdByEmail(email: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('users')
    .select('id, school_id, role')
    .eq('email', email)
    .maybeSingle();
  return data?.id ?? null;
}

async function getSchoolIdByName(name: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('schools')
    .select('id')
    .eq('name', name)
    .maybeSingle();
  return data?.id ?? null;
}

async function ensureSchoolLink(
  email: string,
  schoolId: string,
  label: string
): Promise<void> {
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, school_id')
    .eq('email', email)
    .maybeSingle();

  if (!user) {
    console.log(`  [skip] ${email} not found in users table`);
    return;
  }

  if (user.school_id === schoolId) {
    console.log(`  [ok]   ${email} already linked to ${label}`);
    return;
  }

  const { error } = await supabaseAdmin
    .from('users')
    .update({ school_id: schoolId })
    .eq('id', user.id);

  if (error) {
    console.error(`  [fail] ${email}: ${error.message}`);
  } else {
    console.log(`  [fix]  ${email} → school_id set to ${label} (${schoolId})`);
  }
}

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║       Eduvo — Fix School Links                       ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // ── Resolve school IDs ────────────────────────────────────────────────────
  const testSchoolId = await getSchoolIdByName('Test School');
  const demoSchoolId = await getSchoolIdByName('Demo Coaching');

  if (!testSchoolId) {
    console.error('[fatal] "Test School" not found. Run seed.ts first.');
    process.exit(1);
  }
  if (!demoSchoolId) {
    console.error('[fatal] "Demo Coaching" not found. Run seed.ts first.');
    process.exit(1);
  }

  console.log(`Test School  id: ${testSchoolId}`);
  console.log(`Demo Coaching id: ${demoSchoolId}\n`);

  // ── Fix Test School users ─────────────────────────────────────────────────
  console.log('── Test School users ─────────────────────────────────────────');
  await ensureSchoolLink('schooladmin@eduvo.com', testSchoolId, 'Test School');
  await ensureSchoolLink('teacher@eduvo.com',     testSchoolId, 'Test School');
  await ensureSchoolLink('student@eduvo.com',     testSchoolId, 'Test School');
  await ensureSchoolLink('student2@eduvo.com',    testSchoolId, 'Test School');
  await ensureSchoolLink('parent@eduvo.com',      testSchoolId, 'Test School');
  await ensureSchoolLink('parent2@eduvo.com',     testSchoolId, 'Test School');
  await ensureSchoolLink('parent3@eduvo.com',     testSchoolId, 'Test School');
  await ensureSchoolLink('parent4@eduvo.com',     testSchoolId, 'Test School');
  await ensureSchoolLink('parent5@eduvo.com',     testSchoolId, 'Test School');
  await ensureSchoolLink('teacher2@eduvo.com',    testSchoolId, 'Test School');
  await ensureSchoolLink('teacher3@eduvo.com',    testSchoolId, 'Test School');

  // ── Fix Demo Coaching users ───────────────────────────────────────────────
  console.log('\n── Demo Coaching users ───────────────────────────────────────');
  await ensureSchoolLink('admin2@eduvo.com',        demoSchoolId, 'Demo Coaching');
  await ensureSchoolLink('demoteacher1@eduvo.com',  demoSchoolId, 'Demo Coaching');
  await ensureSchoolLink('demoteacher2@eduvo.com',  demoSchoolId, 'Demo Coaching');
  await ensureSchoolLink('demoteacher3@eduvo.com',  demoSchoolId, 'Demo Coaching');
  await ensureSchoolLink('demoparent1@eduvo.com',   demoSchoolId, 'Demo Coaching');
  await ensureSchoolLink('demoparent2@eduvo.com',   demoSchoolId, 'Demo Coaching');

  // ── Verify schooladmin ────────────────────────────────────────────────────
  console.log('\n── Verification ──────────────────────────────────────────────');
  const { data: adminCheck } = await supabaseAdmin
    .from('users')
    .select('email, role, school_id')
    .in('email', ['schooladmin@eduvo.com', 'teacher@eduvo.com', 'student@eduvo.com', 'admin2@eduvo.com']);

  if (adminCheck) {
    for (const u of adminCheck) {
      const linked = u.school_id ? '✓' : '✗ STILL NULL';
      console.log(`  ${linked}  ${u.email} (${u.role}) → school_id: ${u.school_id ?? 'null'}`);
    }
  }

  console.log('\n[done] School links repaired. Log out and log back in to refresh the session.');
}

main().catch((err: Error) => {
  console.error('[fatal]', err.message);
  process.exit(1);
});
