/**
 * reset-student-password.ts
 *
 * Resets a student's password back to the default (last 5 digits of their phone).
 * Sets is_first_login = true so they are prompted to change it on next login.
 *
 * Usage:
 *   npx ts-node src/scripts/reset-student-password.ts <phone_number>
 *
 * Example:
 *   npx ts-node src/scripts/reset-student-password.ts 9876543201
 */

import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { supabaseAdmin } from '../config/supabase';

const phone = process.argv[2];

if (!phone) {
  console.error('Usage: npx ts-node src/scripts/reset-student-password.ts <phone_number>');
  process.exit(1);
}

async function run() {
  const defaultPwd = phone.slice(-5);
  const hash = await bcrypt.hash(defaultPwd, 10);

  const { data, error } = await supabaseAdmin
    .from('students')
    .update({ password_hash: hash, is_first_login: true })
    .or(`phone_number.eq.${phone},phone.eq.${phone}`)
    .select('id, full_name, name')
    .single();

  if (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }

  const name = data.full_name || data.name || data.id;
  console.log(`\nPassword reset for: ${name}`);
  console.log(`Phone:    ${phone}`);
  console.log(`Password: ${defaultPwd}`);
  console.log(`is_first_login set to true — they will be asked to change password on login.\n`);
}

run().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
