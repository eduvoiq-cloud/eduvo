/// <reference types="node" />
/**
 * check-database.ts
 *
 * Quick script to check what's actually in the database.
 *
 * Usage:
 *   npx ts-node src/scripts/check-database.ts
 */

import 'dotenv/config';
import { supabaseAdmin } from '../config/supabase';

async function run() {
  console.log('\n═══ DATABASE CHECK ═══\n');

  // Schools
  const { data: schools, count: schoolCount } = await supabaseAdmin
    .from('schools')
    .select('id, name', { count: 'exact' });
  console.log(`📚 Schools: ${schoolCount ?? 0}`);
  if (schools) {
    schools.forEach(s => console.log(`   - ${s.name} (${s.id})`));
  }

  // Users (staff)
  const { data: users, count: userCount } = await supabaseAdmin
    .from('users')
    .select('id, name, email, role, school_id', { count: 'exact' })
    .order('role');
  console.log(`\n👥 Staff Users: ${userCount ?? 0}`);
  const byRole: Record<string, number> = {};
  if (users) {
    users.forEach((u: any) => {
      byRole[u.role] = (byRole[u.role] ?? 0) + 1;
    });
    Object.entries(byRole).forEach(([role, count]) => {
      console.log(`   - ${role}: ${count}`);
    });
  }

  // Students
  const { data: students, count: studentCount } = await supabaseAdmin
    .from('students')
    .select('id, full_name, class_name, section, school_id, phone_number, is_deleted', { count: 'exact' })
    .eq('is_deleted', false);
  console.log(`\n🎓 Students (active): ${studentCount ?? 0}`);
  if (students && students.length > 0) {
    const bySchool: Record<string, number> = {};
    const byClass: Record<string, number> = {};
    students.forEach((s: any) => {
      bySchool[s.school_id] = (bySchool[s.school_id] ?? 0) + 1;
      const classKey = `${s.class_name} ${s.section}`.trim();
      byClass[classKey] = (byClass[classKey] ?? 0) + 1;
    });
    console.log('   By school:');
    Object.entries(bySchool).forEach(([schoolId, count]) => {
      const school = schools?.find((sch: any) => sch.id === schoolId);
      console.log(`     - ${school?.name ?? schoolId}: ${count}`);
    });
    console.log('   By class:');
    Object.entries(byClass).forEach(([cls, count]) => {
      console.log(`     - ${cls}: ${count}`);
    });
    console.log(`\n   Sample students (first 5):`);
    students.slice(0, 5).forEach((s: any) => {
      console.log(`     - ${s.full_name} (${s.class_name} ${s.section}) - phone: ${s.phone_number ?? 'N/A'}`);
    });
  }

  // Teacher assignments
  const { data: assignments, count: assignCount } = await supabaseAdmin
    .from('teacher_assignments')
    .select('teacher_id, class_name, section, subject', { count: 'exact' });
  console.log(`\n📋 Teacher Assignments: ${assignCount ?? 0}`);
  if (assignments && assignments.length > 0) {
    const byTeacher: Record<string, number> = {};
    assignments.forEach((a: any) => {
      byTeacher[a.teacher_id] = (byTeacher[a.teacher_id] ?? 0) + 1;
    });
    console.log(`   Teachers with assignments: ${Object.keys(byTeacher).length}`);
    console.log(`\n   Sample assignments (first 5):`);
    assignments.slice(0, 5).forEach((a: any) => {
      const teacher = users?.find((u: any) => u.id === a.teacher_id);
      console.log(`     - ${teacher?.name ?? a.teacher_id} → ${a.class_name} ${a.section} (${a.subject})`);
    });
  }

  // Marks
  const { count: markCount } = await supabaseAdmin
    .from('marks')
    .select('id', { count: 'exact', head: true });
  console.log(`\n📊 Marks entered: ${markCount ?? 0}`);

  // Attendance
  const { count: attendanceCount } = await supabaseAdmin
    .from('attendance')
    .select('id', { count: 'exact', head: true });
  console.log(`\n✅ Attendance records: ${attendanceCount ?? 0}`);

  // Tests
  const { count: testCount } = await supabaseAdmin
    .from('tests')
    .select('id', { count: 'exact', head: true });
  console.log(`\n📝 Tests created: ${testCount ?? 0}`);

  console.log('\n═══════════════════════\n');
}

run().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
