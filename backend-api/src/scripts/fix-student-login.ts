/**
 * fix-student-login.ts
 *
 * Finds students where phone_number is null/empty but the legacy `phone`
 * column has a value, copies it over, and generates a default password_hash
 * (last 5 digits of their phone) if password_hash is missing.
 *
 * Also fixes any specific phone passed as a CLI argument:
 *   npx ts-node src/scripts/fix-student-login.ts 9876543201
 *
 * Run from backend-api/:
 *   npx ts-node src/scripts/fix-student-login.ts
 */

import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { supabaseAdmin } from '../config/supabase';

const BCRYPT_ROUNDS = 12;
const targetPhone = process.argv[2] ?? null;

async function run() {
  console.log('\n── Fix Student Login Data ───────────────────────────────────');

  // Fetch all students (or a specific one) that may have broken login data
  let query = supabaseAdmin
    .from('students')
    .select('id, full_name, name, phone_number, phone, password_hash, is_first_login')
    .eq('is_deleted', false);

  if (targetPhone) {
    query = query.or(`phone_number.eq.${targetPhone},phone.eq.${targetPhone}`);
  }

  const { data: students, error } = await query;

  if (error) {
    console.error('Failed to fetch students:', error.message);
    process.exit(1);
  }

  if (!students || students.length === 0) {
    console.log(targetPhone
      ? `No student found with phone ${targetPhone}`
      : 'No students found');
    process.exit(0);
  }

  console.log(`Found ${students.length} student(s) to check.\n`);

  let fixed = 0;

  for (const student of students) {
    const displayName = student.full_name || student.name || student.id;

    // Determine the canonical phone number
    const phone = (student.phone_number || student.phone || '').trim();

    if (!phone) {
      console.log(`  [skip] ${displayName} — no phone number in either column`);
      continue;
    }

    const needsPhoneNumber = !student.phone_number;
    const needsPasswordHash = !student.password_hash;

    if (!needsPhoneNumber && !needsPasswordHash) {
      console.log(`  [ok]   ${displayName} (${phone}) — already has phone_number + password_hash`);
      continue;
    }

    // Build the update payload
    const updates: Record<string, unknown> = {};

    if (needsPhoneNumber) {
      updates.phone_number = phone;
      updates.phone = phone;
      console.log(`  [fix]  ${displayName} — setting phone_number = ${phone}`);
    }

    if (needsPasswordHash) {
      const defaultPassword = phone.slice(-5);
      const hash = await bcrypt.hash(defaultPassword, BCRYPT_ROUNDS);
      updates.password_hash = hash;
      updates.is_first_login = true;
      console.log(`  [fix]  ${displayName} — setting password_hash (default: ${defaultPassword}) + is_first_login = true`);
    }

    const { error: updateError } = await supabaseAdmin
      .from('students')
      .update(updates)
      .eq('id', student.id);

    if (updateError) {
      console.error(`  [err]  ${displayName} — ${updateError.message}`);
    } else {
      fixed++;
      console.log(`  [done] ${displayName} — fixed`);
    }
  }

  console.log(`\n── Done: ${fixed} student(s) fixed ─────────────────────────\n`);
}

run().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
