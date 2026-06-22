/**
 * Typed API client — all requests go to the Express backend.
 * Never calls Supabase directly.
 */

// In local dev, NEXT_PUBLIC_API_URL=http://localhost:3001 (set in .env.local).
// On Vercel, this env var is intentionally NOT set — requests use a relative
// base URL so Next.js rewrites in next.config.ts proxy them to Railway.
const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Global 401 handler ────────────────────────────────────────────────────────
// When any API call returns 401, clear the session and redirect to login.
// This handles tokens that expire mid-session (after the initial /me check).
let _on401: (() => void) | null = null;
// When any API call returns 402, show the subscription expired screen.
let _on402: (() => void) | null = null;

export function registerOn401Handler(handler: () => void) {
  _on401 = handler;
}

export function registerOn402Handler(handler: () => void) {
  _on402 = handler;
}

function handle401() {
  if (_on401) _on401();
}

function handle402() {
  if (_on402) _on402();
}

export type AppRole = 'superadmin' | 'schooladmin' | 'teacher' | 'parent' | 'student';

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: AppRole;
  school_id: string | null;
  must_reset_password?: boolean;
  phone?: string | null;
}

/** A school record returned as part of the /me response (medium switcher) */
export interface MediumSchool {
  id: string;
  name: string;
  medium: 'english' | 'gujarati';
  /** Education board — available after Session 4 type update */
  board?: string | null;
}

export interface LoginResponse {
  token: string;
  refresh_token: string;
  expires_at: number;
  must_reset_password: boolean;
  user: UserProfile;
}

export interface ApiResponse<T> {
  success: boolean;
  message: string;
  data: T;
}

// ── Active medium school ID ───────────────────────────────────────────────────
// When the admin switches medium, this is set and injected into every request
// as X-School-ID so the backend uses the correct school context.
const ACTIVE_SCHOOL_KEY = 'eduvo_active_school_id';

export function getActiveSchoolId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(ACTIVE_SCHOOL_KEY);
}

export function setActiveSchoolId(schoolId: string | null): void {
  if (typeof window === 'undefined') return;
  if (schoolId) {
    localStorage.setItem(ACTIVE_SCHOOL_KEY, schoolId);
  } else {
    localStorage.removeItem(ACTIVE_SCHOOL_KEY);
  }
}

// ── Core fetch wrapper ────────────────────────────────────────────────────────

