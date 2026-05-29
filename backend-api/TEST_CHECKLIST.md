# Eduvo API — Manual Test Checklist

Base URL: `http://localhost:3001`

All protected endpoints require:
```
Authorization: Bearer <access_token>
Content-Type: application/json
```

---

## 🔐 Auth — `/api/auth`

| # | Method | URL | What it does | Request Body | Expected Response |
|---|--------|-----|--------------|--------------|-------------------|
| 1 | `POST` | `/api/auth/login` | Authenticates user, returns JWT + profile | `{ "email": "user@example.com", "password": "secret" }` | `200` `{ token, refresh_token, expires_at, user: { id, name, email, role, school_id } }` |
| 2 | `POST` | `/api/auth/logout` | Invalidates current session | _(none)_ | `200` `{ message: "Logged out successfully" }` |
| 3 | `GET` | `/api/auth/me` | Returns authenticated user's profile | _(none)_ | `200` `{ id, name, email, role, school_id }` |
| 4 | `POST` | `/api/auth/users` | Admin creates a new user account | `{ "email": "new@school.com", "password": "pass1234", "name": "Jane Doe", "role": "teacher", "school_id": "<uuid>" }` | `201` `{ id, name, email, role, school_id }` |
| 5 | `POST` | `/api/auth/register-parent` | Parent self-registers via invite token | `{ "email": "parent@example.com", "password": "pass1234", "name": "John Parent", "invite_token": "<token>" }` | `201` `{ id, name, email, role, school_id }` |

**Role access:** Login is public. Logout/me require any auth. Create user requires `superadmin` or `schooladmin`. Register-parent is public (invite-gated).

---

## 🏫 Schools — `/api/schools`

| # | Method | URL | What it does | Request Body | Expected Response |
|---|--------|-----|--------------|--------------|-------------------|
| 6 | `GET` | `/api/schools` | List all schools | _(none)_ | `200` `[{ id, name, address, phone, email, created_at }]` |
| 7 | `GET` | `/api/schools/:id` | Get a single school | _(none)_ | `200` `{ id, name, address, phone, email, ... }` |
| 8 | `POST` | `/api/schools` | Create a new school | `{ "name": "Greenwood High", "address": "123 Main St", "phone": "0800123456", "email": "info@greenwood.edu" }` | `201` `{ id, name, address, ... }` |
| 9 | `PATCH` | `/api/schools/:id` | Update school details | `{ "name": "Greenwood Academy" }` | `200` `{ id, name, ... }` |
| 10 | `DELETE` | `/api/schools/:id` | Delete a school | _(none)_ | `200` `{ message: "School deleted" }` |

**Role access:** GET list = `superadmin`. GET single = `superadmin`, `schooladmin`, `teacher`. POST/PATCH/DELETE = `superadmin` only.

---

## 👥 Users — `/api/users`

| # | Method | URL | What it does | Request Body | Expected Response |
|---|--------|-----|--------------|--------------|-------------------|
| 11 | `GET` | `/api/users` | List users (filter by `?role=&school_id=`) | _(none)_ | `200` `[{ id, name, email, role, school_id, created_at }]` |
| 12 | `GET` | `/api/users/:id` | Get a single user | _(none)_ | `200` `{ id, name, email, role, school_id, created_at }` |
| 13 | `PATCH` | `/api/users/:id` | Update user name or email | `{ "name": "Updated Name" }` | `200` `{ id, name, email, role, school_id }` |
| 14 | `DELETE` | `/api/users/:id` | Delete user profile + auth account | _(none)_ | `200` `{ message: "User deleted" }` |

**Role access:** All require `superadmin` or `schooladmin`. `schooladmin` is scoped to their own school.

---

## 🎓 Students — `/api/students`

| # | Method | URL | What it does | Request Body | Expected Response |
|---|--------|-----|--------------|--------------|-------------------|
| 15 | `GET` | `/api/students` | List students (filter by `?school_id=`) | _(none)_ | `200` `[{ id, full_name, class_name, section, date_of_birth, ... }]` |
| 16 | `GET` | `/api/students/:id` | Get a single student | _(none)_ | `200` `{ id, full_name, class_name, ... }` |
| 17 | `POST` | `/api/students` | Create a student record | `{ "full_name": "Alice Smith", "date_of_birth": "2010-05-15", "school_id": "<uuid>", "class_name": "Grade 5", "section": "A", "parent_id": "<uuid>" }` | `201` `{ id, full_name, ... }` |
| 18 | `PATCH` | `/api/students/:id` | Update student details | `{ "class_name": "Grade 6" }` | `200` `{ id, full_name, class_name, ... }` |
| 19 | `DELETE` | `/api/students/:id` | Delete a student record | _(none)_ | `200` `{ message: "Student deleted" }` |

