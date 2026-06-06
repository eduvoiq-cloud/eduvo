// sentry.server.config.ts
// Sentry initialisation for the Node.js server runtime.
// Loaded via instrumentation.ts when NEXT_RUNTIME === 'nodejs'.
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  sendDefaultPii: true,

  // 100% of traces in dev, 10% in production
  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,

  // Attach local variable values to stack frames for richer debugging
  includeLocalVariables: true,

  // Enable structured logging via Sentry.logger.*
  enableLogs: true,
});
