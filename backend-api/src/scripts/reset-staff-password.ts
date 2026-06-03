/// <reference types="node" />
/**
 * reset-staff-password.ts
 *
 * Resets a staff user's Supabase Auth password by email.
 *
 * Usage:
 *   npx ts-node src/scripts/reset-staff-password.ts <email> <new_password>
 *
 * Example:
 *   npx ts-node src/scripts/reset-staff-password.ts rosemary@eduvo.com Test@1234
 */

import 'dotenv/config';
import { supabaseAdmin } from '../config/supabase';

async function run() {
  const email = process.argv[2];
  const newPassword = process.argv[3];

  if (!email || !newPassword) {
    console.error('Usage: npx ts-node src/scripts/reset-staff-password.ts <email> <new_password>');
    process.exit(1);
  }

  console.log(`\nResetting password for: ${email}`);

  // 1. Look up the user's auth ID from the users table
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('users')
    .select('id, name, email, role')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  if (profileError || !profile) {
    console.error(`No user found in users table with email: ${email}`);
    process.exit(1);
  }

  console.log(`Found user: ${profile.name} (${profile.role}) — id: ${profile.id}`);

  // 2. Update the password in Supabase Auth
  const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(
    profile.id,
    { password: newPassword }
  );

  if (authError) {
    console.error(`Failed to update password: ${authError.message}`);
    process.exit(1);
  }

  console.log(`\n✓ Password for ${email} has been reset to: ${newPassword}`);
  console.log('They can now log in with this password.\n');
}

run().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