**Role access:** GET list/POST/PATCH = `superadmin`, `schooladmin`, `teacher`. GET single also allows `parent` (own children only). DELETE = `superadmin`, `schooladmin` only.

---

## 📋 Attendance — `/api/attendance`

| # | Method | URL | What it does | Request Body | Expected Response |
|---|--------|-----|--------------|--------------|-------------------|
| 20 | `GET` | `/api/attendance` | List attendance (filter by `?student_id=&date=&from=&to=`) | _(none)_ | `200` `[{ id, student_id, date, status, source, students: { full_name } }]` |
| 21 | `GET` | `/api/attendance/check` | Check existing attendance for a class on a date (`?class_name=&section=&date=`) | _(none)_ | `200` `{ students: [...], existing: [{ student_id, status, source }] }` |
| 22 | `POST` | `/api/attendance` | Record single attendance | `{ "student_id": "<uuid>", "date": "2026-05-27", "status": "present", "notes": "On time" }` | `201` `{ id, student_id, date, status, ... }` |
| 23 | `POST` | `/api/attendance/bulk` | Record attendance for multiple students at once | `{ "records": [{ "student_id": "<uuid>", "date": "2026-05-27", "status": "present" }] }` | `201` `[{ id, student_id, date, status }]` |

**Role access:** GET = `superadmin`, `schooladmin`, `teacher`, `parent` (parents see own children only). POST/bulk = `superadmin`, `schooladmin`, `teacher`.

---

## 📝 Marks — `/api/marks`

| # | Method | URL | What it does | Request Body | Expected Response |
|---|--------|-----|--------------|--------------|-------------------|
| 24 | `GET` | `/api/marks` | List marks (filter by `?student_id=&subject=&term=`) | _(none)_ | `200` `[{ id, student_id, subject, score, max_score, term, exam_type, students: { full_name } }]` |
| 25 | `POST` | `/api/marks` | Record a mark | `{ "student_id": "<uuid>", "subject": "Math", "score": 85, "max_score": 100, "term": "term_1", "exam_type": "midterm" }` | `201` `{ id, student_id, subject, score, ... }` |
| 26 | `PATCH` | `/api/marks/:id` | Update a mark | `{ "score": 90 }` | `200` `{ id, score, ... }` |
| 27 | `DELETE` | `/api/marks/:id` | Delete a mark | _(none)_ | `200` `{ message: "Mark deleted" }` |

**Role access:** GET = all roles (students/parents see own data only). POST/PATCH = `superadmin`, `schooladmin`, `teacher`. DELETE = `superadmin`, `schooladmin` only.

Valid `exam_type` values: `quiz`, `midterm`, `final`, `assignment`, `project`.

---

## 📚 Teacher Assignments — `/api/assignments`

| # | Method | URL | What it does | Request Body | Expected Response |
|---|--------|-----|--------------|--------------|-------------------|
| 28 | `GET` | `/api/assignments` | List teacher-class assignments (filter by `?school_id=&teacher_id=`) | _(none)_ | `200` `[{ id, teacher_id, school_id, class_name, section, subject }]` |
| 29 | `POST` | `/api/assignments` | Assign a teacher to a class/subject | `{ "teacher_id": "<uuid>", "school_id": "<uuid>", "class_name": "Grade 5", "section": "A", "subject": "Math" }` | `201` `{ id, teacher_id, class_name, section, subject }` |
| 30 | `DELETE` | `/api/assignments/:id` | Remove a teacher assignment | _(none)_ | `200` `{ message: "Assignment removed" }` |

**Role access:** GET = `superadmin`, `schooladmin`, `teacher` (teachers see own assignments only). POST/DELETE = `superadmin`, `schooladmin` only.

---

## 💰 Fees — `/api/fees`

| # | Method | URL | What it does | Request Body | Expected Response |
|---|--------|-----|--------------|--------------|-------------------|
| 31 | `GET` | `/api/fees` | List fee status for students (filter by `?class_name=&section=&term=&academic_year=`) | _(none)_ | `200` `[{ student_id, full_name, class_name, section, fee_paid, fee_record }]` |
| 32 | `POST` | `/api/fees/:student_id/toggle` | Mark student fee as paid or unpaid | `{ "fee_paid": true, "term": "term_1", "academic_year": "2025-2026", "notes": "Paid via bank" }` | `200` `{ student_id, fee_paid, term, academic_year, ... }` |