async function request<T>(
  path: string,
  options: RequestInit = {},
  token?: string
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Inject active medium school ID so the backend uses the correct school context
  const activeSchoolId = getActiveSchoolId();
  if (activeSchoolId) {
    headers['X-School-ID'] = activeSchoolId;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  const json = await res.json();

  if (!res.ok) {
    // Trigger global 401 handler so any expired mid-session token
    // clears the session and redirects to login automatically.
    if (res.status === 401) handle401();

    // Trigger global 402 handler — school subscription expired.
    if (res.status === 402) handle402();

    // Include the HTTP status in the message so callers (e.g. AuthContext)
    // can distinguish auth failures (401/403) from other errors.
    throw new Error(`${res.status}: ${json.message ?? `Request failed: ${res.status}`}`);
  }

  return json as ApiResponse<T>;
}

// ── Domain types ──────────────────────────────────────────────────────────────

export interface School {
  id: string;
  name: string;
  address: string;
  phone?: string;
  email?: string;
  /** Legacy field — use subscription_status for superadmin operations */
  is_active: boolean;
  /** Used by superadmin routes */
  subscription_status?: boolean;
  student_count?: number;
  teacher_count?: number;
  last_active_date?: string | null;
  created_at: string;
  updated_at?: string;
  /** Education board the school follows (e.g. GSEB, CBSE, ICSE) */
  board?: string;
  /** Medium of instruction */
  medium?: 'english' | 'gujarati';
  /** ID of parent school when this is a sibling medium school */
  parent_school_id?: string | null;
  /** Template used to generate result cards (e.g. percentage, grade, gseb, cbse) */
  result_template?: string;
}

export interface SchoolAdmin {
  id: string;
  name: string;
  email: string;
  role: 'schooladmin';
  school_id: string;
}

export interface Teacher {
  id: string;
  name: string;
  email: string;
  role: 'teacher';
  school_id: string;
  created_at: string;
}

export interface Student {
  id: string;
  full_name: string;
  date_of_birth: string;
  school_id: string;
  class_name: string;
  section?: string;
  parent_id?: string;
  email?: string;
  phone?: string;
  photo_url?: string;
  created_at: string;
}

export interface TeacherAssignment {
  id: string;
  teacher_id: string;
  school_id: string;
  class_name: string;
  section: string;
  subject: string;
  created_at: string;
}

export interface SchoolSettings {
  school_id: string;
  attendance_cutoff_time: string; // HH:MM
  timezone: string;
  term_name: string;
  academic_year: string;
  /** School profile fields — returned by GET /api/settings (joined from schools table) */
  name?: string | null;
  address?: string | null;
  board?: string | null;
  result_template?: string | null;
}

export interface Notification {
  id: string;
  title: string;
  body: string;
  type: 'announcement' | 'alert' | 'reminder' | 'grade' | 'attendance';
  recipient_id: string;
  sender_id: string;
  is_read: boolean;
  created_at: string;
}

export interface Mark {
  id: string;
  student_id: string;
  subject: string;
  score: number;
  max_score: number;
  term: string;
  exam_type: 'quiz' | 'midterm' | 'final' | 'assignment' | 'project' | 'unit_test' | 'mid_term' | 'class_test';
  notes?: string;
  recorded_by: string;
  created_at: string;
}

export interface AttendanceRecord {
  student_id: string;
  date: string;
  status: 'present' | 'absent' | 'late' | 'excused';
  source?: string;
  recorded_by?: string;
  notes?: string;
}

export interface AttendanceCheckResult {
  students: { id: string; full_name: string; class_name: string; section: string }[];
  existing: AttendanceRecord[];
}

export interface FeeRecord {
  student_id: string;
  full_name: string;
  class_name: string;
  section: string;
  fee_paid: boolean;
  total_fee_amount: number | null;
  amount_paid: number;
  payment_status: 'paid' | 'partial' | 'unpaid';
  fee_record: {
    id: string;
    term: string;
    academic_year: string;
    fee_paid: boolean;
    total_fee_amount?: number | null;
    amount_paid?: number;
    notes?: string;
  } | null;
}

export type QuestionType = 'mcq' | 'theory';

export interface MCQQuestion {
  type: 'mcq';
  text: string;
  marks: number;
  options: { text: string }[];
  correct_option: number;
  reasoning?: string;
  explanation?: string;
}

export interface TheoryQuestion {
  type: 'theory';
  text: string;
  marks: number;
}

export type TestQuestion = MCQQuestion | TheoryQuestion;

export interface Test {
  id: string;
  title: string;
  subject: string;
  class_name: string;
  section: string;
  term: string;
  exam_type?: string;
  date: string;
  available_from?: string | null;
  available_until?: string | null;
  time_limit_minutes?: number | null;
  shuffle_questions?: boolean;
  shuffle_options?: boolean;
  require_camera?: boolean;
  school_id: string;
  created_by: string;
  created_at: string;
  test_questions?: (TestQuestion & { id: string; order_index: number; test_id: string })[];
}

export interface TestAttemptSummary {
  attempt_id: string;
  student_id: string;
  student_name: string;
  roll_no: string;
  submitted_at: string;
  mcq_score: number | null;
  total_score: number | null;
  theory_pending: boolean;
}

export interface TestResultsSummaryRow {
  student_id: string;
  student_name: string;
  roll_no: string;
  attempted: boolean;
  score: number | null;
  max_score: number;
  submitted_at: string | null;
  theory_pending: boolean;
  // Integrity fields — null if no integrity log exists yet
  integrity_score: number | null;
  exit_count: number | null;
  total_exit_duration_seconds: number | null;
  is_suspicious: boolean | null;
  suspicious_reasons: string[] | null;
  // Web proctoring fields — null if submitted from mobile
  fullscreen_exit_count: number | null;
  face_absent_count: number | null;
  face_absent_duration_seconds: number | null;
  multiple_faces_count: number | null;
}

export interface TestResultsSummary {
  test_id: string;
  test_title: string;
  max_score: number;
  total_students: number;
  attempted_count: number;
  not_attempted_count: number;
  highest_score: number | null;
  lowest_score: number | null;
  avg_score: number | null;
  students: TestResultsSummaryRow[];
}

export interface TestAnswerDetail {
  question_id: string;
  order_index: number;
  question_text: string;
  question_type: 'mcq' | 'theory';
  marks: number;
  // MCQ fields
  option_a?: string | null;
  option_b?: string | null;
  option_c?: string | null;
  option_d?: string | null;
  correct_option?: string | null;
  selected_option?: string | null;
  is_correct?: boolean | null;
  // Theory fields
  theory_answer?: string | null;
  // Common
  marks_awarded: number | null;
}

export interface TestAttemptDetail {
  attempt_id: string;
  test_id: string;
  test_title: string;
  student_id: string;
  student_name: string;
  roll_no: string;
  started_at: string;
  submitted_at: string;
  mcq_score: number | null;
  total_score: number | null;
  // Web proctoring fields — null if submitted from mobile
  fullscreen_exit_count: number | null;
  face_absent_count: number | null;
  face_absent_duration_seconds: number | null;
  multiple_faces_count: number | null;
  answers: TestAnswerDetail[];
}

export interface Complaint {
  id: string;
  subject: string | null;
  // 'message' is what the API returns for student complaints
  message?: string | null;
  // 'body' retained for legacy parent complaints
  body?: string | null;
  status: 'pending' | 'reviewed' | 'resolved';
  recipient_type?: 'subject_teacher' | 'school_admin';
  school_id?: string;
  submitted_by?: string;
  student_id?: string;
  // Joined student fields returned by /api/complaints/admin and /api/complaints/teacher
  student_name?: string | null;
  class_name?: string | null;
  section?: string | null;
  resolution_note?: string | null;
  reviewed_by?: string;
  reviewed_at?: string | null;
  created_at: string;
  users?: { name: string; email: string };
}

// ── Auth endpoints ────────────────────────────────────────────────────────────

export const authApi = {
  login: (email: string, password: string) =>
    request<LoginResponse>('/api/auth/login/staff', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  /** Refresh an expired staff token using the stored refresh_token */
  refresh: (refreshToken: string) =>
    request<{ token: string; refresh_token: string; expires_at: number }>(
      '/api/auth/refresh',
      {
        method: 'POST',
        body: JSON.stringify({ refresh_token: refreshToken }),
      }
    ),

  logout: (token: string) =>
    request<null>('/api/auth/logout', { method: 'POST' }, token),

  me: (token: string) =>
    request<{ token_type: string; user: UserProfile; schools: MediumSchool[] }>('/api/auth/me', { method: 'GET' }, token),

  /** Send a password reset email to the given staff email address */
  forgotPassword: (email: string) =>
    request<null>('/api/auth/staff/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  /** Verify a reset token and set a new password (used on the reset-password page) */
  resetPassword: (token: string, password: string) =>
    request<null>('/api/auth/staff/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    }),

  /** Authenticated staff member sets a new password (clears must_reset_password) */
  changePassword: (token: string, newPassword: string) =>
    request<{ requires_relogin: boolean; token?: string; refresh_token?: string; expires_at?: number } | null>(
      '/api/auth/staff/change-password',
      {
        method: 'POST',
        body: JSON.stringify({ new_password: newPassword }),
      },
      token
    ),

  /** Create a new teacher account (school_admin only) */
  createUser: (
    token: string,
    payload: { email: string; password: string; name: string; role: string; school_id?: string }
  ) =>
    request<UserProfile>('/api/admin/teachers', {
      method: 'POST',
      body: JSON.stringify({ name: payload.name, email: payload.email, password: payload.password }),
    }, token),
};

// ── Superadmin endpoints ──────────────────────────────────────────────────────

export interface PaginatedSchools {
  data: School[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

export const superadminApi = {
  listSchools: (token: string, params?: { page?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.page !== undefined) qs.set('page', String(params.page));
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<PaginatedSchools>(`/api/superadmin/schools${query}`, { method: 'GET' }, token);
  },

  createSchool: (token: string, payload: {
    name: string;
    address: string;
    phone?: string;
    email?: string;
    board: string;
    medium: 'english' | 'gujarati' | 'both';
  }) =>
    request<School | { english: School; gujarati: School; dual_medium: true }>('/api/superadmin/schools', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, token),

  /** Create a school admin account for a specific school */
  createSchoolAdmin: (
    token: string,
    schoolId: string,
    payload: { name: string; email: string; phone?: string }
  ) =>
    request<UserProfile & { default_password?: string; password_is_phone?: boolean; already_existed?: boolean }>(`/api/superadmin/schools/${schoolId}/admin`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }, token),

  toggleSubscription: (token: string, schoolId: string, status: boolean) =>
    request<School>(`/api/superadmin/schools/${schoolId}/subscription`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    }, token),

  getSchoolDetail: (token: string, schoolId: string) =>
    request<School & {
      student_count: number;
      teacher_count: number;
      attendance_today: number;
      admins: Array<{ id: string; name: string; email: string; phone: string | null; created_at: string }>;
    }>(`/api/superadmin/schools/${schoolId}`, { method: 'GET' }, token),

  deleteSchool: (token: string, schoolId: string) =>
    request<{ deleted: boolean; school_id: string }>(`/api/superadmin/schools/${schoolId}`, {
      method: 'DELETE',
    }, token),
};

// ── Schools endpoints ─────────────────────────────────────────────────────────

export const schoolsApi = {
  list: (token: string) =>
    request<School[]>('/api/schools', { method: 'GET' }, token),

  get: (token: string, id: string) =>
    request<School>(`/api/schools/${id}`, { method: 'GET' }, token),

  create: (token: string, payload: { name: string; address: string; phone?: string; email?: string; board?: string; medium?: string }) =>
    request<School>('/api/schools', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, token),

  update: (token: string, id: string, payload: Partial<{ name: string; address: string; is_active: boolean; subscription_status: boolean }>) =>
    request<School>(`/api/schools/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }, token),

  delete: (token: string, id: string) =>
    request<null>(`/api/schools/${id}`, { method: 'DELETE' }, token),
};

// ── Students endpoints ────────────────────────────────────────────────────────

export interface PaginatedStudents {
  data: Student[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

export const studentsApi = {
  /**
   * List students.
   * - Pass a string school_id for the legacy call pattern (returns Student[]).
   * - Pass an options object for paginated/filtered calls.
   *   - limit=0  → fetch all, returns Student[] (no envelope)
   *   - limit>0  → returns PaginatedStudents envelope (default limit=50)
   */
  list(
    token: string,
    paramsOrSchoolId?: string | {
      school_id?: string;
      page?: number;
      limit?: number;
      search?: string;
      class_name?: string;
      section?: string;
    }
  ): Promise<ApiResponse<Student[] | PaginatedStudents>> {
    const qs = new URLSearchParams();

    if (typeof paramsOrSchoolId === 'string') {
      // Legacy: list(token, schoolId) — fetch all, no pagination
      if (paramsOrSchoolId) qs.set('school_id', paramsOrSchoolId);
      qs.set('limit', '0');
    } else if (paramsOrSchoolId) {
      const p = paramsOrSchoolId;
      if (p.school_id) qs.set('school_id', p.school_id);
      if (p.page !== undefined) qs.set('page', String(p.page));
      if (p.limit !== undefined) qs.set('limit', String(p.limit));
      if (p.search) qs.set('search', p.search);
      if (p.class_name) qs.set('class_name', p.class_name);
      if (p.section) qs.set('section', p.section);
    }

    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<Student[] | PaginatedStudents>(`/api/students${query}`, { method: 'GET' }, token);
  },

  create: (
    token: string,
    payload: {
      full_name: string;
      date_of_birth: string;
      school_id: string;
      class_name: string;
      section?: string;
      parent_id?: string;
      email?: string;
      phone?: string;
      photo_url?: string;
    }
  ) =>
    request<Student>('/api/students', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, token),

  update: (token: string, id: string, payload: Partial<Omit<Student, 'id' | 'created_at'>>) =>
    request<Student>(`/api/students/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }, token),

  remove: (token: string, id: string) =>
    request<null>(`/api/students/${id}`, { method: 'DELETE' }, token),


};

// ── Users endpoints (teachers, etc.) ─────────────────────────────────────────

export interface PaginatedUsers {
  data: Teacher[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

export const usersApi = {
  list: (token: string, params?: { role?: string; school_id?: string; page?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.role) qs.set('role', params.role);
    if (params?.school_id) qs.set('school_id', params.school_id);
    if (params?.page !== undefined) qs.set('page', String(params.page));
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<PaginatedUsers>(`/api/users${query}`, { method: 'GET' }, token);
  },

  remove: (token: string, id: string) =>
    request<null>(`/api/users/${id}`, { method: 'DELETE' }, token),
};

// ── Teacher assignments ───────────────────────────────────────────────────────

export const assignmentsApi = {
  list: (token: string, school_id: string) =>
    request<TeacherAssignment[]>(
      `/api/assignments?school_id=${school_id}`,
      { method: 'GET' },
      token
    ),

  create: (
    token: string,
    payload: { teacher_id: string; school_id: string; class_name: string; section: string; subject: string }
  ) =>
    request<TeacherAssignment>('/api/assignments', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, token),

  remove: (token: string, id: string) =>
    request<null>(`/api/assignments/${id}`, { method: 'DELETE' }, token),
};

// ── Class Admin API ───────────────────────────────────────────────────────────

export interface ClassAdminRow {
  id: string;
  teacher_id: string;
  teacher_name: string | null;
  class_name: string;
  section: string;
  appointed_at: string | null;
}

export const classAdminApi = {
  list: (token: string) =>
    request<ClassAdminRow[]>('/api/class-admin/list', { method: 'GET' }, token),

  appoint: (token: string, payload: { teacher_id: string; class_name: string; section: string }) =>
    request<{ success: boolean }>('/api/class-admin/appoint', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, token),

  remove: (token: string, payload: { class_name: string; section: string }) =>
    request<{ success: boolean }>('/api/class-admin/remove', {
      method: 'DELETE',
      body: JSON.stringify(payload),
    }, token),
};

// ── Class combos (marks-view) ─────────────────────────────────────────────────

export interface ClassCombo {
  class_name: string;
  section: string;
}

export function listClassCombos(token: string) {
  return request<ClassCombo[]>('/api/marks-view/classes', { method: 'GET' }, token);
}

// ── Notifications API ──────────────────────────────────────────────────────

export interface PaginatedNotifications {
  data: Notification[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
  unread_count: number;
}

export const notificationsApi = {
  list: (token: string, params?: { unread_only?: boolean; page?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.unread_only) qs.set('unread_only', 'true');
    if (params?.page !== undefined) qs.set('page', String(params.page));
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<PaginatedNotifications>(`/api/notifications${query}`, { method: 'GET' }, token);
  },

  send: (
    token: string,
    payload: {
      title: string;
      body: string;
      recipient_ids: string[];
      type: Notification['type'];
    }
  ) =>
    request<Notification[]>('/api/notifications', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, token),
};

// ── Settings endpoints ────────────────────────────────────────────────────────

export const settingsApi = {
  get: (token: string) =>
    request<SchoolSettings>('/api/settings', { method: 'GET' }, token),

  save: (token: string, payload: Partial<Omit<SchoolSettings, 'school_id'>>) =>
    request<SchoolSettings>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }, token),

  /** Create a sibling medium school account (school admin only) */
  addMedium: (token: string) =>
    request<{ id: string; name: string; medium: string; parent_school_id: string }>(
      '/api/settings/add-medium',
      { method: 'POST' },
      token
    ),

  /** Update school profile: board, result_template, display_name, display_address */
  updateProfile: (
    token: string,
    payload: {
      board?: string;
      result_template?: string;
      display_name?: string;
      display_address?: string;
    }
  ) =>
    request<{ success: boolean }>(
      '/api/settings/profile',
      { method: 'PUT', body: JSON.stringify(payload) },
      token
    ),
};

// ── Marks View types ──────────────────────────────────────────────────────────

export interface MarkRecord {
  id: string;
  subject: string;
  score: number;
  max_score: number;
  term: string;
  exam_type: string;
  notes?: string | null;
  created_at: string;
}

export interface StudentMarksRow {
  student_id: string;
  full_name: string;
  roll_number: string | null;
  class_name: string;
  section: string | null;
  marks: MarkRecord[];
  total_obtained: number;
  total_max: number;
  percentage: number | null;
  test_submissions: number;
}

export interface TestSubmissionRecord {
  attempt_id: string;
  test_id: string;
  test_title: string | null;
  subject: string | null;
  term: string | null;
  date: string | null;
  mcq_score: number | null;
  total_score: number | null;
  submitted_at: string | null;
  theory_pending: boolean;
  // Integrity fields — null if no integrity log exists yet
  integrity_score: number | null;
  exit_count: number | null;
  total_exit_duration_seconds: number | null;
  is_suspicious: boolean | null;
  suspicious_reasons: string[] | null;
}

export interface SuspiciousActivityRow {
  id: string;
  attempt_id: string;
  student_id: string;
  student_name: string;
  test_id: string | null;
  test_title: string | null;
  subject: string | null;
  test_date: string | null;
  exit_count: number;
  total_exit_duration_seconds: number;
  integrity_score: number | null;
  is_suspicious: boolean;
  suspicious_reasons: string[] | null;
  created_at: string;
}

export interface StudentMarksDetail {
  student: {
    id: string;
    full_name: string;
    roll_number: string | null;
    class_name: string;
    section: string | null;
  };
  marks: MarkRecord[];
  total_obtained: number;
  total_max: number;
  percentage: number | null;
  test_submissions: TestSubmissionRecord[];
  test_submissions_count: number;
}

// ── Marks View endpoints (read-only, teacher + admin) ─────────────────────────

export const marksViewApi = {
  /** GET /api/marks-view/class — all students in a class with their marks */
  listClass: (
    token: string,
    params: { class_name: string; section?: string; term?: string; exam_type?: string; subject?: string }
  ) => {
    const qs = new URLSearchParams({ class_name: params.class_name });
    if (params.section) qs.set('section', params.section);
    if (params.term) qs.set('term', params.term);
    if (params.exam_type) qs.set('exam_type', params.exam_type);
    if (params.subject) qs.set('subject', params.subject);
    return request<StudentMarksRow[]>(`/api/marks-view/class?${qs.toString()}`, { method: 'GET' }, token);
  },

  /** GET /api/marks-view/student/:id — single student with all their marks */
  getStudent: (
    token: string,
    studentId: string,
    params?: { term?: string; exam_type?: string }
  ) => {
    const qs = new URLSearchParams();
    if (params?.term) qs.set('term', params.term);
    if (params?.exam_type) qs.set('exam_type', params.exam_type);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<StudentMarksDetail>(`/api/marks-view/student/${studentId}${query}`, { method: 'GET' }, token);
  },
};

// ── Marks endpoints ───────────────────────────────────────────────────────────

export const marksApi = {
  list: (token: string, params?: { student_id?: string; subject?: string; term?: string; page?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.student_id) qs.set('student_id', params.student_id);
    if (params?.subject) qs.set('subject', params.subject);
    if (params?.term) qs.set('term', params.term);
    if (params?.page !== undefined) qs.set('page', String(params.page));
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ data: Mark[]; total: number; page: number; limit: number; total_pages: number }>(`/api/marks${query}`, { method: 'GET' }, token);
  },

  create: (token: string, payload: Omit<Mark, 'id' | 'recorded_by' | 'created_at'>) =>
    request<Mark>('/api/marks', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, token),

  update: (token: string, id: string, payload: Partial<Omit<Mark, 'id' | 'recorded_by' | 'created_at'>>) =>
    request<Mark>(`/api/marks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }, token),
};

// ── Attendance endpoints ──────────────────────────────────────────────────────

export const attendanceApi = {
  /** Check existing attendance for a class on a date */
  check: (token: string, params: { class_name: string; section?: string; date: string }) => {
    const qs = new URLSearchParams({ class_name: params.class_name, date: params.date });
    if (params.section) qs.set('section', params.section);
    return request<AttendanceCheckResult>(`/api/attendance/check?${qs.toString()}`, { method: 'GET' }, token);
  },

  /** Submit bulk manual attendance */
  bulkSubmit: (token: string, records: Omit<AttendanceRecord, 'source' | 'recorded_by'>[]) =>
    request<AttendanceRecord[]>('/api/attendance/bulk', {
      method: 'POST',
      body: JSON.stringify({ records }),
    }, token),

  /** Correct an existing attendance record (teacher) */
  correct: (token: string, payload: { attendance_id: string; new_status: string; reason: string }) =>
    request<AttendanceRecord>('/api/teacher/attendance/correct', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }, token),
};

// ── Fees endpoints ────────────────────────────────────────────────────────────

export interface PaginatedFees {
  data: FeeRecord[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

export const feesApi = {
  list: (token: string, params?: { class_name?: string; section?: string; term?: string; academic_year?: string; page?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.class_name) qs.set('class_name', params.class_name);
    if (params?.section) qs.set('section', params.section);
    if (params?.term) qs.set('term', params.term);
    if (params?.academic_year) qs.set('academic_year', params.academic_year);
    if (params?.page !== undefined) qs.set('page', String(params.page));
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<PaginatedFees>(`/api/fees${query}`, { method: 'GET' }, token);
  },

  updatePayment: (
    token: string,
    studentId: string,
    payload: {
      term?: string;
      academic_year?: string;
      total_fee_amount: number;
      amount_paid: number;
      notes?: string;
    }
  ) =>
    request<FeeRecord>(`/api/fees/${studentId}/payment`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }, token),

  toggle: (token: string, studentId: string, payload: { fee_paid: boolean; term: string; academic_year: string; notes?: string }) =>
    request<FeeRecord>(`/api/fees/${studentId}/toggle`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }, token),

  setBulkClassFee: (
    token: string,
    payload: { class_name: string; section: string; total_fee_amount: number; term?: string; academic_year?: string }
  ) =>
    request<{ total_students: number; updated: number; inserted: number }>('/api/fees/class-bulk', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, token),

  previewReminder: (
    token: string,
    payload: { class_name: string; section: string; custom_note?: string; term?: string; academic_year?: string }
  ) =>
    request<Array<{
      student_id: string;
      student_name: string;
      total_fee_amount: number;
      amount_paid: number;
      remaining_balance: number;
      message: string;
    }>>('/api/fees/preview-reminder', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, token),

  sendReminder: (
    token: string,
    payload: { class_name: string; section: string; custom_note?: string; term?: string; academic_year?: string }
  ) =>
    request<{ sent: number; skipped: number; skipped_names: string[] }>('/api/fees/send-reminder', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, token),
};

// ── Tests endpoints ───────────────────────────────────────────────────────────

export const testsApi = {
  list: (token: string, params?: { class_name?: string; section?: string; subject?: string; term?: string }) => {
    const qs = new URLSearchParams();
    if (params?.class_name) qs.set('class_name', params.class_name);
    if (params?.section) qs.set('section', params.section);
    if (params?.subject) qs.set('subject', params.subject);
    if (params?.term) qs.set('term', params.term);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<Test[]>(`/api/tests${query}`, { method: 'GET' }, token);
  },

  get: (token: string, id: string) =>
    request<Test>(`/api/tests/${id}`, { method: 'GET' }, token),

  create: (token: string, payload: {
    title: string; subject: string; class_name: string; section: string;
    term: string; date: string;
    exam_type?: string;
    available_from?: string | null;
    available_until?: string | null;
    time_limit_minutes?: number;
    shuffle_questions?: boolean;
    shuffle_options?: boolean;
    // New fields from daily test migration
    board?: string | null;
    chapter?: string | null;
    language?: string | null;
    contributes_to_streak?: boolean;
    // Chapter library fields
    chapter_library_id?: string | null;
    selected_topics?: string | null;
    // Web proctoring
    require_camera?: boolean;
    // Web attempt support
    allow_web_attempt?: boolean;
    questions: TestQuestion[];
  }) => {
    const OPTION_KEYS = ['a', 'b', 'c', 'd'] as const;

    // Transform frontend question shape → backend schema shape
    const mappedQuestions = payload.questions.map((q) => {
      if (q.type === 'mcq') {
        const mq = q as MCQQuestion;
        return {
          question_text: mq.text,
          question_type: 'mcq' as const,
          option_a: mq.options[0]?.text ?? '',
          option_b: mq.options[1]?.text ?? '',
          option_c: mq.options[2]?.text ?? '',
          option_d: mq.options[3]?.text ?? '',
          correct_option: OPTION_KEYS[mq.correct_option] ?? 'a',
          marks: mq.marks,
          reasoning: mq.reasoning ?? undefined,
          explanation: mq.explanation ?? undefined,
        };
      } else {
        const tq = q as TheoryQuestion;
        return {
          question_text: tq.text,
          question_type: 'theory' as const,
          marks: tq.marks,
        };
      }
    });

    // Resolve subject_id: the `subject` field holds either a UUID (subject_id)
    // or a display name string. The backend requires subject_id (UUID).
    // We pass it as subject_id directly; the caller is responsible for
    // ensuring the value is a UUID when needed.
    const body = {
      title: payload.title,
      subject_id: payload.subject,
      class: payload.class_name,
      section: payload.section,
      term: payload.term,
      date: payload.date,
      exam_type: payload.exam_type ?? 'class_test',
      available_from: payload.available_from ?? null,
      available_until: payload.available_until ?? null,
      time_limit_minutes: payload.time_limit_minutes ?? 30,
      shuffle_questions: payload.shuffle_questions ?? false,
      shuffle_options: payload.shuffle_options ?? false,
      board: payload.board ?? null,
      chapter: payload.chapter ?? null,
      language: payload.language ?? null,
      contributes_to_streak: payload.contributes_to_streak ?? false,
      chapter_library_id: payload.chapter_library_id ?? null,
      selected_topics: payload.selected_topics ?? null,
      require_camera: payload.require_camera ?? false,
      allow_web_attempt: payload.allow_web_attempt ?? false,
      questions: mappedQuestions,
    };

    return request<Test>('/api/tests/create', {
      method: 'POST',
      body: JSON.stringify(body),
    }, token);
  },

  remove: (token: string, id: string) =>
    request<null>(`/api/tests/${id}`, { method: 'DELETE' }, token),

  listAttempts: (token: string, testId: string) =>
    request<TestAttemptSummary[]>(`/api/tests/${testId}/attempts`, { method: 'GET' }, token),

  getAttemptDetail: (token: string, attemptId: string) =>
    request<TestAttemptDetail>(`/api/tests/attempts/${attemptId}/details`, { method: 'GET' }, token),

  markTheory: (token: string, payload: {
    attempt_id: string;
    theory_marks: { question_id: string; marks_awarded: number }[];
  }) =>
    request<{ attempt_id: string; total_score: number }>('/api/tests/theory/mark', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, token),

  getResultsSummary: (token: string, testId: string) =>
    request<TestResultsSummary>(`/api/tests/${testId}/results-summary`, { method: 'GET' }, token),

  getRestrictions: (token: string, testId: string) =>
    request<Array<{ student_id: string; full_name: string; roll_number: string; is_restricted: boolean }>>(
      `/api/tests/${testId}/restrictions`,
      { method: 'GET' },
      token
    ),

  setRestrictions: (token: string, testId: string, blockedStudentIds: string[]) =>
    request<{ blocked_count: number }>(`/api/tests/${testId}/restrictions`, {
      method: 'PUT',
      body: JSON.stringify({ blocked_student_ids: blockedStudentIds }),
    }, token),

  getSuspiciousActivity: (token: string) =>
    request<SuspiciousActivityRow[]>('/api/tests/suspicious-activity', { method: 'GET' }, token),
};

// ── Onboarding endpoints ──────────────────────────────────────────────────────

export type OnboardingStep =
  | 'school_created'
  | 'teachers_imported'
  | 'students_imported'
  | 'classes_created'
  | 'teachers_assigned';

export interface OnboardingProgress {
  school_id: string;
  school_created: boolean;
  teachers_imported: boolean;
  students_imported: boolean;
  classes_created: boolean;
  teachers_assigned: boolean;
  completed: boolean;
  created_at: string;
  updated_at: string;
}

export const onboardingApi = {
  getStatus: (token: string) =>
    request<OnboardingProgress>('/api/onboarding/status', { method: 'GET' }, token),

  updateStep: (token: string, step: OnboardingStep, completed: boolean) =>
    request<OnboardingProgress>('/api/onboarding/step', {
      method: 'PUT',
      body: JSON.stringify({ step, completed }),
    }, token),
};

// ── Audit log types ───────────────────────────────────────────────────────────

export interface AuditLog {
  id: string;
  user_id: string | null;
  action: string;
  table_name?: string;
  details?: Record<string, unknown>;
  created_at: string;
  users?: { name: string; role: string } | null;
}

// ── Complaints endpoints ──────────────────────────────────────────────────────

export const complaintsApi = {
  /**
   * List complaints. Role-aware:
   * - teacher  → GET /api/complaints/teacher
   * - schooladmin / superadmin → GET /api/complaints/admin
   * Falls back to /api/complaints/teacher when role is not provided.
   */
  list: (token: string, params?: { status?: string; role?: string }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    const query = qs.toString() ? `?${qs.toString()}` : '';

    const role = params?.role;
    const subPath =
      role === 'schooladmin' || role === 'superadmin' ? '/admin' : '/teacher';

    return request<Complaint[]>(`/api/complaints${subPath}${query}`, { method: 'GET' }, token);
  },

  updateStatus: (token: string, id: string, payload: { status: Complaint['status']; resolution_note?: string }) =>
    request<Complaint>(`/api/complaints/${id}/status`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }, token),
};

// ── Admin endpoints ───────────────────────────────────────────────────────────

export interface AdminStudent {
  id: string;
  full_name: string;
  class_name: string;
  section: string;
  roll_number?: string;
  phone?: string;           // login phone (student_phone if set, else parent_phone)
  phone_number?: string;    // same as phone (kept in sync)
  parent_phone?: string;    // parent's WhatsApp/contact number — always stored separately
  photo_url?: string;
  parent_id?: string | null;
  school_id: string;
  is_deleted: boolean;
  deleted_at?: string | null;
  created_at: string;
}

export const adminApi = {
  auditLogs: (token: string, limit = 10) =>
    request<AuditLog[]>(`/api/admin/audit-logs?limit=${limit}`, { method: 'GET' }, token),

  /** List students (active or deleted) via admin route. Supports pagination. */
  listStudents: (token: string, params?: {
    include_deleted?: boolean;
    page?: number;
    limit?: number;
    search?: string;
    class_name?: string;
    section?: string;
  }) => {
    const qs = new URLSearchParams();
    if (params?.include_deleted) qs.set('include_deleted', 'true');
    if (params?.page !== undefined) qs.set('page', String(params.page));
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    if (params?.search) qs.set('search', params.search);
    if (params?.class_name) qs.set('class_name', params.class_name);
    if (params?.section) qs.set('section', params.section);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<AdminStudent[]>(`/api/admin/students${query}`, { method: 'GET' }, token);
  },

  /** Create student via admin route (handles parent invite) */
  createStudent: (
    token: string,
    payload: {
      name: string;
      class: string;
      section: string;
      roll_number?: string;
      parent_email?: string;
      parent_phone: string;    // required — used for WhatsApp & login fallback
      student_phone?: string;  // optional — if set, used as login instead of parent_phone
      photo_url?: string;
    }
  ) =>
    request<AdminStudent>('/api/admin/students', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, token),

  /** Update student via admin route */
  updateStudent: (
    token: string,
    id: string,
    payload: {
      name?: string;
      class?: string;
      section?: string;
      roll_number?: string;
      parent_email?: string;
      parent_phone?: string;   // updates WhatsApp contact number
      student_phone?: string;  // updates login phone
      photo_url?: string;
    }
  ) =>
    request<AdminStudent>(`/api/admin/students/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }, token),

  /** Soft-delete student */
  deleteStudent: (token: string, id: string) =>
    request<{ id: string }>(`/api/admin/students/${id}`, { method: 'DELETE' }, token),

  /** Restore soft-deleted student */
  restoreStudent: (token: string, id: string) =>
    request<AdminStudent>(`/api/admin/students/restore/${id}`, { method: 'POST' }, token),
};

// ── Premium / parent subscriptions ───────────────────────────────────────────

export interface ParentSubscription {
  id: string;
  student_id: string;
  school_id: string;
  plan_type: 'premium_junior' | 'premium_senior';
  status: 'active' | 'inactive';
  activated_by_admin_id: string | null;
  activated_at: string | null;
  starts_at: string | null;
  expires_at: string | null;
  last_renewed_at: string | null;
  renewed_by_admin_id: string | null;
  deactivated_at: string | null;
  created_at: string;
  updated_at: string;
  students?: {
    id: string;
    full_name: string;
    class_name: string;
    section: string;
  } | null;
  /** Joined admin user name — populated by some list endpoints */
  activator?: { name: string } | null;
}

export interface RevenueShare {
  id: string;
  school_id: string;
  month: string; // YYYY-MM-DD (first of month)
  total_active_premium_count: number;
  rate_per_student: number;
  amount_owed: number;
  payout_status: 'pending' | 'invoiced' | 'paid';
  invoiced_at: string | null;
  created_at: string;
  schools?: { id: string; name: string } | null;
}

export interface PremiumSubscriptionsResponse {
  data: ParentSubscription[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

export const premiumApi = {
  /** List all subscriptions for the current school (admin) */
  listSubscriptions: (
    token: string,
    params?: { status?: string; class_name?: string; page?: number; limit?: number }
  ) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.class_name) qs.set('class_name', params.class_name);
    if (params?.page !== undefined) qs.set('page', String(params.page));
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<PremiumSubscriptionsResponse>(`/api/premium/subscriptions${query}`, { method: 'GET' }, token);
  },

  /** Activate premium for a single student */
  activate: (token: string, studentId: string) =>
    request<ParentSubscription>(`/api/premium/subscriptions/${studentId}/activate`, { method: 'POST' }, token),

  /** Deactivate premium for a single student */
  deactivate: (token: string, studentId: string) =>
    request<ParentSubscription>(`/api/premium/subscriptions/${studentId}/deactivate`, { method: 'POST' }, token),

  /** Renew premium for a single student by 1 month */
  renew: (token: string, studentId: string) =>
    request<ParentSubscription>(`/api/premium/subscriptions/${studentId}/renew`, { method: 'POST' }, token),

  /** Revenue ledger for the current school (admin) */
  getRevenue: (token: string, params?: { year?: string }) => {
    const qs = new URLSearchParams();
    if (params?.year) qs.set('year', params.year);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<RevenueShare[]>(`/api/premium/revenue${query}`, { method: 'GET' }, token);
  },

  // ── Superadmin ──────────────────────────────────────────────────────────────

  /** All schools' revenue (superadmin) */
  getAllRevenue: (token: string, params?: { year?: string; status?: string }) => {
    const qs = new URLSearchParams();
    if (params?.year) qs.set('year', params.year);
    if (params?.status) qs.set('status', params.status);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<RevenueShare[]>(`/api/premium/revenue/all${query}`, { method: 'GET' }, token);
  },

  /** Calculate / upsert a month's revenue row (superadmin) */
  calculateRevenue: (
    token: string,
    payload: { month: string; school_id?: string; rate_per_student?: number }
  ) =>
    request<RevenueShare[]>('/api/premium/revenue/calculate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, token),

  /** Update payout_status for a revenue_share row (superadmin) */
  updatePayoutStatus: (
    token: string,
    id: string,
    payout_status: 'pending' | 'invoiced' | 'paid'
  ) =>
    request<RevenueShare>(`/api/premium/revenue/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ payout_status }),
    }, token),

  /** List subscriptions for a specific school (superadmin — passes school_id via query) */
  listSchoolSubscriptions: (
    token: string,
    schoolId: string,
    params?: { status?: string; page?: number; limit?: number }
  ) => {
    const qs = new URLSearchParams({ school_id: schoolId });
    if (params?.status) qs.set('status', params.status);
    if (params?.page !== undefined) qs.set('page', String(params.page));
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    return request<PremiumSubscriptionsResponse>(`/api/premium/subscriptions?${qs.toString()}`, { method: 'GET' }, token);
  },

  /** Schools summary with live premium counts (superadmin) */
  getSchoolsSummary: (token: string) =>
    request<Array<{
      school_id: string;
      school_name: string;
      subscription_status: boolean;
      total_students: number;
      active_premium_count: number;
      junior_count: number;
      senior_count: number;
      rate_per_student: number;
      amount_owed: number;
      this_month_status: 'pending' | 'invoiced' | 'paid' | null;
    }>>('/api/premium/schools/summary', { method: 'GET' }, token),

  /** Admin read-only summary: all students with activation status + days left */
  getStudentSummary: (token: string) =>
    request<{
      total: number;
      activated: number;
      not_activated: number;
      students: Array<{
        id: string;
        full_name: string;
        class_name: string;
        section: string;
        is_activated: boolean;
        activated_at: string | null;
        expires_at: string | null;
        days_left: number | null;
      }>;
    }>('/api/premium/student-summary', { method: 'GET' }, token),
};

// ── Teacher Activity Report types ────────────────────────────────────────────

export interface TeacherActivityRow {
  teacher_id:        string;
  name:              string;
  email:             string;
  tests_created:     number;
  marks_entered:     number;
  homework_assigned: number;
  last_active_at:    string | null;
}

export interface TeacherActivityReport {
  days:     number;
  teachers: TeacherActivityRow[];
}

export const teacherActivityApi = {
  get: (token: string, days = 30) =>
    request<TeacherActivityReport>(
      `/api/admin/teacher-activity?days=${days}`,
      { method: 'GET' },
      token
    ),
};

// ── Class Comparison Report types ─────────────────────────────────────────────

export interface ClassComparisonRow {
  class_name:          string;
  section:             string;
  student_count:       number;
  avg_marks_pct:       number | null;
  attendance_pct:      number | null;
  homework_completion: number | null;
  tests_conducted:     number;
}

export interface ClassComparisonReport {
  year:    number;
  month:   number;
  classes: ClassComparisonRow[];
}

export const classComparisonApi = {
  get: (token: string, params: { year: number; month: number }) => {
    const qs = new URLSearchParams({ year: String(params.year), month: String(params.month) });
    return request<ClassComparisonReport>(
      `/api/admin/class-comparison?${qs.toString()}`,
      { method: 'GET' },
      token
    );
  },
};

// ── Monthly Performance Snapshot types ───────────────────────────────────────

export interface ClassRankingRow {
  class_name:    string;
  section:       string | null;
  avg_pct:       number;
  exam_count:    number;
  student_count: number;
  rank:          number;
}

export interface SnapshotStudentRow {
  student_id:  string;
  full_name:   string;
  class_name:  string;
  section:     string | null;
  avg_pct:     number;
  mark_count:  number;
  rank:        number;
}

export interface MonthlySnapshot {
  year:           number;
  month:          number;
  classRankings:  ClassRankingRow[];
  topStudents:    SnapshotStudentRow[];
  bottomStudents: SnapshotStudentRow[];
}

export const performanceApi = {
  /**
   * GET /api/admin/performance/monthly-snapshot
   * Admin-only. Returns class rankings + top/bottom 10 students for a given month.
   */
  monthlySnapshot: (token: string, params: { year: number; month: number }) => {
    const qs = new URLSearchParams({
      year:  String(params.year),
      month: String(params.month),
    });
    return request<MonthlySnapshot>(
      `/api/admin/performance/monthly-snapshot?${qs.toString()}`,
      { method: 'GET' },
      token
    );
  },
};

// ── Homework AI Stats ─────────────────────────────────────────────────────────

export interface HomeworkAIStats {
  total_submissions_this_week: number;
  auto_checked_count: number;
  auto_checked_pct: number;
  flagged_count: number;
  flagged_pct: number;
  total_checked: number;
  cache_hit_count: number;
  teachers_with_pending: Array<{ teacher_id: string; name: string; pending_count: number }>;
  week_start: string;
}

export const homeworkAIStatsApi = {
  get: (token: string) =>
    request<HomeworkAIStats>('/api/homework/ai-stats', { method: 'GET' }, token),
};

// ── Monthly Recovery Schedules ────────────────────────────────────────────────

export type RecoveryScheduleStatus =
  | 'pending_teacher_approval'
  | 'approved'
  | 'postponed'
  | 'cancelled'
  | 'pack_generated'
  | 'test_generated'
  | 'completed';

export type TeacherDecision = 'generate_now' | 'postpone' | 'cancel' | null;

export type PostponeReason =
  | 'unit_test'
  | 'final_exam'
  | 'school_event'
  | 'teacher_choice'
  | 'other'
  | null;

export interface RecoverySchedule {
  id: string;
  school_id: string;
  class: string;
  section: string;
  subject: string;
  scheduled_month: string; // YYYY-MM-DD (first of month)
  scheduled_test_date: string | null;
  recovery_pack_date: string | null;
  teacher_id: string | null;
  status: RecoveryScheduleStatus;
  teacher_decision: TeacherDecision;
  teacher_decision_at: string | null;
  teacher_decision_reason: string | null;
  postpone_reason: PostponeReason;
  created_at: string;
  updated_at: string;
}

export const recoverySchedulesApi = {
  /** GET pending/postponed schedules for the authenticated teacher */
  listPending: (token: string) =>
    request<RecoverySchedule[]>('/api/recovery-schedules', { method: 'GET' }, token),

  /** GET all schedules for this month (read-only table) */
  listAll: (token: string, month?: string) => {
    const qs = month ? `?month=${month}` : '';
    return request<RecoverySchedule[]>(`/api/recovery-schedules/all${qs}`, { method: 'GET' }, token);
  },

  /** GET count of pending_teacher_approval schedules */
  pendingCount: (token: string) =>
    request<{ count: number }>('/api/recovery-schedules/pending-count', { method: 'GET' }, token),

  /** Approve — sets status=approved, teacher_decision=generate_now */
  approve: (token: string, id: string) =>
    request<RecoverySchedule>(`/api/recovery-schedules/${id}/approve`, { method: 'PUT' }, token),

  /** Postpone — new date + reason */
  postpone: (token: string, id: string, payload: { new_test_date: string; postpone_reason: PostponeReason }) =>
    request<RecoverySchedule>(`/api/recovery-schedules/${id}/postpone`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }, token),

  /** Cancel this month's recovery test */
  cancel: (token: string, id: string) =>
    request<RecoverySchedule>(`/api/recovery-schedules/${id}/cancel`, { method: 'PUT' }, token),

  /** GET pack + test generation status for a specific schedule */
  generationStatus: (token: string, id: string) =>
    request<RecoveryGenerationStatus>(`/api/recovery-schedules/${id}/generation-status`, { method: 'GET' }, token),
};

// ── Recovery generation status ────────────────────────────────────────────────

export type GenerationStatusLevel = 'none' | 'pending' | 'processing' | 'completed' | 'failed';

export interface GenerationStatusSummary {
  status: GenerationStatusLevel;
  total: number;
  completed: number;
  processing: number;
  failed: number;
}

export interface RecoveryGenerationStatus {
  schedule_id: string;
  scheduled_test_date: string | null;
  pack: GenerationStatusSummary;
  test: GenerationStatusSummary & { available_date: string | null };
}

// ── Recovery generation trigger ───────────────────────────────────────────────

export const recoveryApi = {
  generatePack: (token: string, scheduleId: string) =>
    request<{ message: string; schedule_id: string }>(
      '/api/recovery/generate-pack',
      { method: 'POST', body: JSON.stringify({ schedule_id: scheduleId }) },
      token
    ),

  generateTest: (token: string, scheduleId: string) =>
    request<{ message: string; schedule_id: string }>(
      '/api/recovery/generate-test',
      { method: 'POST', body: JSON.stringify({ schedule_id: scheduleId }) },
      token
    ),
};

// ── At-Risk Students ──────────────────────────────────────────────────────────

export interface AtRiskStudent {
  student_id:     string;
  full_name:      string;
  class_name:     string;
  section:        string;
  risk_score:     number;
  low_attendance: boolean;
  low_marks:      boolean;
  attendance_pct: number;
  avg_marks_pct:  number;
}

export interface AtRiskResponse {
  total_at_risk: number;
  students:      AtRiskStudent[];
}

export const atRiskApi = {
  get: (token: string) =>
    request<AtRiskResponse>('/api/admin/at-risk', { method: 'GET' }, token),
};

// ── School Health Score ───────────────────────────────────────────────────────

export interface HealthScoreComponent {
  score: number;
  max:   number;
  pct:   number;
  label: string;
}

export interface SchoolHealthScore {
  health_score: number;
  grade:        string;
  components: {
    attendance: HealthScoreComponent;
    marks:      HealthScoreComponent;
    tests:      HealthScoreComponent;
    engagement: HealthScoreComponent;
  };
  month: number;
  year:  number;
}

export const healthScoreApi = {
  get: (token: string) =>
    request<SchoolHealthScore>('/api/admin/health-score', { method: 'GET' }, token),
};

// ── Teacher Test Analytics ────────────────────────────────────────────────────

export interface TestScoreDistributionBucket {
  range: string;
  count: number;
}

export interface TestQuestionAnalytic {
  question_id:   string;
  question_text: string;
  order_index:   number;
  correct_count: number;
  wrong_count:   number;
  skip_count:    number;
  correct_pct:   number;
}

export interface TestAnalyticsResult {
  test_id:             string;
  test_title:          string;
  subject:             string;
  class_name:          string;
  section:             string;
  max_score:           number;
  total_students:      number;
  attempted_count:     number;
  not_attempted_count: number;
  avg_score:           number;
  highest_score:       number;
  lowest_score:        number;
  score_distribution:  TestScoreDistributionBucket[];
  question_analytics:  TestQuestionAnalytic[];
}

export const teacherTestAnalyticsApi = {
  get: (token: string, testId: string) =>
    request<TestAnalyticsResult>(`/api/teacher/test-analytics/${testId}`, { method: 'GET' }, token),
};
