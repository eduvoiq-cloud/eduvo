import 'dotenv/config';

// ── Process-level crash handlers (registered before any imports that can throw) ──
// These catch errors that escape try/catch, e.g. a throw inside a module import.
process.on('uncaughtException', (err: Error) => {
  console.error('[fatal] Uncaught exception — server will exit:', err.message);
  console.error(err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[fatal] Unhandled promise rejection — server will exit:', reason);
  process.exit(1);
});

// ── Startup environment variable validation ───────────────────────────────────
// Fail fast if critical env vars are missing before any network connections.
const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'JWT_SECRET',
] as const;

const missingVars = REQUIRED_ENV_VARS.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
  console.error(
    `[fatal] Missing required environment variables: ${missingVars.join(', ')}\n` +
    'Set them in Railway (production) or .env (local) and restart the server.'
  );
  process.exit(1);
}

import { execSync } from 'child_process';
import * as net from 'net';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import * as Sentry from '@sentry/node';
import type { NodeOptions } from '@sentry/node';

import { globalRateLimit } from './middleware/rateLimit';
import authRoutes from './routes/auth';
import schoolRoutes from './routes/schools';
import studentRoutes from './routes/students';
import attendanceRoutes from './routes/attendance';
import marksRoutes from './routes/marks';
import notificationRoutes from './routes/notifications';
import userRoutes from './routes/users';
import settingsRoutes from './routes/settings';
import assignmentRoutes from './routes/assignments';
import feeRoutes from './routes/fees';
import testRoutes from './routes/tests';
import complaintRoutes from './routes/complaints';
import teacherRoutes from './routes/teacher';
import adminRoutes from './routes/admin';
import superadminRoutes from './routes/superadmin';
import parentRoutes from './routes/parent';
import performanceRoutes from './routes/performance';
import bulkImportRoutes from './routes/bulkImport';
import onboardingRoutes from './routes/onboarding';
import aiAssistantRoutes from './routes/aiAssistant';
import timetableRoutes from './routes/timetable';
import homeworkRoutes from './routes/homework';
import marksViewRoutes from './routes/marksView';
import announcementRoutes from './routes/announcements';
import premiumRoutes from './routes/premium';
import dailyTestsRoutes from './routes/dailyTests';
import activityPacksRoutes from './routes/activityPacks';
import studentProgressRoutes from './routes/studentProgress';
import weeklyAnalysisRoutes from './routes/weeklyAnalysis';
import cronNotificationRoutes from './routes/cronNotifications';
import cronHomeworkRoutes from './routes/cronHomework';

// ── Port utilities ────────────────────────────────────────────────────────────

/**
 * Returns true if something is already listening on `port`.
 */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once('error', (err: NodeJS.ErrnoException) => {
        resolve(err.code === 'EADDRINUSE');
      })
      .once('listening', () => {
        tester.close(() => resolve(false));
      })
      .listen(port, '0.0.0.0');
  });
}

/**
 * Attempts to kill whatever process is bound to `port`.
 * Works on Windows (netstat + taskkill) and Unix (lsof / fuser).
 * Failures are swallowed — the caller will detect the port is still busy.
 */