**Role access:** Both = `superadmin`, `schooladmin`, `teacher`.

---

## 📣 Complaints — `/api/complaints`

| # | Method | URL | What it does | Request Body | Expected Response |
|---|--------|-----|--------------|--------------|-------------------|
| 33 | `GET` | `/api/complaints` | List complaints (filter by `?status=`) | _(none)_ | `200` `[{ id, subject, body, status, submitted_by, users: { name, email } }]` |
| 34 | `POST` | `/api/complaints` | Submit a complaint | `{ "subject": "Bullying issue", "body": "My child was bullied...", "student_id": "<uuid>" }` | `201` `{ id, subject, body, status: "pending", ... }` |
| 35 | `PATCH` | `/api/complaints/:id/status` | Update complaint status | `{ "status": "resolved", "resolution_note": "Issue addressed with teacher." }` | `200` `{ id, status, resolution_note, reviewed_by, reviewed_at }` |

**Role access:** GET = `superadmin`, `schooladmin`, `teacher`, `parent` (parents see own only). POST = `parent`, `schooladmin`, `superadmin`. PATCH status = `superadmin`, `schooladmin`, `teacher`.

Valid `status` values: `pending`, `reviewed`, `resolved`.

---

## 🔔 Notifications — `/api/notifications`

| # | Method | URL | What it does | Request Body | Expected Response |
|---|--------|-----|--------------|--------------|-------------------|
| 36 | `GET` | `/api/notifications` | Get all notifications for the logged-in user | _(none)_ | `200` `[{ id, title, body, type, is_read, created_at }]` |
| 37 | `POST` | `/api/notifications` | Send notification to one or more users | `{ "title": "Exam Tomorrow", "body": "Math exam at 9am", "recipient_ids": ["<uuid>"], "type": "reminder" }` | `201` `[{ id, title, body, recipient_id, ... }]` |
| 38 | `PATCH` | `/api/notifications/:id/read` | Mark a notification as read | _(none)_ | `200` `{ id, is_read: true, read_at }` |
| 39 | `DELETE` | `/api/notifications/:id` | Delete a notification | _(none)_ | `200` `{ message: "Notification deleted" }` |

**Role access:** GET/PATCH read = any authenticated user (own notifications only). POST = `superadmin`, `schooladmin`, `teacher`. DELETE = `superadmin`, `schooladmin` only.

Valid `type` values: `announcement`, `alert`, `reminder`, `grade`, `attendance`.

---

## ⚙️ Settings — `/api/settings`

| # | Method | URL | What it does | Request Body | Expected Response |
|---|--------|-----|--------------|--------------|-------------------|
| 40 | `GET` | `/api/settings` | Get school settings for the current user's school | _(none)_ | `200` `{ school_id, attendance_cutoff_time, timezone, term_name, academic_year }` |
| 41 | `PUT` | `/api/settings` | Upsert school settings | `{ "attendance_cutoff_time": "08:30", "timezone": "Africa/Nairobi", "term_name": "Term 1", "academic_year": "2025-2026" }` | `200` `{ school_id, attendance_cutoff_time, timezone, ... }` |

**Role access:** GET = `superadmin`, `schooladmin`, `teacher`. PUT = `superadmin`, `schooladmin` only.

`attendance_cutoff_time` must be in `HH:MM` format.

---

## 🧑‍🏫 Teacher (Scoped) — `/api/teacher`

All routes in this group require role `teacher`.

