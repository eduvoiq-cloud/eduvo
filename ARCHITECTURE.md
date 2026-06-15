# Eduvo Architecture Overview

## Purpose

Eduvo is a multi-surface school management platform with a shared backend and two client applications:

- `backend-api` provides the system of record and all business operations
- `web-dashboard` serves staff workflows for superadmin, school admin, and teacher roles
- `mobile-app` serves student and parent-facing experiences

The project is intentionally backend-centric. Client applications do not own business rules; they call the API and render role-specific flows.

## High-level design

```text
Web dashboard (Next.js) ─┐
                         ├──> Express API (TypeScript) ───> Supabase Postgres/Auth/Storage
Mobile app (Expo) ───────┘
```

Key design choices:

- All application data access flows through `backend-api`
- The web app does not query Supabase tables directly
- Student-facing mobile flows use API endpoints rather than direct DB access
- Supabase Auth is used for staff authentication
- Custom JWTs are used for student authentication

## Application boundaries

### Backend

`backend-api` owns:

- authentication and session verification
- role and school scoping
- validation and business rules
- audit logging
- integrations such as Firebase, Gemini, SMS, and email
- database reads/writes through Supabase clients

Important backend areas:

- `src/index.ts`: server boot, middleware, route registration
- `src/middleware`: auth, role guards, rate limits
- `src/routes`: API surface grouped by feature
- `src/services`: heavier business logic and third-party integrations
- `src/utils`: shared helpers

### Web dashboard

`web-dashboard` owns:

- staff login and session restoration
- dashboard navigation and role-aware UI
- API consumption through `lib/api.ts`
- route protection and session redirect logic

Important frontend areas:

- `app/`: App Router pages
- `context/AuthContext.tsx`: auth lifecycle and token refresh
- `lib/api.ts`: typed API wrappers and shared request handling
- `components/`: reusable UI primitives

### Mobile app

`mobile-app` owns:

- student and parent login flows
- token persistence using secure storage
- dashboard and classroom experience screens
- device integrations such as notifications and camera/file flows

Important mobile areas:

- `src/screens/`: user-facing screens
- `src/store/`: auth and child state
- `src/api/client.ts`: transport layer
- `src/utils/notifications.ts`: push-notification setup

## Auth model

Eduvo currently uses two authentication paths:

### Staff users

- login uses Supabase Auth
- API verifies the presented token with `supabase.auth.getUser(...)`
- role and school access are loaded from the `users` table, not trusted from JWT claims

### Student users

- login validates credentials against the `students` table
- API signs a custom JWT with `JWT_SECRET`
- API loads current student data from the database on authenticated requests

This split is practical for the current product shape, but it means auth behavior must remain consistent across both flows.

## Authorization model

Authorization is enforced in the backend, not in the clients.

Core rules:

- `superadmin` can manage platform-wide resources
- `schooladmin` is scoped to one school, with optional medium-switch access
- `teacher` is scoped to assigned classes and sections
- `student` is scoped to their own records
- data access is checked server-side on each request

The security model relies on:

- route-level middleware
- school-aware queries
- assignment verification for teacher operations
- audit logging for mutating actions

## Data model

The main operational entities are:

- `schools`
- `users`
- `students`
- `teacher_assignments`
- `attendance`
- `marks`
- `student_fees`
- `tests` and `test_questions`
- `notifications`
- `complaints`
- `announcements`
- `audit_logs`

Supabase RLS is intentionally deny-all for application tables, with the backend using the service role key to perform controlled access.

## Operational flow

Typical request lifecycle:

1. client sends token to `backend-api`
2. backend validates token and loads the current actor
3. middleware applies role and school checks
4. route validates request input
5. route and service logic perform DB operations
6. mutations are audit logged when required
7. normalized API response is returned to the client

## Current strengths

- clear separation between API and clients
- strong role-aware product design
- production-focused concerns already present: rate limits, audit logs, health checks, Sentry, CI
- one shared backend reduces duplicated business logic across web and mobile

## Known scaling pressure points

These are the main architectural areas likely to need refactoring next:

- `backend-api/src/index.ts` is large and central
- `backend-api/src/middleware/auth.ts` carries repeated policy logic
- `web-dashboard/lib/api.ts` combines transport, types, and many feature modules in one file
- route handlers still carry a meaningful amount of business logic that would benefit from clearer service/repository boundaries

## Safe next steps

Post-presentation, the safest high-impact refactors would be:

1. extract shared auth-policy helpers from middleware
2. split large API client modules by domain
3. increase test coverage for non-auth business flows
4. move more database/business logic out of route handlers
