/**
 * /api/teacher-library — Teacher personal textbook/resource library
 *
 * All routes require staff JWT + teacher role.
 *
 *   GET    /api/teacher-library/units          — list distinct units the teacher has uploaded files for
 *   GET    /api/teacher-library/files          — list files for a specific unit
 *   POST   /api/teacher-library/upload         — upload a file to Supabase Storage + insert DB row
 *   DELETE /api/teacher-library/files/:fileId  — delete a file (storage + DB)
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError } from '../utils/response';

const router = Router();

// ── Constants ─────────────────────────────────────────────────────────────────

const STORAGE_BUCKET = 'teacher-library';
const MAX_FILE_SIZE  = 10 * 1024 * 1024; // 10 MB

// ── Multer: memory storage, 10 MB, PDF + JPEG + PNG only ─────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['application/pdf', 'image/jpeg', 'image/png']);
    if (allowed.has(file.mimetype.toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, JPEG, and PNG files are allowed.'));
    }
  },
});

// ── Apply auth + role to every route in this router ──────────────────────────

router.use(authenticate, requireRole('teacher'));

// ── GET /api/teacher-library/units ───────────────────────────────────────────
/**
 * Returns distinct units the authenticated teacher has uploaded files for.
 *
 * Query params:
 *   class_name  — required
 *   subject     — required
 *
 * Response: { units: [{ unit_number: number, file_count: number }] }
 */
