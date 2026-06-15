import express from 'express';
import authRoutes from '../../routes/auth';

/** Minimal Express app mounting only auth routes — no server startup side effects. */
export function createAuthTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  return app;
}
