import request from 'supertest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createAuthTestApp } from './helpers/testApp';
import { buildQueryChain } from './helpers/supabaseMock';

// ── Supabase mock handles ─────────────────────────────────────────────────────

const mockSignInWithPassword = jest.fn();
const mockGetUser = jest.fn();
const mockRefreshSession = jest.fn();
const mockFrom = jest.fn();
const mockAdminSignOut = jest.fn();

jest.mock('../config/supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: (...args: unknown[]) => mockSignInWithPassword(...args),
      getUser: (...args: unknown[]) => mockGetUser(...args),
      refreshSession: (...args: unknown[]) => mockRefreshSession(...args),
    },
  },
  supabaseAdmin: {
    from: (...args: unknown[]) => mockFrom(...args),
    auth: {
      admin: {
        updateUserById: jest.fn(),
        signOut: (...args: unknown[]) => mockAdminSignOut(...args),
      },
    },
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const STAFF_ID = '11111111-1111-1111-1111-111111111111';
const SCHOOL_ID = '22222222-2222-2222-2222-222222222222';
const STUDENT_ID = '33333333-3333-3333-3333-333333333333';

const staffProfile = {
  id: STAFF_ID,
  name: 'Test Teacher',
  email: 'teacher@eduvo.com',
  role: 'teacher',
  school_id: SCHOOL_ID,
  must_reset_password: false,
  phone: null,
};

const activeSchool = { subscription_status: true };

function signStudentToken(studentId = STUDENT_ID, schoolId = SCHOOL_ID): string {
  return jwt.sign(
    { type: 'student', sub: studentId, school_id: schoolId },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' }
  );
}

function mockFromTable(table: string, result: { data: unknown; error: unknown | null }) {
  mockFrom.mockImplementation((name: string) => {
    if (name === table) return buildQueryChain(result);
    return buildQueryChain({ data: null, error: null });
  });
}

function mockFromTables(map: Record<string, { data: unknown; error: unknown | null }>) {
  mockFrom.mockImplementation((name: string) => {
    const result = map[name] ?? { data: null, error: null };
    return buildQueryChain(result);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Auth integration (P0)', () => {
  const app = createAuthTestApp();

  beforeEach(() => {
    jest.clearAllMocks();
    mockFrom.mockReset();
    mockAdminSignOut.mockResolvedValue({ error: null });
  });

  // ── Staff login ───────────────────────────────────────────────────────────

  describe('POST /api/auth/login/staff', () => {
    it('returns 422 for invalid email', async () => {
      const res = await request(app)
        .post('/api/auth/login/staff')
        .send({ email: 'not-an-email', password: 'secret123' });

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Validation failed');
    });

    it('returns 401 for wrong credentials', async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: { session: null, user: null },
        error: { message: 'Invalid login credentials' },
      });

      const res = await request(app)
        .post('/api/auth/login/staff')
        .send({ email: 'teacher@eduvo.com', password: 'wrong' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Invalid email or password');
    });

    it('returns 403 when Supabase auth succeeds but profile is missing', async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: {
          user: { id: STAFF_ID },
          session: { access_token: 'staff-token', refresh_token: 'rt', expires_at: 9999 },
        },
        error: null,
      });
      mockFromTable('users', { data: null, error: { message: 'not found' } });

      const res = await request(app)
        .post('/api/auth/login/staff')
        .send({ email: 'teacher@eduvo.com', password: 'secret123' });

      expect(res.status).toBe(403);
      expect(res.body.message).toBe('Account not set up. Contact your administrator.');
    });

    it('returns 200 with token and user on successful login', async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: {
          user: { id: STAFF_ID },
          session: {
            access_token: 'staff-access-token',
            refresh_token: 'staff-refresh-token',
            expires_at: 9999999999,
          },
        },
        error: null,
      });
      mockFromTables({
        users: { data: staffProfile, error: null },
        schools: { data: activeSchool, error: null },
      });

      const res = await request(app)
        .post('/api/auth/login/staff')
        .send({ email: 'teacher@eduvo.com', password: 'secret123' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token).toBe('staff-access-token');
      expect(res.body.data.token_type).toBe('staff');
      expect(res.body.data.user).toMatchObject({
        id: STAFF_ID,
        email: 'teacher@eduvo.com',
        role: 'teacher',
        school_id: SCHOOL_ID,
      });
    });

    it('returns 402 when school subscription is expired', async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: {
          user: { id: STAFF_ID },
          session: { access_token: 't', refresh_token: 'r', expires_at: 1 },
        },
        error: null,
      });
      mockFromTables({
        users: { data: staffProfile, error: null },
        schools: { data: { subscription_status: false }, error: null },
      });

      const res = await request(app)
        .post('/api/auth/login/staff')
        .send({ email: 'teacher@eduvo.com', password: 'secret123' });

      expect(res.status).toBe(402);
      expect(res.body.message).toContain('subscription has expired');
    });
  });

  // ── Student login ─────────────────────────────────────────────────────────

  describe('POST /api/auth/login/student', () => {
    it('returns 422 for missing phone_number', async () => {
      const res = await request(app)
        .post('/api/auth/login/student')
        .send({ password: '12345' });

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 when student is not found', async () => {
      mockFromTable('students', { data: null, error: null });

      const res = await request(app)
        .post('/api/auth/login/student')
        .send({ phone_number: '9999999999', password: '12345' });

      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Invalid phone number or password');
    });

    it('returns 401 for wrong password', async () => {
      const hash = await bcrypt.hash('correctpass', 4);
      mockFromTable('students', {
        data: {
          id: STUDENT_ID,
          full_name: 'Test Student',
          phone_number: '9876543210',
          class_name: '10',
          section: 'A',
          school_id: SCHOOL_ID,
          password_hash: hash,
          is_first_login: false,
        },
        error: null,
      });

      const res = await request(app)
        .post('/api/auth/login/student')
        .send({ phone_number: '9876543210', password: 'wrongpass' });

      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Invalid phone number or password');
    });

    it('returns 200 with JWT on successful login', async () => {
      const password = '12345';
      const hash = await bcrypt.hash(password, 4);
      mockFromTables({
        students: {
          data: {
            id: STUDENT_ID,
            full_name: 'Test Student',
            phone_number: '9876543210',
            class_name: '10',
            section: 'A',
            school_id: SCHOOL_ID,
            password_hash: hash,
            is_first_login: true,
          },
          error: null,
        },
        schools: { data: activeSchool, error: null },
      });

      const res = await request(app)
        .post('/api/auth/login/student')
        .send({ phone_number: '9876543210', password });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token_type).toBe('student');
      expect(res.body.data.must_change_password).toBe(true);
      expect(res.body.data.student).toMatchObject({
        id: STUDENT_ID,
        name: 'Test Student',
        class: '10',
        section: 'A',
      });

      const decoded = jwt.verify(res.body.data.token, process.env.JWT_SECRET!) as {
        type: string;
        sub: string;
      };
      expect(decoded.type).toBe('student');
      expect(decoded.sub).toBe(STUDENT_ID);
    });
  });

  // ── Session restore (/me) ─────────────────────────────────────────────────

  describe('GET /api/auth/me', () => {
    it('returns 401 without Authorization header', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.message).toContain('Authorization');
    });

    it('returns 401 for invalid token', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'invalid' },
      });

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer not-a-valid-token');

      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Invalid or expired token');
    });

    it('returns student profile for valid student JWT', async () => {
      const token = signStudentToken();
      mockFromTables({
        students: {
          data: {
            id: STUDENT_ID,
            full_name: 'Test Student',
            phone_number: '9876543210',
            class_name: '10',
            section: 'A',
            school_id: SCHOOL_ID,
            is_first_login: false,
          },
          error: null,
        },
        schools: { data: activeSchool, error: null },
      });

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.token_type).toBe('student');
      expect(res.body.data.student).toMatchObject({
        id: STUDENT_ID,
        name: 'Test Student',
        class_name: '10',
        section: 'A',
        school_id: SCHOOL_ID,
      });
    });

    it('returns staff profile for valid Supabase token', async () => {
      mockGetUser.mockResolvedValue({
        data: { user: { id: STAFF_ID } },
        error: null,
      });
      mockFromTables({
        users: { data: staffProfile, error: null },
        schools: { data: activeSchool, error: null },
      });

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer supabase-staff-token');

      expect(res.status).toBe(200);
      expect(res.body.data.token_type).toBe('staff');
      expect(res.body.data.user).toMatchObject({
        id: STAFF_ID,
        email: 'teacher@eduvo.com',
        role: 'teacher',
      });
    });
  });

  // ── Logout ────────────────────────────────────────────────────────────────

  describe('POST /api/auth/logout', () => {
    it('returns 401 without token', async () => {
      const res = await request(app).post('/api/auth/logout');
      expect(res.status).toBe(401);
    });

    it('returns 200 for valid student logout', async () => {
      const token = signStudentToken();
      mockFromTables({
        students: {
          data: {
            id: STUDENT_ID,
            full_name: 'Test Student',
            phone_number: '9876543210',
            class_name: '10',
            section: 'A',
            school_id: SCHOOL_ID,
            is_first_login: false,
          },
          error: null,
        },
        schools: { data: activeSchool, error: null },
      });

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Logged out successfully');
    });
  });

  // ── Token refresh ─────────────────────────────────────────────────────────

  describe('POST /api/auth/refresh', () => {
    it('returns 422 when refresh_token is missing', async () => {
      const res = await request(app).post('/api/auth/refresh').send({});
      expect(res.status).toBe(422);
    });

    it('returns 401 for expired refresh token', async () => {
      mockRefreshSession.mockResolvedValue({
        data: { session: null },
        error: { message: 'expired' },
      });

      const res = await request(app)
        .post('/api/auth/refresh')
        .send({ refresh_token: 'expired-token' });

      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Session expired. Please log in again.');
    });

    it('returns new tokens on successful refresh', async () => {
      mockRefreshSession.mockResolvedValue({
        data: {
          session: {
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_at: 9999999999,
          },
        },
        error: null,
      });

      const res = await request(app)
        .post('/api/auth/refresh')
        .send({ refresh_token: 'valid-refresh' });

      expect(res.status).toBe(200);
      expect(res.body.data.token).toBe('new-access');
      expect(res.body.data.refresh_token).toBe('new-refresh');
    });
  });
});