| # | Method | URL | What it does | Request Body | Expected Response |
|---|--------|-----|--------------|--------------|-------------------|
| 42 | `GET` | `/api/teacher/my-classes` | Get all class/section/subject assignments for the logged-in teacher | _(none)_ | `200` `[{ id, teacher_id, class_name, section, subject }]` |
| 43 | `GET` | `/api/teacher/students` | Get students for a class (`?class=Grade5&section=A`) | _(none)_ | `200` `[{ id, full_name, class_name, section, ... }]` |
| 44 | `POST` | `/api/teacher/marks` | Record a mark (validates teacher is assigned to subject) | `{ "student_id": "<uuid>", "subject": "Math", "test_name": "Quiz 1", "exam_type": "unit_test", "term": "term_1", "score": 18, "max_score": 20 }` | `201` `{ id, student_id, subject, score, ... }` |
| 45 | `PUT` | `/api/teacher/marks/:id` | Update an existing mark | `{ "score": 19 }` | `200` `{ id, score, ... }` |
| 46 | `POST` | `/api/teacher/fee` | Toggle fee paid/unpaid for a student | `{ "student_id": "<uuid>", "fee_paid": true }` | `200` `{ student_id, fee_paid, ... }` |
| 47 | `GET` | `/api/teacher/complaints` | List complaints for teacher's school (filter by `?status=`) | _(none)_ | `200` `[{ id, subject, body, status, ... }]` |
| 48 | `PUT` | `/api/teacher/complaints/:id` | Update complaint status | `{ "status": "resolved", "resolution_note": "Handled." }` | `200` `{ id, status, resolution_note, ... }` |
| 49 | `POST` | `/api/teacher/attendance/manual` | Bulk manual attendance (skips already-marked students) | `{ "attendances": [{ "student_id": "<uuid>", "status": "present" }], "class": "Grade 5", "section": "A", "date": "2026-05-27" }` | `200` `{ saved: 25, skipped: ["<uuid>"] }` |
| 50 | `PUT` | `/api/teacher/attendance/correct` | Correct an existing attendance record | `{ "attendance_id": "<uuid>", "new_status": "excused", "reason": "Doctor's note provided" }` | `200` `{ id, student_id, date, status, ... }` |

Valid `exam_type` for teacher marks: `unit_test`, `mid_term`, `final`, `class_test`.
Valid `term` values: `term_1`, `term_2`, `term_3`.

---

## 📝 Tests — `/api/tests`

| # | Method | URL | What it does | Request Body | Expected Response |
|---|--------|-----|--------------|--------------|-------------------|
| 51 | `POST` | `/api/tests/create` | Teacher creates a test with questions | `{ "title": "Math Quiz 1", "subject_id": "<uuid>", "class": "Grade 5", "section": "A", "term": "term_1", "date": "2026-06-01", "time_limit_minutes": 30, "shuffle_questions": false, "shuffle_options": false, "questions": [{ "question_text": "What is 2+2?", "question_type": "mcq", "option_a": "3", "option_b": "4", "option_c": "5", "option_d": "6", "correct_option": "b", "marks": 2 }] }` | `201` `{ test_id, success: true }` |
| 52 | `GET` | `/api/tests/my-tests` | Teacher lists their tests (filter by `?class=&section=&term=`) | _(none)_ | `200` `[{ id, title, class_name, section, term, date, question_count }]` |
| 53 | `GET` | `/api/tests/student` | Student gets available tests for their class (fee-gated) | _(none)_ | `200` `[{ id, title, date, time_limit_minutes, question_count }]` |
| 54 | `POST` | `/api/tests/attempt/start` | Student starts a test attempt | `{ "test_id": "<uuid>" }` | `200` `{ attempt_id, time_limit_minutes, started_at, questions: [...] }` |
| 55 | `POST` | `/api/tests/attempt/submit` | Student submits answers; MCQ auto-graded | `{ "attempt_id": "<uuid>", "answers": [{ "question_id": "<uuid>", "selected_option": "b" }] }` | `200` `{ mcq_score, total_mcq_marks }` |
| 56 | `POST` | `/api/tests/theory/mark` | Teacher marks theory answers for a submitted attempt | `{ "attempt_id": "<uuid>", "theory_marks": [{ "question_id": "<uuid>", "marks_awarded": 8 }] }` | `200` `{ attempt_id, total_score }` |
| 57 | `GET` | `/api/tests/results/:attempt_id` | Student views their results for a submitted attempt | _(none)_ | `200` `{ attempt_id, mcq_score, total_score, answers: [...] }` |

**Role access:** Create/my-tests/theory mark = `teacher`, `schooladmin`, `superadmin`. Student endpoints = `student` only.

> ⚠️ `correct_option` is **never** returned to students in any response.

---

## 🏥 Health Check

| # | Method | URL | What it does | Request Body | Expected Response |
|---|--------|-----|--------------|--------------|-------------------|
| 58 | `GET` | `/health` | Server health check (no auth required) | _(none)_ | `200` `{ status: "ok", timestamp: "..." }` |

---

## Common Error Responses

| Status | Meaning |
|--------|---------|
| `400` | Validation error or bad request |
| `401` | Missing or invalid token |
| `403` | Authenticated but not authorized for this action |
| `404` | Resource not found |
| `409` | Conflict (e.g. duplicate attempt) |
| `429` | Rate limit exceeded |
| `500` | Internal server error |

All error responses follow the shape: `{ "success": false, "message": "..." }`
All success responses follow the shape: `{ "success": true, "data": ..., "message": "..." }`