router.get('/units', async (req: Request, res: Response) => {
  try {
  const teacherId = req.user!.id;
  const { class_name, subject } = req.query as Record<string, string | undefined>;

  if (!class_name || !subject) {
    sendError(res, 'class_name and subject query params are required', 400);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('teacher_library_files')
    .select('unit_number')
    .eq('teacher_id', teacherId)
    .ilike('class_name', class_name.trim())
    .ilike('subject', subject.trim());

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  // Aggregate counts client-side (avoids RPC / raw SQL)
  const countMap = new Map<number, number>();
  for (const row of data ?? []) {
    const unit = (row as Record<string, unknown>).unit_number as number;
    countMap.set(unit, (countMap.get(unit) ?? 0) + 1);
  }

  const units = Array.from(countMap.entries())
    .map(([unit_number, file_count]) => ({ unit_number, file_count }))
    .sort((a, b) => a.unit_number - b.unit_number);

  sendSuccess(res, { units });
  } catch (err: unknown) {
    return sendError(res, 'An unexpected error occurred', 500);
  }
});

// ── GET /api/teacher-library/files ───────────────────────────────────────────
router.get('/files', async (req: Request, res: Response) => {
  try {
  const teacherId = req.user!.id;
  const { class_name, subject, unit_number } = req.query as Record<string, string | undefined>;

  if (!class_name || !subject || !unit_number) {
    sendError(res, 'class_name, subject, and unit_number query params are required', 400);
    return;
  }

  const unitNum = parseInt(unit_number, 10);
  if (isNaN(unitNum) || unitNum < 1) {
    sendError(res, 'unit_number must be a positive integer', 400);
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('teacher_library_files')
    .select('id, file_name, file_url, created_at')
    .eq('teacher_id', teacherId)
    .ilike('class_name', class_name.trim())
    .ilike('subject', subject.trim())
    .eq('unit_number', unitNum)
    .order('created_at', { ascending: false });

  if (error) {
    sendError(res, error.message, 500);
    return;
  }

  sendSuccess(res, { files: data ?? [] });
  } catch (err: unknown) {
    return sendError(res, 'An unexpected error occurred', 500);
  }
});

// ── POST /api/teacher-library/upload ─────────────────────────────────────────
/**
 * Upload a single file to Supabase Storage and insert a DB record.
 *
 * Multipart form fields:
 *   class_name   — required
 *   section      — required
 *   subject      — required
 *   unit_number  — required, positive integer
 *   file         — required, PDF/JPEG/PNG, max 10 MB
 *
 * Storage path:
 *   {school_id}/{teacher_id}/{class_name}/{subject}/unit-{unit_number}/{timestamp}-{filename}
 *
 * Response: { file: { id, file_name, file_url, created_at } }
 */
router.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
  try {
  const file = req.file;
  if (!file) {
    sendError(res, 'No file provided', 400);
    return;
  }

  const { class_name, section, subject, unit_number } = req.body as Record<string, string | undefined>;

  if (!class_name || !section || !subject || !unit_number) {
    sendError(res, 'class_name, section, subject, and unit_number are required', 400);
    return;
  }

  const unitNum = parseInt(unit_number, 10);
  if (isNaN(unitNum) || unitNum < 1) {
    sendError(res, 'unit_number must be a positive integer', 400);
    return;
  }

  const teacherId = req.user!.id;
  const schoolId  = req.user!.school_id ?? 'global';

  // Build storage path
  const timestamp      = Date.now();
  const safeName       = file.originalname
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 100);
  const safeClassName  = class_name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeSubject    = subject.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${schoolId}/${teacherId}/${safeClassName}/${safeSubject}/unit-${unitNum}/${timestamp}-${safeName}`;

  // Upload to Supabase Storage
  const { error: uploadErr } = await supabaseAdmin
    .storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });

  if (uploadErr) {
    sendError(res, `Failed to upload file: ${uploadErr.message}`, 500);
    return;
  }

  // Get public URL
  const { data: publicUrlData } = supabaseAdmin
    .storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(storagePath);

  const fileUrl = publicUrlData.publicUrl;

  // Insert DB record
  const { data: record, error: insertErr } = await supabaseAdmin
    .from('teacher_library_files')
    .insert({
      teacher_id:  teacherId,
      school_id:   schoolId,
      class_name:  class_name.trim(),
      section:     section.trim(),
      subject:     subject.trim(),
      unit_number: unitNum,
      file_name:   file.originalname,
      file_url:    fileUrl,
      file_path:   storagePath,
    })
    .select('id, file_name, file_url, created_at')
    .single();

  if (insertErr || !record) {
    // Best-effort: remove the orphaned file from storage
    await supabaseAdmin.storage.from(STORAGE_BUCKET).remove([storagePath]);
    sendError(res, insertErr?.message ?? 'Failed to save file record', 500);
    return;
  }

  sendSuccess(res, { file: record }, 'File uploaded successfully', 201);
  } catch (err: unknown) {
    return sendError(res, 'An unexpected error occurred', 500);
  }
});

// ── DELETE /api/teacher-library/files/:fileId ─────────────────────────────────
/**
 * Delete a file from Supabase Storage and remove the DB record.
 * Verifies that file.teacher_id === req.user.id before proceeding.
 *
 * Response: { success: true }
 */
router.delete('/files/:fileId', async (req: Request, res: Response) => {
  try {
  const { fileId } = req.params;
  const teacherId  = req.user!.id;

  // Fetch the record and verify ownership
  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from('teacher_library_files')
    .select('id, teacher_id, file_path')
    .eq('id', fileId)
    .maybeSingle();

  if (fetchErr || !existing) {
    sendError(res, 'File not found', 404);
    return;
  }

  const record = existing as Record<string, unknown>;

  if (record.teacher_id !== teacherId) {
    sendError(res, 'You can only delete your own files', 403);
    return;
  }

  // Delete from Supabase Storage (best-effort — proceed even on error)
  const filePath = record.file_path as string | null;
  if (filePath) {
    const { error: storageErr } = await supabaseAdmin
      .storage
      .from(STORAGE_BUCKET)
      .remove([filePath]);

    if (storageErr) {
      console.warn(`[teacher-library] Storage removal failed for file ${fileId}:`, storageErr.message);
    }
  }

  // Delete DB record
  const { error: deleteErr } = await supabaseAdmin
    .from('teacher_library_files')
    .delete()
    .eq('id', fileId);

  if (deleteErr) {
    sendError(res, deleteErr.message, 500);
    return;
  }

  sendSuccess(res, { success: true }, 'File deleted successfully');
  } catch (err: unknown) {
    return sendError(res, 'An unexpected error occurred', 500);
  }
});

export default router;
