// instrumentation-client.ts
// Sentry initialisation for the browser / client runtime.
// Next.js loads this file automatically for client-side bundles.
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Include user IP, cookies, and request headers in error events
  sendDefaultPii: true,

  // 100% of traces in dev, 10% in production
  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,

  // Session Replay: always record sessions that contain errors;
  // sample 10% of all other sessions
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,

  // Enable structured logging via Sentry.logger.*
  enableLogs: true,

  integrations: [
    Sentry.replayIntegration(),
  ],
});

// Hook into App Router navigation transitions so they appear as spans in Sentry
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
