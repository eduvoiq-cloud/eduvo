# Eduvo — School Management Platform

A full-stack school management system built with:

- **Backend**: Node.js + Express + TypeScript + Supabase
- **Web Dashboard**: Next.js 16 + TypeScript + Tailwind CSS v4
- **Database**: Supabase (PostgreSQL + Auth)

---

## Project Structure

```
eduvo/
├── backend-api/          Express REST API
│   ├── src/
│   │   ├── index.ts      Entry point — registers all routes
│   │   ├── config/
│   │   │   └── supabase.ts   Public + admin Supabase clients
│   │   ├── middleware/
│   │   │   ├── auth.ts       JWT verification → role from users table
│   │   │   ├── roles.ts      requireRole() / requireAtLeast() guards
│   │   │   └── rateLimit.ts  Global + auth-specific rate limits
│   │   ├── routes/
│   │   │   ├── auth.ts       Login, logout, /me, create user, parent invite
│   │   │   ├── schools.ts    CRUD schools
│   │   │   ├── users.ts      List/delete users by role + school
│   │   │   ├── students.ts   CRUD students
│   │   │   ├── assignments.ts Teacher → class/section/subject assignments
│   │   │   ├── attendance.ts  Record + bulk + RFID-check endpoint
│   │   │   ├── marks.ts      Record + update marks
│   │   │   ├── fees.ts       List + toggle fee paid/unpaid per student
│   │   │   ├── tests.ts      Create MCQ+theory tests, list, delete
│   │   │   ├── complaints.ts Submit + update status
│   │   │   ├── notifications.ts Send + read notifications
│   │   │   └── settings.ts   School attendance cutoff + calendar settings
│   │   └── utils/
│   │       └── response.ts   sendSuccess / sendError / sendValidationError
│   └── supabase-schema.sql   ← Run this in Supabase SQL editor first
│
└── web-dashboard/        Next.js App Router dashboard
    ├── lib/
    │   ├── api.ts        Typed API client (all calls → backend only)
    │   └── session.ts    localStorage + cookie session helpers
    ├── context/
    │   └── AuthContext.tsx  Global auth state + login/logout
    ├── proxy.ts          Edge proxy — auth guard + role redirects (Next.js 16)
    ├── components/
    │   ├── Navbar.tsx    Role-aware navigation + logout
    │   ├── Modal.tsx     Reusable modal (Escape + backdrop close)
    │   ├── FormField.tsx Label + error wrapper + inputClass export
    │   ├── StatCard.tsx  Dashboard stat card
    │   └── PageHeader.tsx Title + description + action slot
    └── app/
        ├── login/        Login page
        └── (dashboards)/
            ├── superadmin/
            │   ├── dashboard/  Stats + schools table + audit log preview
            │   ├── audit-logs/ Full paginated audit log with filters
            │   ├── schools/    Add school, toggle subscription, add admin
            │   └── users/      All users across schools, create, remove
            ├── admin/
            │   ├── dashboard/  Stats + recent students
            │   ├── teachers/   Add teacher, assign class/section/subject, remove
            │   ├── students/   Add student (photo, parent link), remove
            │   ├── attendance/ View attendance for any class/date (read-only)
            │   ├── announcements/ Send to teachers/parents/custom
            │   ├── export/     Download all school data as ZIP
            │   └── settings/   Attendance cutoff, timezone, term, year
            └── teacher/
                ├── dashboard/  Assigned classes + quick actions
                ├── marks/      Enter marks: class→section→student→subject→score
                ├── attendance/ Manual attendance with RFID-already-marked detection
                ├── fees/       Toggle paid/unpaid per student per term
                ├── tests/      Create MCQ+theory tests, view, delete
                └── complaints/ View parent complaints, update status
```

---

## Setup

### 1. Database

Run `backend-api/supabase-schema.sql` in your Supabase project's SQL editor.
This creates all tables, enables RLS (deny-all for direct client access), and adds indexes.

> **Existing installs:** If you already ran the base schema, run `backend-api/supabase-migrations.sql` to add the columns and tables added since the initial release.