function killProcessOnPort(port: number): void {
  try {
    if (process.platform === 'win32') {
      // Find the PID listening on the port, then kill it
      const output = execSync(
        `netstat -ano | findstr :${port}`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const lines = output.trim().split('\n');
      const pids = new Set<string>();
      for (const line of lines) {
        // Only match lines where the local address ends with :<port>
        if (new RegExp(`[:\\s]${port}\\s`).test(line)) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
        }
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /F`, { stdio: 'pipe' });
          console.log(`[port] Killed PID ${pid} that was using port ${port}`);
        } catch {
          // Process may have already exited
        }
      }
    } else {
      // Unix: try fuser first, fall back to lsof
      try {
        execSync(`fuser -k ${port}/tcp`, { stdio: 'pipe' });
        console.log(`[port] Killed process using port ${port} via fuser`);
      } catch {
        const output = execSync(`lsof -ti tcp:${port}`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const pids = output.trim().split('\n').filter(Boolean);
        for (const pid of pids) {
          try {
            execSync(`kill -9 ${pid}`, { stdio: 'pipe' });
            console.log(`[port] Killed PID ${pid} that was using port ${port}`);
          } catch {
            // Already gone
          }
        }
      }
    }
  } catch {
    // netstat / lsof not available or port wasn't in use — ignore
  }
}

/**
 * Resolves to the first available port from the candidate list.
 * Before checking, tries to free the preferred port (first in the list).
 * Throws if none of the candidates are available.
 */
async function resolvePort(candidates: number[]): Promise<number> {
  const preferred = candidates[0];

  // Always attempt to free the preferred port first
  if (await isPortInUse(preferred)) {
    console.warn(`[port] Port ${preferred} is in use — attempting to free it…`);
    killProcessOnPort(preferred);
    // Give the OS a moment to release the socket
    await new Promise((r) => setTimeout(r, 500));
  }

  for (const port of candidates) {
    if (!(await isPortInUse(port))) {
      return port;
    }
    console.warn(`[port] Port ${port} still busy — trying next…`);
  }

  throw new Error(
    `All candidate ports are in use: ${candidates.join(', ')}. ` +
      'Free one of them and restart the server.'
  );
}

// ── Server factory ────────────────────────────────────────────────────────────

async function startServer() {
  // ── Sentry initialisation (must happen before app is created) ───────────────
  if (process.env.SENTRY_DSN) {
    const sentryOptions: NodeOptions = {
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV ?? 'development',
      // 100% of traces in dev, 10% in production to keep quota sensible
      tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
      // Attach local variable values to stack frames for richer debugging
      includeLocalVariables: true,
      // Enable structured logging via Sentry.logger.*
      enableLogs: true,
      // Capture request metadata (headers, IP) — safe for internal API
      sendDefaultPii: true,
    };
    Sentry.init(sentryOptions);
    console.log('[sentry] Error tracking enabled');
  } else {
    console.warn('[sentry] SENTRY_DSN not set — error tracking disabled');
  }

  const app = express();

  // ── Trust Railway/Vercel reverse proxy for correct IP in rate limiters ──────
  // Without this, req.ip is always the proxy's IP — rate limits would apply to
  // all users equally instead of per-client.
  app.set('trust proxy', 1);

  // ── Resolve port: prefer env var, then 3001 → 3002 → 3003 ──────────────────
  const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : null;
  const portCandidates = envPort ? [envPort] : [3001, 3002, 3003];
  const PORT = await resolvePort(portCandidates);

  // ── Security headers ────────────────────────────────────────────────────────
  app.use(helmet());

  // ── CORS ────────────────────────────────────────────────────────────────────
  // Allowed origins are read from CORS_ORIGINS env var (comma-separated).
  // Falls back to localhost in development so the server is usable without config.
  // In production (NODE_ENV=production) CORS_ORIGINS MUST be set — no fallback.
  const isDev = (process.env.NODE_ENV ?? 'development') !== 'production';

  let allowedOrigins: string[];
  if (process.env.CORS_ORIGINS) {
    allowedOrigins = process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  } else if (isDev) {
    allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:3001',
    ];
    console.warn('[cors] CORS_ORIGINS not set — allowing localhost only (dev mode)');
  } else {
    // Production with no CORS_ORIGINS: refuse all cross-origin requests
    allowedOrigins = [];
    console.error('[cors] CORS_ORIGINS is not set in production! Cross-origin requests will be blocked.');
  }

  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, Postman, server-to-server)
        if (!origin) return callback(null, true);

        // Exact match against the configured allow-list
        if (allowedOrigins.includes(origin)) return callback(null, true);

        // Dev-only: allow any localhost port (http or https)
        if (isDev && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
          return callback(null, true);
        }

        callback(new Error(`CORS: origin '${origin}' not allowed`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-School-ID'],
    })
  );

  // ── Body parsing ─────────────────────────────────────────────────────────────
  // 10MB limit: activity pack generation accepts base64-encoded images/PDFs
  // which inflate ~33% over raw file size; a 6MB PDF becomes ~8MB in base64.
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // ── Global rate limit (applies to every route) ───────────────────────────────
  app.use(globalRateLimit);

  // ── Routes ───────────────────────────────────────────────────────────────────
  app.use('/api/auth', authRoutes);
  app.use('/api/schools', schoolRoutes);
  app.use('/api/students', studentRoutes);
  app.use('/api/attendance', attendanceRoutes);
  app.use('/api/marks', marksRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/assignments', assignmentRoutes);
  app.use('/api/fees', feeRoutes);
  app.use('/api/tests', testRoutes);
  app.use('/api/complaints', complaintRoutes);
  app.use('/api/teacher', teacherRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/superadmin', superadminRoutes);
  app.use('/api/parent', parentRoutes);
  app.use('/api/performance', performanceRoutes);
  app.use('/api/import', bulkImportRoutes);
  app.use('/api/onboarding', onboardingRoutes);
  app.use('/api/ai', aiAssistantRoutes);
  app.use('/api/timetable', timetableRoutes);
  app.use('/api/homework', homeworkRoutes);
  app.use('/api/marks-view', marksViewRoutes);
  app.use('/api/announcements', announcementRoutes);
  app.use('/api/premium', premiumRoutes);
  app.use('/api/daily-tests', dailyTestsRoutes);
  app.use('/api/activity-packs', activityPacksRoutes);
  app.use('/api/student-progress', studentProgressRoutes);
  app.use('/api/weekly-analysis', weeklyAnalysisRoutes);
  app.use('/api/cron/notifications', cronNotificationRoutes);
  app.use('/api/cron/homework', cronHomeworkRoutes);

  // ── Health check ─────────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });
  // Alias for gate page compatibility
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ── Sentry Express error handler (must come after all routes, before 404) ───
  // This captures 5xx errors automatically — no need to call captureException
  // manually in the error handler below.
  if (process.env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app);
  }

  // ── 404 handler ──────────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ success: false, message: 'Route not found' });
  });

  // ── Global error handler (must be last, after all routes) ────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    // Sentry already captured the error via setupExpressErrorHandler above;
    // manual capture is kept as a safety net when Sentry is not configured.
    if (!process.env.SENTRY_DSN) {
      console.error('[error]', err.message, err.stack);
    }

    const message =
      process.env.NODE_ENV === 'production'
        ? 'An unexpected error occurred'
        : err.message;

    res.status(500).json({ success: false, message });
  });

  // ── Start listening ───────────────────────────────────────────────────────────
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(PORT, () => {
      console.log(`[server] Eduvo API running on port ${PORT}`);
      resolve();
    });

    // Catch any unexpected bind error that slips past resolvePort()
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${PORT} is already in use even after attempting to free it. ` +
              'Try restarting your terminal or running the server on a different port.'
          )
        );
      } else {
        reject(err);
      }
    });
  });

  return app;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
// Wrapped in try/catch so any throw during startup is printed clearly.
startServer().catch((err: Error) => {
  console.error('[fatal] Startup failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});

export default startServer;
