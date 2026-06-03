/// <reference types="node" />
import 'dotenv/config';
import { supabaseAdmin } from '../config/supabase';

async function run() {
  // Find rosemary
  const { data: rosemary } = await supabaseAdmin
    .from('users')
    .select('id, name, email, school_id')
    .eq('email', 'rosemary@eduvo.com')
    .single();

  console.log('Rosemary:', rosemary);

  // Her assignments
  const { data: assignments } = await supabaseAdmin
    .from('teacher_assignments')
    .select('*')
    .eq('teacher_id', rosemary!.id);

  console.log('\nAssignments:', assignments);

  // Students in her school
  const { data: students } = await supabaseAdmin
    .from('students')
    .select('id, full_name, class_name, section, school_id')
    .eq('school_id', rosemary!.school_id!)
    .eq('is_deleted', false);

  console.log('\nAll students in her school:');
  students?.forEach((s: any) => console.log(`  - "${s.full_name}" class="${s.class_name}" section="${s.section}"`));
}

run().catch(console.error);
