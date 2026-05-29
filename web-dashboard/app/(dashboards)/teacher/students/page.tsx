import { redirect } from 'next/navigation';

/**
 * Teachers don't have a standalone students page —
 * student lists are embedded in Marks, Attendance, and Fees pages.
 */
export default function TeacherStudentsRedirect() {
  redirect('/teacher/dashboard');
}
