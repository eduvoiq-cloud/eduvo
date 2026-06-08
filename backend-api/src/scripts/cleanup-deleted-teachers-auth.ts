/// <reference types="node" />
/**
 * One-off script: hard-delete soft-deleted teachers from Supabase Auth.
 *
 * Background: The old teacher delete route only soft-deleted from public.users
 * (is_deleted = true) but left the email in auth.users. This means the same
 * email cannot be re-imported via bulk import because Supabase Auth rejects it
 * as "already registered".
 *
 * This script finds all users in public.users where is_deleted = true and
 * role = 'teacher', then calls auth.admin.deleteUser() for each one.
 *
 * Run once:
 *   npx ts-node src/scripts/cleanup-deleted-teachers-auth.ts
 */

import { supabaseAdmin } from '../config/supabase';

async function main() {
  console.log('Fetching soft-deleted teachers...');

  const { data: deletedTeachers, error } = await supabaseAdmin
    .from('users')
    .select('id, name, email')
    .eq('role', 'teacher')
    .eq('is_deleted', true);

  if (error) {
    console.error('Failed to fetch deleted teachers:', error.message);
    process.exit(1);
  }

  if (!deletedTeachers || deletedTeachers.length === 0) {
    console.log('No soft-deleted teachers found. Nothing to clean up.');
    return;
  }

  console.log(`Found ${deletedTeachers.length} soft-deleted teacher(s):`);
  for (const t of deletedTeachers as { id: string; name: string; email: string }[]) {
    console.log(`  • ${t.name} <${t.email}> (${t.id})`);
  }

  for (const teacher of deletedTeachers as { id: string; name: string; email: string }[]) {
    process.stdout.write(`  Deleting auth user for ${teacher.email}... `);
    // First verify the user exists in auth
    const { data: authUserData, error: getUserErr } = await supabaseAdmin.auth.admin.getUserById(teacher.id);
    if (getUserErr || !authUserData?.user) {
      console.log(`SKIP - not in auth.users (${getUserErr?.message ?? 'not found'})`);
      // Clean up the dangling users row since auth user doesn't exist
      await supabaseAdmin.from('users').delete().eq('id', teacher.id);
      continue;
    }
    const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(teacher.id);
    if (authErr) {
      // Try deleting just the public.users row as fallback
      console.log(`AUTH DELETE FAILED (${authErr.message}) — removing public.users row only`);
      await supabaseAdmin.from('users').delete().eq('id', teacher.id);
    } else {
      console.log('OK');
    }
  }

  console.log('\nDone. These emails can now be re-imported via bulk import.');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
