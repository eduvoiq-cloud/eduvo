/**
 * Typed API client for student-facing endpoints.
 * Uses the same BASE_URL as the main api.ts but sends student JWT tokens
 * and the X-Token-Type: student header required by authenticateStudent middleware.
 */

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StudentLoginResponse {
  token: string;
  student: {
    id: string;
    name: string;
    phone_number: string;
    class_name: string | null;
    section: string | null;
    school_id: string;
    is_first_login: boolean;
  };
}

export interface TestRecord {
  id: string;
  title: string;
  subject_id: string;
  subject: string | null;
  date: string;
  term: string | null;
  time_limit_minutes: number;
  available_from: string | null;
  available_until: string | null;
  question_count: number;
  attempt_status: 'not_started' | 'in_progress' | 'completed';
  is_restricted: boolean;
  mcq_score: number | null;
  total_score: number | null;
  max_score: number | null;
  total_score_pending: boolean;
  integrity_score: number | null;
  integrity_exit_count: number | null;
  integrity_exit_duration_seconds: number | null;
  require_camera?: boolean;
  allow_web_attempt?: boolean;
}

export interface Question {
  id: string;
  order_index: number;
  question_text: string;
  question_type: 'mcq' | 'theory';
  option_a: string | null;
  option_b: string | null;
  option_c: string | null;
  option_d: string | null;
  marks: number;
}

export interface AttemptStartResponse {
  attempt_id: string;
  time_limit_minutes: number;
  started_at: string;
  seconds_remaining: number | null;
  resumed: boolean;
  questions: Question[];
}

export interface ResultAnswer {
  question_id: string;
  question_text: string;
  question_type: 'mcq' | 'theory';
  option_a?: string | null;
  option_b?: string | null;
  option_c?: string | null;
  option_d?: string | null;
  selected_option?: string | null;
  correct_option?: string | null;
  is_correct?: boolean | null;
  marks: number;
  marks_awarded: number | 'pending' | null;
  theory_answer?: string | null;
  explanation?: string | null;
  reasoning?: string | null;
}

export interface AttemptResultResponse {
  attempt_id: string;
  test_id: string;
  started_at: string;
  submitted_at: string;
  mcq_score: number | null;
  total_score: number | null;
  total_score_pending: boolean;
  answers: ResultAnswer[];
}

export interface WebIntegrityPayload {
  tab_exit_count: number;
  total_exit_duration_seconds: number;
  longest_exit_seconds: number;
  fullscreen_exit_count: number;
  face_absent_count: number;
  face_absent_duration_seconds: number;
  multiple_faces_count: number;
}

interface ApiResponse<T> {
  success: boolean;
  message: string;
  data: T;
}

// ── Core fetch wrapper ────────────────────────────────────────────────────────

async function studentRequest<T>(
  path: string,
  options: RequestInit = {},
  token?: string
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Token-Type': 'student',
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  const json = await res.json();

  if (!res.ok) {
    throw new Error(
      (json as { message?: string }).message ?? `Request failed with status ${res.status}`
    );
  }

  return json as ApiResponse<T>;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export const studentAuthApi = {
  /**
   * Student login — uses email for the web portal.
   * Backend uses phone_number as primary, but many setups allow email.
   * We send the email value in the phone_number field since the backend
   * student login accepts any unique identifier stored there.
   */
  login: (phoneOrEmail: string, password: string) =>
    studentRequest<StudentLoginResponse>('/api/auth/login/student', {
      method: 'POST',
      body: JSON.stringify({ phone_number: phoneOrEmail, password }),
    }),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

export const studentTestsApi = {
  list: (token: string) =>
    studentRequest<TestRecord[]>('/api/tests/student', { method: 'GET' }, token),

  startAttempt: (token: string, testId: string, platform: 'mobile' | 'web' = 'web') =>
    studentRequest<AttemptStartResponse>('/api/tests/attempt/start', {
      method: 'POST',
      body: JSON.stringify({ test_id: testId, platform }),
    }, token),

  submitAttempt: (
    token: string,
    payload: {
      attempt_id: string;
      answers: Array<{
        question_id: string;
        selected_option?: string;
        theory_answer?: string;
      }>;
      integrity: WebIntegrityPayload;
    }
  ) =>
    studentRequest<{ mcq_score: number; total_mcq_marks: number }>('/api/tests/attempt/submit', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, token),

  getResultsByTest: (token: string, testId: string) =>
    studentRequest<AttemptResultResponse>(`/api/tests/results/by-test/${testId}`, { method: 'GET' }, token),
};
