// instrumentation.ts
// Next.js server-side initialisation hook.
// Dispatches to the correct Sentry config based on the runtime.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

// Automatically captures all unhandled server-side request errors.
// Requires @sentry/nextjs >= 8.28.0
export { captureRequestError as onRequestError } from '@sentry/nextjs';
