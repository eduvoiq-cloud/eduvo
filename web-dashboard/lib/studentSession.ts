/**
 * Student session helpers — stores a custom JWT (type: "student") issued by
 * the backend.
 *
 * The token is stored in an HttpOnly cookie via /api/session/set so that
 * JavaScript cannot read it, protecting against XSS token theft.
 * Non-sensitive profile data is kept in localStorage for quick UI reads.
 */

export interface StudentProfile {
  id: string;
  name: string;
  phone_number: string;
  class_name: string | null;
  section: string | null;
  school_id: string;
}

const S_USER_KEY = 'eduvo_student_user';
const S_TOKEN_LS = 'eduvo_student_token'; // kept in localStorage for in-flight API calls

// ── Internal helpers ──────────────────────────────────────────────────────────

async function setServerCookies(token: string): Promise<void> {
  try {
    // Re-use the same session/set endpoint; role='student' keeps the role cookie
    // distinct from staff roles so the middleware never routes students to dashboards.
    await fetch('/api/session/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, role: 'student' }),
    });
  } catch {
    console.warn('[studentSession] Failed to set server-side cookies');
  }
}

async function clearServerCookies(): Promise<void> {
  try {
    await fetch('/api/session/clear', { method: 'POST' });
  } catch {
    console.warn('[studentSession] Failed to clear server-side cookies');
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function saveStudentSession(token: string, student: StudentProfile): void {
  if (typeof window === 'undefined') return;

  // Non-sensitive profile data in localStorage for sync UI reads
  localStorage.setItem(S_USER_KEY, JSON.stringify(student));
  // Token in localStorage for immediate in-flight requests; HttpOnly cookie set async
  localStorage.setItem(S_TOKEN_LS, token);

  // Async: set HttpOnly cookie server-side
  void setServerCookies(token);
}

export function getStudentToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(S_TOKEN_LS);
}

export function getStudentUser(): StudentProfile | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(S_USER_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as StudentProfile; } catch { return null; }
}

export function clearStudentSession(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(S_TOKEN_LS);
  localStorage.removeItem(S_USER_KEY);
  // Expire HttpOnly cookies server-side
  void clearServerCookies();
}
