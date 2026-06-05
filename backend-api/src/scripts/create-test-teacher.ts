/// <reference types="node" />
/**
 * create-test-teacher.ts
 *
 * Creates a single test teacher account for testing the forgot-password flow.
 * Safe to re-run — skips if the email already exists.
 *
 * Usage:
 *   npx ts-node src/scripts/create-test-teacher.ts
 */

import 'dotenv/config';
import { supabaseAdmin } from '../config/supabase';

const EMAIL    = 'bittusinghq049@gmail.com';
const PASSWORD = 'Test@1234';
const NAME     = 'Bittu Singh (Test Teacher)';

async function main() {
  console.log('\n── Create Test Teacher ───────────────────────────────────────');
  console.log(`  Email    : ${EMAIL}`);
  console.log(`  Password : ${PASSWORD}`);

  // ── 1. Check if a public.users row already exists ──────────────────────────
  const { data: existing } = await supabaseAdmin
    .from('users')
    .select('id, email, role')
    .eq('email', EMAIL)
    .maybeSingle();

  if (existing) {
    console.log(`\n  [skip] ${EMAIL} already exists in public.users (id: ${existing.id})`);
    console.log('  Nothing to do.\n');
    return;
  }

  // ── 2. Find a school to attach to ─────────────────────────────────────────
  const { data: school, error: schoolErr } = await supabaseAdmin
    .from('schools')
    .select('id, name')
    .limit(1)
    .maybeSingle();

  if (schoolErr || !school) {
    console.error('\n  [error] No school found in the database.');
    console.error('  Run the seed script first, or create a school via the dashboard.\n');
    process.exit(1);
  }

  console.log(`\n  Attaching to school: "${school.name}" (${school.id})`);

  // ── 3. Find the school admin to set as created_by ─────────────────────────
  const { data: admin } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('school_id', school.id)
    .in('role', ['schooladmin', 'superadmin'])
    .limit(1)
    .maybeSingle();

  const createdBy = admin?.id ?? null;

  // ── 4. Create Supabase Auth user ───────────────────────────────────────────
  console.log('\n  Creating auth user…');
  const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,          // skip email verification
    user_metadata: { name: NAME, role: 'teacher' },
  });

  if (authErr || !authData?.user) {
    console.error(`\n  [error] Auth creation failed: ${authErr?.message ?? 'unknown'}\n`);
    process.exit(1);
  }

  const userId = authData.user!.id;
  console.log(`  Auth user created (id: ${userId})`);

  // ── 5. Insert public.users profile ────────────────────────────────────────
  console.log('  Inserting users profile…');
  const { error: profileErr } = await supabaseAdmin.from('users').insert({
    id:                  userId,
    name:                NAME,
    email:               EMAIL,
    role:                'teacher',
    school_id:           school.id,
    must_reset_password: false,     // this is a manual account — no forced reset
    created_by:          createdBy,
    created_at:          new Date().toISOString(),
  });

  if (profileErr) {
    console.error(`\n  [error] Profile insert failed: ${profileErr.message}`);
    console.error('  Cleaning up auth user…');
    await supabaseAdmin.auth.admin.deleteUser(userId);
    process.exit(1);
  }

  // ── 6. Done ────────────────────────────────────────────────────────────────
  console.log('\n  ✓ Teacher account created successfully!\n');
  console.log('  ┌─────────────────────────────────────────────────────┐');
  console.log(`  │  Email    : ${EMAIL.padEnd(38)} │`);
  console.log(`  │  Password : ${PASSWORD.padEnd(38)} │`);
  console.log(`  │  School   : ${school.name.slice(0, 38).padEnd(38)} │`);
  console.log('  └─────────────────────────────────────────────────────┘');
  console.log('\n  Test steps:');
  console.log('  1. Open the login page');
  console.log('  2. Click "Forgot password?"');
  console.log(`  3. Enter: ${EMAIL}`);
  console.log('  4. Check your inbox for the Resend reset email');
  console.log('  5. Click the link — it should land on /reset-password');
  console.log('  6. Set a new password and verify you can log in\n');
}

main().catch((err) => {
  console.error('\n[fatal]', err);
  process.exit(1);
});
