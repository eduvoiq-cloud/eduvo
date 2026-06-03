/// <reference types="node" />
/**
 * fix-missing-phone-numbers.ts
 *
 * Sets phone numbers and passwords for all students that are missing them.
 * - Generates unique 10-digit phone numbers (98XXXXXXXX format)
 * - Sets password_hash = bcrypt hash of last 5 digits
 * - Sets is_first_login = true so they change password on first login
 *
 * Usage:
 *   npx ts-node src/scripts/fix-missing-phone-numbers.ts
 */

import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { supabaseAdmin } from '../config/supabase';

const BCRYPT_ROUNDS = 10;

async function run() {
  console.log('\n═══ FIX MISSING PHONE NUMBERS ═══\n');

  // Fetch all students without phone_number
  const { data: students, error } = await supabaseAdmin
    .from('students')
    .select('id, full_name, class_name, section, phone_number, phone, password_hash, school_id')
    .or('phone_number.is.null,phone_number.eq.')
    .eq('is_deleted', false);

  if (error) {
    console.error('Failed to fetch students:', error.message);
    process.exit(1);
  }

  if (!students || students.length === 0) {
    console.log('✅ All students already have phone numbers.');
    process.exit(0);
  }

  console.log(`Found ${students.length} students without phone numbers.\n`);

  let fixed = 0;
  const usedPhones = new Set<string>();

  // Pre-fetch all existing phone numbers to avoid collisions
  const { data: existingPhones } = await supabaseAdmin
    .from('students')
    .select('phone_number')
    .not('phone_number', 'is', null);

  if (existingPhones) {
    existingPhones.forEach((row: any) => {
      if (row.phone_number) usedPhones.add(row.phone_number);
    });
  }

  function generateUniquePhone(): string {
    let phone: string;
    do {
      // Generate 98XXXXXXXX format (10 digits, Indian mobile)
      phone = '98' + Math.floor(Math.random() * 100000000).toString().padStart(8, '0');
    } while (usedPhones.has(phone));
    usedPhones.add(phone);
    return phone;
  }

  for (const student of students) {
    const displayName = student.full_name || student.id;

    // Generate unique phone
    const phone_number = generateUniquePhone();
    
    // Default password = last 5 digits
    const defaultPassword = phone_number.slice(-5);
    const passwordHash = await bcrypt.hash(defaultPassword, BCRYPT_ROUNDS);

    // Update student
    const { error: updateError } = await supabaseAdmin
      .from('students')
      .update({
        phone_number,
        phone: phone_number, // Keep legacy column in sync
        password_hash: passwordHash,
        is_first_login: true,
      })
      .eq('id', student.id);

    if (updateError) {
      console.error(`  [ERR] ${displayName} — ${updateError.message}`);
    } else {
      fixed++;
      console.log(`  [OK] ${displayName} (${student.class_name} ${student.section}) → phone: ${phone_number}, pwd: ${defaultPassword}`);
    }
  }

  console.log(`\n✅ Fixed ${fixed} / ${students.length} students.`);
  console.log('\nStudents can now log in to the mobile app with:');
  console.log('  - Phone: (the number shown above)');
  console.log('  - Password: (last 5 digits of their phone)\n');
}

run().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
