# Contributing to Eduvo

## Principles

When making changes to Eduvo, optimize for:

- keeping production behavior stable
- preserving API contracts
- maintaining school and role isolation
- making the smallest safe change first

## Repository layout

- `backend-api`: business rules, auth, data access, integrations
- `web-dashboard`: staff-facing dashboard
- `mobile-app`: student and parent-facing app

Read `ARCHITECTURE.md` before making structural changes.

## Local workflow

### Backend

```bash
cd backend-api
npm install
npm run dev
```

### Web

```bash
cd web-dashboard
npm install
npm run dev
```

### Mobile

```bash
cd mobile-app
npm install
npm start
```

## Change policy

### Safe changes

These are usually low-risk:

- documentation updates
- tests
- `.gitignore` and repo hygiene
- isolated UI text fixes
- narrowly scoped validation improvements

### Changes that require extra care

These should be treated as higher risk:

- auth middleware
- token handling
- route response shapes
- school-scoping logic
- teacher-assignment checks
- session persistence
- database schema changes

## Coding guidelines

- Prefer small, reviewable commits
- Keep request validation explicit
- Do not trust role or school context from the client when it can be derived server-side
- Reuse existing response helpers where possible
- Avoid introducing new global patterns without applying them consistently

## Testing expectations

Before opening or merging meaningful changes:

```bash
cd backend-api
npm test

cd ../web-dashboard
npm run lint
npm run build

cd ../mobile-app
npx tsc --noEmit
```

For backend behavior changes, add or update tests when practical.

## Documentation expectations

Update docs when changing:

- auth behavior
- environment variables
- route contracts
- operational steps
- architecture assumptions

Relevant docs:

- `README.md`
- `ARCHITECTURE.md`
- `TESTING_STRATEGY.md`
- `RESTORE_RUNBOOK.md`
- `PRODUCTION_AUDIT_REPORT.md`

## Demo-safe rule

If a presentation, release, or important customer demo is near:

1. prefer no-risk changes first
2. avoid cross-cutting refactors
3. avoid dependency upgrades unless necessary
4. verify all three surfaces before stopping
