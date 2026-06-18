/**
 * Student session helpers — separate from staff session.
 * Stores a custom JWT (type: "student") issued by the backend.
 */

export interface StudentProfile {
  id: string;
  name: string;
  phone_number: string;
  class_name: string | null;
  section: string | null;
  school_id: string;
}

const S_TOKEN_KEY = 'eduvo_student_token';
const S_USER_KEY  = 'eduvo_student_user';
const S_COOKIE    = 'eduvo_student_token';

export function saveStudentSession(token: string, student: StudentProfile): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(S_TOKEN_KEY, token);
  localStorage.setItem(S_USER_KEY, JSON.stringify(student));
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${S_COOKIE}=${token}; path=/; SameSite=Lax${secure}`;
}

export function getStudentToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(S_TOKEN_KEY);
}

export function getStudentUser(): StudentProfile | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(S_USER_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as StudentProfile; } catch { return null; }
}

export function clearStudentSession(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(S_TOKEN_KEY);
  localStorage.removeItem(S_USER_KEY);
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${S_COOKIE}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`;
}
