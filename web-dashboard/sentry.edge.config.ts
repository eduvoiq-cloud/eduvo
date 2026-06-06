// sentry.edge.config.ts
// Sentry initialisation for the Edge runtime (middleware, edge API routes).
// Loaded via instrumentation.ts when NEXT_RUNTIME === 'edge'.
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  sendDefaultPii: true,

  // 100% of traces in dev, 10% in production
  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,

  enableLogs: true,
});