### 2. Backend

```bash
cd backend-api
npm install
npm run dev            # starts on port 3001
```

**Required `.env` variables:**
```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
PORT=3001
```

**Optional `.env` variables (for FCM push notifications):**
```
FIREBASE_PROJECT_ID=<your-firebase-project-id>
FIREBASE_CLIENT_EMAIL=<service-account-email>
FIREBASE_PRIVATE_KEY=<private-key-with-newlines-as-\n>
SENTRY_DSN=<sentry-dsn>
SUBSCRIPTION_PRICE=50
```

> Without Firebase credentials the server starts normally — push notifications are silently skipped.

### 3. Web Dashboard

```bash
cd web-dashboard
cp .env.local.example .env.local
npm install
npm run dev            # starts on port 3000
```

**Required `.env.local` variables:**
```
NEXT_PUBLIC_API_URL=http://localhost:3001
```

---

## Role System

| Role | Access |
|---|---|
| `superadmin` | Full platform — all schools, all users |
| `schooladmin` | Their school only — teachers, students, settings |
| `teacher` | Their assigned classes only — marks, attendance, fees, tests |
| `parent` | Their children's data only (mobile app) |
| `student` | Their own data only (mobile app) |

**Security rules:**
- Role is read from the `users` table on every request — never from the JWT
- `schooladmin` is always scoped to their `school_id` in every query
- `teacher` is always scoped to their `teacher_assignments` rows
- All mutations are logged to `audit_logs` with `user_id` + action + details

---

## API Endpoints

### Auth
| Method | Path | Roles | Description |
|---|---|---|---|
| POST | `/api/auth/login/staff` | Public | Email + password login (staff) |
| POST | `/api/auth/login/student` | Public | Phone + password login (student/parent) |
| POST | `/api/auth/logout` | Any | Invalidate session |
| GET | `/api/auth/me` | Any | Current user profile |
| POST | `/api/auth/refresh` | Public | Exchange refresh token for new access token |
| POST | `/api/auth/staff/change-password` | Staff | Change own password (clears must_reset_password) |
| POST | `/api/auth/staff/forgot-password` | Public | Send password-reset email |
| POST | `/api/auth/staff/reset-password` | Public | Set new password via reset token |
| POST | `/api/auth/student/change-password` | Student | Student changes own password |
| POST | `/api/auth/student/reset-password` | schooladmin | Admin resets student to default password |

### Schools
| Method | Path | Roles |
|---|---|---|
| GET | `/api/schools` | superadmin |
| POST | `/api/schools` | superadmin |
| PATCH | `/api/schools/:id` | superadmin |
| DELETE | `/api/schools/:id` | superadmin |

### Users
| Method | Path | Roles |
|---|---|---|
| GET | `/api/users?role=&school_id=` | superadmin, schooladmin |
| DELETE | `/api/users/:id` | superadmin, schooladmin |

