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

import { execSync } from 'child_process';
import * as net from 'net';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import * as Sentry from '@sentry/node';

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Sentry.init as (options: Record<string, unknown>) => void)({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV ?? 'development',
      tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
    });
    console.log('[sentry] Error tracking enabled');
  } else {
    console.warn('[sentry] SENTRY_DSN not set — error tracking disabled');
  }

  const app = express();

  // ── Resolve port: prefer env var, then 3001 → 3002 → 3003 ──────────────────
  const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : null;
  const portCandidates = envPort ? [envPort] : [3001, 3002, 3003];
  const PORT = await resolvePort(portCandidates);

  // ── Security headers ────────────────────────────────────────────────────────
  app.use(helmet());

  // ── CORS ────────────────────────────────────────────────────────────────────
  // Allowed origins are read from CORS_ORIGINS env var (comma-separated).
  // Falls back to localhost in development so the server is usable without config.
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
    : [
        'http://localhost:3000',
        'http://localhost:3001',
        'https://hoppscotch.io',
        'chrome-extension://amknoiejhlmhancpahfcfcfhllgkpbld',
      ];

  const isDev = (process.env.NODE_ENV ?? 'development') !== 'production';

  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, Postman)
        if (!origin) return callback(null, true);

        // Exact match against the configured allow-list
        if (allowedOrigins.includes(origin)) return callback(null, true);

        // Dev-only: allow any localhost port (http or https)
        if (isDev && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
          return callback(null, true);
        }

        // Dev-only: allow browser extension origins (e.g. chrome-extension://, moz-extension://)
        if (isDev && /^(chrome-extension|moz-extension|ms-browser-extension):\/\//.test(origin)) {
          return callback(null, true);
        }

        callback(new Error(`CORS: origin '${origin}' not allowed`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );

  // ── Body parsing ─────────────────────────────────────────────────────────────
  app.use(express.json());

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

  // ── Health check ─────────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });
  // Alias for gate page compatibility
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ── 404 handler ──────────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ success: false, message: 'Route not found' });
  });

  // ── Global error handler (must be last, after all routes) ────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (process.env.SENTRY_DSN) {
      Sentry.captureException(err);
    }

    console.error('[error]', err.message, err.stack);

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
