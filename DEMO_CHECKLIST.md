# Eduvo Demo Checklist

## Goal

Use this checklist before a presentation to reduce the chance of avoidable issues.

This document does not change application behavior. It is only a presentation-prep guide.

## Before the demo

### Environment

- confirm backend environment variables are present
- confirm web environment variables are present
- confirm the mobile app points to the correct API base URL
- confirm demo accounts are valid and passwords are known

### Data

- verify at least one `superadmin` account works
- verify at least one `schooladmin` account works
- verify at least one `teacher` account works
- verify at least one `student` account works
- verify the demo school has realistic sample students, marks, attendance, and notifications

### Build and startup

- start `backend-api` and verify the health endpoint responds
- start `web-dashboard` and verify login loads cleanly
- start `mobile-app` and verify the main dashboard opens
- confirm there are no blocking console or terminal errors during startup

## Suggested demo flow

### Opening

1. show the project structure briefly
2. explain that Eduvo has one backend with web and mobile clients
3. mention role-based access and school-scoped data separation

### Web dashboard flow

1. login as `schooladmin` or `teacher`
2. show dashboard and role-based navigation
3. open students, attendance, marks, and notifications
4. show one operational workflow end to end

Good choices:

- teacher marks entry
- attendance workflow
- test creation and review
- school admin student management

### Mobile flow

1. login as `student`
2. show dashboard
3. open marks, homework, notifications, or timetable
4. if parent flows are ready, show one parent-specific screen

### Closing points

- one backend powers multiple clients
- role rules are enforced server-side
- audit logging and production-readiness work are already in place
- the project is structured to scale feature coverage over time

## Backup plan

If live editing or mutation feels risky during the presentation:

- use existing demo data instead of creating new records
- prefer read-heavy flows over write-heavy flows
- keep a teacher account and a student account already logged in if possible
- keep one fallback browser tab on a stable page such as dashboard or students list

## Last-minute verification

Run or confirm:

```bash
cd backend-api
npm test

cd ../web-dashboard
npm run lint

cd ../mobile-app
npx tsc --noEmit
```

## Avoid right before presenting

- dependency upgrades
- auth refactors
- schema changes
- route contract changes
- deleting demo data
- renaming environment files
