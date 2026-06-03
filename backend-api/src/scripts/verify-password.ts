import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { supabaseAdmin } from '../config/supabase';

const phone = process.argv[2];
const password = process.argv[3];

if (!phone || !password) {
  console.error('Usage: npx ts-node src/scripts/verify-password.ts <phone> <password>');
  process.exit(1);
}

async function run() {
  const { data: student, error } = await supabaseAdmin
    .from('students')
    .select('id, full_name, name, phone_number, phone, password_hash, is_first_login')
    .or(`phone_number.eq.${phone},phone.eq.${phone}`)
    .single();

  if (error || !student) {
    console.error('Student not found:', error?.message);
    process.exit(1);
  }

  console.log('\nStudent found:');
  console.log('  Name:', student.full_name || student.name);
  console.log('  phone_number:', student.phone_number);
  console.log('  phone:', student.phone);
  console.log('  password_hash set:', !!student.password_hash);
  console.log('  is_first_login:', student.is_first_login);

  if (!student.password_hash) {
    console.log('\n  ERROR: No password_hash set!');
    process.exit(1);
  }

  const match = await bcrypt.compare(password, student.password_hash);
  console.log(`\n  Password "${password}" matches hash: ${match}`);
}

run().catch(console.error);
