# Eduvo Testing Strategy

## Goal

Keep the app stable while the product grows across backend, web, and mobile surfaces.

This document focuses on pragmatic testing that matches the current repository structure and release risk.

## Current automated checks

The project already has a useful baseline:

- `backend-api`: Jest integration tests
- `web-dashboard`: ESLint
- `mobile-app`: TypeScript type-check
- GitHub Actions CI in `.github/workflows/ci.yml`

Current commands:

```bash
# backend
cd backend-api
npm test
npx tsc --noEmit

# web
cd web-dashboard
npm run lint
npm run build

# mobile
cd mobile-app
npx tsc --noEmit
```

## What each layer should protect

### Backend

Backend tests should be treated as the primary safety net because the backend owns:

- auth
- authorization
- school scoping
- business rules
- audit logging
- most integration behavior

Priority backend coverage:

1. auth and session lifecycle
2. school and role scoping
3. student CRUD and restoration
4. attendance workflows
5. marks and marks-view
6. fees and reminders
7. tests and test attempts
8. premium activation and renewal

Recommended test split:

- integration tests for route behavior
- unit tests only for isolated helpers or service logic with high branch complexity

### Web dashboard

The web app should focus on:

- auth redirect behavior
- session restoration
- critical forms and tables
- role-based page access
- API error handling for `401` and `402`

Useful test types:

- a few component tests for shared primitives
- targeted integration tests for auth context and route guards
- smoke coverage for the highest-traffic dashboard pages

### Mobile app

The mobile app should focus on:

- auth store behavior
- secure storage persistence
- API error handling and forced logout
- the most visible student and parent screens

Useful test types:

- state-store tests
- screen-level smoke tests for login and dashboard flows
- notification setup tests where logic is isolated enough to mock

## Recommended risk levels

### P0: must not break

- login
- logout
- token refresh
- role access checks
- school scoping
- student visibility rules
- teacher assignment enforcement

### P1: important product workflows

- attendance entry and correction
- marks creation and viewing
- fees management
- tests creation and review
- notifications and announcements

### P2: supporting workflows

- onboarding
- exports
- premium reporting
- analytics and weekly summaries

## Test design guidelines

- Prefer testing public behavior over internal implementation
- Mock Supabase and external APIs at integration boundaries, not everywhere
- Keep fixtures small and readable
- Use one test file per feature area once coverage expands
- Avoid brittle UI snapshot tests unless they protect a very stable component

## Release checks before demos or production pushes

Before a presentation or release, run:

```bash
cd backend-api
npm test

cd ../web-dashboard
npm run lint
npm run build

cd ../mobile-app
npx tsc --noEmit
```

Also verify manually:

1. staff login
2. student login
3. one teacher flow
4. one school-admin flow
5. one mobile dashboard flow

## Safe expansion plan

The next test additions should be low-risk and high-value:

1. add backend integration tests for `students`, `attendance`, and `fees`
2. add a small web auth-context test suite
3. add mobile auth-store tests
4. add CI reporting for test coverage once coverage is broad enough to enforce

## What not to do right before a demo

Avoid these changes unless there is time for a full regression pass:

- auth refactors
- route restructuring across multiple files
- API contract changes
- type-tightening that touches many endpoints at once
- dependency upgrades across all three apps
