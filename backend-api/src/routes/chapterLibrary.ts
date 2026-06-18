/**
 * GET /api/chapter-library/subjects
 * GET /api/chapter-library/chapters
 *
 * Read-only endpoints for the chapter library.
 * Requires authenticated user (any role that has a valid JWT).
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { sendSuccess, sendError, sendValidationError } from '../utils/response';

const router = Router();

// All routes require an authenticated user
router.use(authenticate);

// ── GET /api/chapter-library/subjects ────────────────────────────────────────
/**
 * Returns a sorted, distinct list of subjects for a given board + class.
 *
 * Query params:
 *   board  (string, required)  — e.g. "CBSE" or "GSEB"
 *   class  (number, required)  — 1 to 12
 */
router.get('/subjects', async (req: Request, res: Response) => {
  const schema = z.object({
    board: z.string().min(1),
    class: z.coerce.number().int().min(1).max(12),
  });

  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { board, class: classNum } = parsed.data;

  const { data, error } = await supabaseAdmin
    .from('chapter_library')
    .select('subject')
    .eq('board', board)
    .eq('class', classNum)
    .order('subject', { ascending: true });

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  // Deduplicate (Supabase doesn't have a DISTINCT shorthand in the JS client)
  const subjects = [...new Set((data ?? []).map((r: { subject: string }) => r.subject))].sort();

  sendSuccess(res, { subjects });
});

// ── GET /api/chapter-library/chapters ────────────────────────────────────────
/**
 * Returns chapters for a given board + class + subject, ordered by chapter_number.
 *
 * Query params:
 *   board    (string, required)
 *   class    (number, required)
 *   subject  (string, required)
 */
router.get('/chapters', async (req: Request, res: Response) => {
  const schema = z.object({
    board: z.string().min(1),
    class: z.coerce.number().int().min(1).max(12),
    subject: z.string().min(1),
  });

  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.flatten());
    return;
  }

  const { board, class: classNum, subject } = parsed.data;

  const { data, error } = await supabaseAdmin
    .from('chapter_library')
    .select('id, chapter_number, chapter_name, topics')
    .eq('board', board)
    .eq('class', classNum)
    .eq('subject', subject)
    .order('chapter_number', { ascending: true });

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, { chapters: data ?? [] });
});

export default router;
