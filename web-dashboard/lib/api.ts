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

export function registerOn401Handler(handler: () => void) {
  _on401 = handler;
}

function handle401() {
  if (_on401) _on401();
}

export type AppRole = 'superadmin' | 'schooladmin' | 'teacher' | 'parent' | 'student';

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: AppRole;
  school_id: string | null;
}

export interface LoginResponse {
  token: string;
  refresh_token: string;
  expires_at: number;
  user: UserProfile;
}

export interface ApiResponse<T> {
  success: boolean;
  message: string;
  data: T;
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

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  const json = await res.json();

  if (!res.ok) {
    // Trigger global 401 handler so any expired mid-session token
    // clears the session and redirects to login automatically.
    if (res.status === 401) handle401();

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
  date: string;
  school_id: string;
  created_by: string;
  created_at: string;
  test_questions?: (TestQuestion & { id: string; order_index: number; test_id: string })[];
}

export interface Complaint {
  id: string;
  subject: string;
  body: string;
  status: 'pending' | 'reviewed' | 'resolved';
  school_id: string;
  submitted_by: string;
  student_id?: string;
  resolution_note?: string;
  reviewed_by?: string;
  reviewed_at?: string;
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

  logout: (token: string) =>
    request<null>('/api/auth/logout', { method: 'POST' }, token),

  me: (token: string) =>
    request<{ token_type: string; user: UserProfile }>('/api/auth/me', { method: 'GET' }, token),

  /** Create a new user account (admin-only) */
  createUser: (
    token: string,
    payload: { email: string; password: string; name: string; role: string; school_id?: string }
  ) =>
    request<UserProfile>('/api/auth/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, token),
};

// ── Schools endpoints ─────────────────────────────────────────────────────────

export const schoolsApi = {
  list: (token: string) =>
    request<School[]>('/api/schools', { method: 'GET' }, token),

  get: (token: string, id: string) =>
    request<School>(`/api/schools/${id}`, { method: 'GET' }, token),

  create: (token: string, payload: { name: string; address: string; phone?: string; email?: string }) =>
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

export const usersApi = {
  list: (token: string, params?: { role?: string; school_id?: string }) => {
    const qs = new URLSearchParams();
    if (params?.role) qs.set('role', params.role);
    if (params?.school_id) qs.set('school_id', params.school_id);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<Teacher[]>(`/api/users${query}`, { method: 'GET' }, token);
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

// ── Notifications endpoints ───────────────────────────────────────────────────

export const notificationsApi = {
  list: (token: string) =>
    request<Notification[]>('/api/notifications', { method: 'GET' }, token),

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
};

// ── Marks endpoints ───────────────────────────────────────────────────────────

export const marksApi = {
  list: (token: string, params?: { student_id?: string; subject?: string; term?: string }) => {
    const qs = new URLSearchParams();
    if (params?.student_id) qs.set('student_id', params.student_id);
    if (params?.subject) qs.set('subject', params.subject);
    if (params?.term) qs.set('term', params.term);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<Mark[]>(`/api/marks${query}`, { method: 'GET' }, token);
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

export const feesApi = {
  list: (token: string, params?: { class_name?: string; section?: string; term?: string; academic_year?: string }) => {
    const qs = new URLSearchParams();
    if (params?.class_name) qs.set('class_name', params.class_name);
    if (params?.section) qs.set('section', params.section);
    if (params?.term) qs.set('term', params.term);
    if (params?.academic_year) qs.set('academic_year', params.academic_year);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return request<FeeRecord[]>(`/api/fees${query}`, { method: 'GET' }, token);
  },

  updatePayment: (
    token: string,
    studentId: string,
    payload: {
      term: string;
      academic_year: string;
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
    term: string; date: string; questions: TestQuestion[];
  }) =>
    request<Test>('/api/tests', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, token),

  remove: (token: string, id: string) =>
    request<null>(`/api/tests/${id}`, { method: 'DELETE' }, token),
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
  phone?: string;
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
      parent_phone?: string;
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
      parent_phone?: string;
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