### Students
| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/api/students?class_name=&section=` | superadmin, schooladmin, teacher | Teachers **must** pass class_name + section; verified against their assignments |
| POST | `/api/students` | superadmin, schooladmin, teacher | |
| PATCH | `/api/students/:id` | superadmin, schooladmin, teacher | |
| DELETE | `/api/students/:id` | superadmin, schooladmin | Soft-delete |

### Assignments
| Method | Path | Roles |
|---|---|---|
| GET | `/api/assignments?school_id=` | superadmin, schooladmin, teacher |
| POST | `/api/assignments` | superadmin, schooladmin |
| DELETE | `/api/assignments/:id` | superadmin, schooladmin |

### Attendance
| Method | Path | Roles |
|---|---|---|
| GET | `/api/attendance?student_id=&date=&from=&to=` | superadmin, schooladmin, teacher, parent |
| GET | `/api/attendance/check?class_name=&section=&date=` | superadmin, schooladmin, teacher |
| POST | `/api/attendance` | superadmin, schooladmin, teacher |
| POST | `/api/attendance/bulk` | superadmin, schooladmin, teacher |

### Marks
| Method | Path | Roles |
|---|---|---|
| GET | `/api/marks?student_id=&subject=&term=` | All roles (scoped) |
| POST | `/api/marks` | superadmin, schooladmin, teacher |
| PATCH | `/api/marks/:id` | superadmin, schooladmin, teacher |

### Fees
| Method | Path | Roles |
|---|---|---|
| GET | `/api/fees?class_name=&section=&term=&academic_year=` | superadmin, schooladmin, teacher |
| POST | `/api/fees/:student_id/toggle` | superadmin, schooladmin, teacher |

### Tests
| Method | Path | Roles |
|---|---|---|
| GET | `/api/tests?class_name=&section=&subject=&term=` | superadmin, schooladmin, teacher, student |
| GET | `/api/tests/:id` | superadmin, schooladmin, teacher, student |
| POST | `/api/tests` | superadmin, schooladmin, teacher |
| DELETE | `/api/tests/:id` | superadmin, schooladmin, teacher |

### Notifications
| Method | Path | Roles |
|---|---|---|
| GET | `/api/notifications` | Any |
| POST | `/api/notifications` | superadmin, schooladmin, teacher |
| PATCH | `/api/notifications/:id/read` | Any |

### Complaints
| Method | Path | Roles |
|---|---|---|
| GET | `/api/complaints?status=` | superadmin, schooladmin, teacher, parent |
| POST | `/api/complaints` | parent, schooladmin, superadmin |
| PATCH | `/api/complaints/:id/status` | superadmin, schooladmin, teacher |

### Settings
| Method | Path | Roles |
|---|---|---|
| GET | `/api/settings` | superadmin, schooladmin, teacher |
| PUT | `/api/settings` | superadmin, schooladmin |

### Superadmin
| Method | Path | Roles |
|---|---|---|
| GET | `/api/superadmin/schools` | superadmin |
| POST | `/api/superadmin/schools` | superadmin |
| PUT | `/api/superadmin/schools/:id/subscription` | superadmin |
| POST | `/api/superadmin/schools/:id/admin` | superadmin |
| GET | `/api/superadmin/stats` | superadmin |
| GET | `/api/superadmin/audit-logs` | superadmin |
| GET | `/api/superadmin/export/:school_id` | superadmin |

### Admin (School Admin)
| Method | Path | Roles |
|---|---|---|
| GET | `/api/admin/students` | schooladmin |
| POST | `/api/admin/students` | schooladmin |
| PUT | `/api/admin/students/:id` | schooladmin |
| DELETE | `/api/admin/students/:id` | schooladmin |
| POST | `/api/admin/students/restore/:id` | schooladmin |
| PUT | `/api/admin/students/:id/rfid` | schooladmin |
| GET | `/api/admin/audit-logs` | schooladmin |
| GET | `/api/admin/export` | schooladmin |

### Gate (Public)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/schools/list` | Returns id + name only. Rate-limited 30 req/min. |
| GET | `/api/health` | Health check |
| GET | `/api/api/health` | Alias for gate page compat |

---

## Supabase Tables

| Table | Purpose |
|---|---|
| `users` | User profiles + roles (mirrors auth.users) |
| `schools` | School records + subscription status |
| `school_settings` | Per-school config (cutoff time, timezone, term) |
| `students` | Student records with RFID, roll number, soft-delete |
| `teacher_assignments` | Teacher → class/section/subject mappings |
| `attendance` | Daily attendance with source (manual/rfid) |
| `marks` | Student scores per subject/term/exam_type |
| `student_fees` | Fee paid status per student/term/year |
| `tests` | Test headers (title, class, subject, date) |
| `test_questions` | MCQ + theory questions linked to tests |
| `notifications` | Fan-out notification rows per recipient |
| `notification_queue` | Delayed FCM push queue (30 min after RFID scan) |
| `complaints` | Parent complaints with status tracking |
| `invites` | One-time tokens for parent self-registration |
| `parent_students` | Junction: parent ↔ multiple students |
| `subjects` | School subject catalogue |
| `announcements` | School-wide announcements |
| `audit_logs` | Immutable log of all mutations |
