import { Router, Request, Response } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError } from '../utils/response';
import { templateDownloadRateLimit } from '../middleware/rateLimit';
import { sendSMS } from '../services/smsService';

// ── Marks import types ────────────────────────────────────────────────────────
interface MarksPreviewRow {
  roll_number: string;
  student_name: string;
  student_id: string;
  score: number | null;
  max_score: number;
  percentage: number | null;
  status: 'valid' | 'invalid' | 'will_update';
  errors: string[];
  existing_mark_id?: string; // set if a mark already exists for this student
}

interface CachedMarksPreview {
  rows: MarksPreviewRow[];
  school_id: string;
  teacher_id: string;
  type: 'marks';
  subject_name: string;
  subject_id: string;
  class_name: string;
  section: string;
  exam_type: string;
  term: string;
  test_name: string;
  date: string;
  expires_at: number;
}

const router = Router();

// ── All routes require authentication ────────────────────────────────────────
router.use(authenticate);

// ── In-memory session cache (TTL: 10 minutes) ─────────────────────────────────
interface CachedPreview {
  rows: PreviewRow[];
  school_id: string;
  type: 'students' | 'teachers';
  expires_at: number;
}
const previewCache = new Map<string, CachedPreview>();

// Separate cache for marks previews (different shape)
const marksPreviewCache = new Map<string, CachedMarksPreview>();

/** Purge expired sessions from the cache. */
function purgeExpiredSessions(): void {
  const now = Date.now();
  for (const [key, val] of previewCache.entries()) {
    if (val.expires_at < now) previewCache.delete(key);
  }
  for (const [key, val] of marksPreviewCache.entries()) {
    if (val.expires_at < now) marksPreviewCache.delete(key);
  }
}

// ── Rate limit: max 3 imports per hour per school ─────────────────────────────
const importRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  keyGenerator: (req) => req.user?.school_id ?? req.ip ?? 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: {
    success: false,
    message: 'Import limit reached. Maximum 3 imports per hour per school.',
  },
});

// ── Allowed MIME types for Excel uploads ──────────────────────────────────────
const ALLOWED_EXCEL_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
  'application/octet-stream', // some browsers send this for .xlsx
]);

// ── Multer config: 5MB max, mimetype + extension validation ───────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.toLowerCase();
    const mime = file.mimetype.toLowerCase();
    const extOk = ext.endsWith('.xlsx') || ext.endsWith('.xls');
    const mimeOk = ALLOWED_EXCEL_MIMES.has(mime);

    if (extOk && mimeOk) {
      cb(null, true);
    } else if (extOk && mime === 'application/octet-stream') {
      // Some clients send octet-stream for xlsx — allow if extension is correct
      cb(null, true);
    } else {
      cb(new Error('Only .xlsx and .xls files are allowed'));
    }
  },
});

// ── Audit logging helper ──────────────────────────────────────────────────────
async function logAudit(
  userId: string,
  action: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  try {
    await supabaseAdmin.from('audit_logs').insert({
      user_id: userId,
      action,
      table_name: 'bulk_import',
      details,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[audit] Failed to write audit log:', err);
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface PreviewRow {
  row_number: number;
  data: Record<string, unknown>;
  status: 'valid' | 'invalid' | 'duplicate';
  errors: string[];
}

interface PreviewResponse {
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  duplicate_rows: number;
  rows: PreviewRow[];
}

// ── Cell value helper ─────────────────────────────────────────────────────────
/**
 * ExcelJS can return cell values as objects (e.g. hyperlinked emails come back
 * as { text: 'user@example.com', hyperlink: 'mailto:...' }, rich-text cells as
 * { richText: [{text:'...'}] }, formulas as { result: '...' }, etc.).
 * This helper extracts a plain string in all those cases.
 */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Hyperlink cell: { text: '...', hyperlink: '...' }
    if (typeof obj['text'] === 'string') return obj['text'];
    // Rich-text cell: { richText: [{ text: '...' }] }
    if (Array.isArray(obj['richText'])) {
      return (obj['richText'] as Array<{ text?: string }>)
        .map((r) => r.text ?? '')
        .join('');
    }
    // Formula cell: { formula: '...', result: '...' }
    if (obj['result'] !== undefined) return cellToString(obj['result']);
  }
  return String(value);
}

// ── Validation helpers ────────────────────────────────────────────────────────
function validateStudentName(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'Student Name is required';
  if (name.length > 100) return 'Student Name must be max 100 characters';
  if (!/^[a-zA-Z\s]+$/.test(name)) return 'Student Name must not contain special characters';
  return null;
}

function validateRollNumber(roll: unknown): string | null {
  // Roll number is optional — skip validation if empty
  if (roll === undefined || roll === null || String(roll).trim() === '') return null;
  const str = String(roll).trim();
  if (!/^[a-zA-Z0-9]+$/.test(str)) return 'Roll Number must be alphanumeric only';
  return null;
}

function validateClass(cls: unknown): string | null {
  if (typeof cls !== 'string' && typeof cls !== 'number') return 'Class is required';
  const str = String(cls).trim();
  if (!str) return 'Class is required';
  return null;
}

function validateDivision(div: unknown): string | null {
  if (typeof div !== 'string') return 'Division is required';
  const str = div.trim().toUpperCase();
  if (!/^[A-Z]$/.test(str)) return 'Division must be a single letter A-Z';
  return null;
}

function validateParentName(name: unknown): string | null {
  if (!name || (typeof name === 'string' && !name.trim())) return null; // optional
  if (typeof name !== 'string') return null;
  if (name.length > 100) return 'Parent Name must be max 100 characters';
  return null;
}

function validateParentPhone(phone: unknown): string | null {
  if (!phone || (typeof phone === 'string' && !String(phone).trim())) return null; // optional
  const str = String(phone).trim();
  if (!/^\d{10}$/.test(str)) return 'Parent Phone must be exactly 10 digits';
  return null;
}

function validateParentEmail(email: unknown): string | null {
  if (!email) return null; // optional
  if (typeof email !== 'string') return 'Parent Email must be a valid email';
  const str = email.trim();
  if (!str) return null;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(str)) return 'Parent Email must be a valid email format';
  return null;
}

/**
 * Validate Parent Phone for the phone-login system.
 * Required, exactly 10 digits, numbers only.
 */
function validateLoginPhone(phone: unknown): string | null {
  if (!phone || (typeof phone === 'string' && !String(phone).trim())) {
    return 'Parent Phone is required (used as login phone number)';
  }
  const str = String(phone).trim();
  if (!/^\d{10}$/.test(str)) return 'Parent Phone must be exactly 10 digits (numbers only)';
  return null;
}

/**
 * Validate Date of Birth in DD/MM/YYYY format (optional).
 * If provided, checks student age is between 3 and 25 years.
 * Returns an error string or null if valid/empty.
 */
function validateDateOfBirth(dob: unknown): { error: string | null; parsed: string | null } {
  if (!dob || (typeof dob === 'string' && !String(dob).trim())) {
    return { error: null, parsed: null }; // Date of Birth is optional
  }

  const str = String(dob).trim();

  // Accept DD/MM/YYYY
  const match = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) {
    return { error: 'Date of Birth must be in DD/MM/YYYY format', parsed: null };
  }

  const day   = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const year  = parseInt(match[3], 10);

  // Basic range checks
  if (month < 1 || month > 12) return { error: 'Date of Birth has invalid month', parsed: null };
  if (day < 1 || day > 31)     return { error: 'Date of Birth has invalid day', parsed: null };

  const date = new Date(year, month - 1, day);
  // Verify the date didn't roll over (e.g. 31/02)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return { error: 'Date of Birth is not a valid calendar date', parsed: null };
  }

  // Age sanity check: student must be between 3 and 25 years old
  const today = new Date();
  let age = today.getFullYear() - year;
  const monthDiff = today.getMonth() - (month - 1);
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < day)) {
    age--;
  }

  if (age < 3)  return { error: 'Student must be at least 3 years old', parsed: null };
  if (age > 25) return { error: 'Student must be 25 years old or younger', parsed: null };

  // Return ISO format YYYY-MM-DD for DB storage
  const parsed = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { error: null, parsed };
}

function validateTeacherName(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'Teacher Name is required';
  if (name.length > 100) return 'Teacher Name must be max 100 characters';
  return null;
}

function validateTeacherPhone(phone: unknown): string | null {
  if (typeof phone !== 'string' && typeof phone !== 'number') return 'Phone Number is required';
  const str = String(phone).trim();
  if (!/^\d{10}$/.test(str)) return 'Phone Number must be exactly 10 digits';
  return null;
}

function validateTeacherEmail(email: unknown): string | null {
  if (typeof email !== 'string' || !email.trim()) return 'Email is required';
  const str = email.trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(str)) return 'Email must be a valid format';
  return null;
}

function validateSubject(subject: unknown): string | null {
  if (typeof subject !== 'string' || !subject.trim()) return 'Subject is required';
  return null;
}

function validateAssignedClasses(classes: unknown): string | null {
  if (typeof classes !== 'string' || !classes.trim()) return 'Assigned Classes is required';
  return null;
}

// ── GET /api/import/students/template ─────────────────────────────────────────
router.get('/students/template', requireRole('superadmin', 'schooladmin'), templateDownloadRateLimit, async (_req: Request, res: Response) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Students');

  // Header row
  ws.addRow([
    'Student Name',
    'Roll Number',
    'Class',
    'Division',
    'Parent Name',
    'Parent Phone',
    'Date of Birth (DD/MM/YYYY)',
  ]);

  // Example rows
  ws.addRow(['John Doe', 'R001', '10', 'A', 'Jane Doe', '9876543210', '15/08/2010']);
  ws.addRow(['Alice Smith', 'R002', '10', 'B', 'Bob Smith', '9876543211', '22/03/2011']);

  const buffer = await wb.xlsx.writeBuffer();

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=student_import_template.xlsx');
  res.send(buffer as unknown as Buffer);
});

// ── POST /api/import/students/preview ─────────────────────────────────────────
router.post(
  '/students/preview',
  requireRole('superadmin', 'schooladmin'),
  importRateLimit,
  upload.single('file'),
  async (req: Request, res: Response) => {
    if (!req.file) {
      sendError(res, 'No file uploaded. Please attach an .xlsx or .xls file.', 400);
      return;
    }

    const school_id = req.user!.school_id;
    if (!school_id) {
      sendError(res, 'Your account is not linked to a school.', 403);
      return;
    }

    // Parse workbook with ExcelJS (safer than xlsx for untrusted input)
    let rawRows: unknown[][] = [];
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.file.buffer.buffer.slice(req.file.buffer.byteOffset, req.file.buffer.byteOffset + req.file.buffer.byteLength) as ArrayBuffer);
      const ws = wb.worksheets[0];
      if (!ws) throw new Error('No worksheet found');
      ws.eachRow((row, _rowNumber) => {
        const values = (row.values as unknown[]).slice(1); // ExcelJS rows are 1-indexed, index 0 is empty
        rawRows.push(values);
      });
    } catch {
      sendError(res, 'Failed to parse Excel file. Ensure it is a valid .xlsx or .xls file.', 400);
      return;
    }

    // Skip header row (index 0)
    const dataRows = rawRows.slice(1).filter((row) => {
      // Skip completely empty rows
      return row.some((cell) => cell !== '' && cell !== null && cell !== undefined);
    });

    if (dataRows.length === 0) {
      sendError(res, 'The file contains no data rows.', 400);
      return;
    }

    // Fetch existing roll numbers for this school to check DB duplicates
    const { data: existingStudents, error: dbErr } = await supabaseAdmin
      .from('students')
      .select('roll_number, class_name, phone_number')
      .eq('school_id', school_id)
      .eq('is_deleted', false);

    if (dbErr) {
      sendError(res, 'Failed to check existing students.', 500);
      return;
    }

    // Build a set of "roll_number|class_name" for fast lookup
    const existingSet = new Set<string>(
      (existingStudents ?? [])
        .filter((s) => s.roll_number && s.class_name)
        .map((s) => `${String(s.roll_number).toLowerCase()}|${String(s.class_name).toLowerCase()}`)
    );

    // Build a set of existing phone numbers for duplicate check
    const existingPhones = new Set<string>(
      (existingStudents ?? [])
        .filter((s) => s.phone_number)
        .map((s) => String(s.phone_number).trim())
    );

    // Track roll numbers and phones seen within this file for intra-file duplicate detection
    const seenInFile = new Set<string>();
    const seenPhonesInFile = new Set<string>();
    const previewRows: PreviewRow[] = [];

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const rowNumber = i + 2; // Excel row number (header is row 1)

      // Columns: Student Name | Roll Number | Class | Division | Parent Name | Parent Phone | Date of Birth
      const studentName = cellToString(row[0]);
      const rollNumber  = cellToString(row[1]);
      const className   = cellToString(row[2]);
      const division    = cellToString(row[3]);
      const parentName  = cellToString(row[4]);
      const parentPhone = cellToString(row[5]);
      const dateOfBirth = cellToString(row[6]);

      const errors: string[] = [];

      // Validate each field
      const nameErr = validateStudentName(studentName);
      if (nameErr) errors.push(nameErr);

      const rollErr = validateRollNumber(rollNumber);
      if (rollErr) errors.push(rollErr);

      const classErr = validateClass(className);
      if (classErr) errors.push(classErr);

      const divErr = validateDivision(division);
      if (divErr) errors.push(divErr);

      const parentNameErr = validateParentName(parentName);
      if (parentNameErr) errors.push(parentNameErr);

      // Parent Phone is now REQUIRED (login phone)
      const phoneErr = validateLoginPhone(parentPhone);
      if (phoneErr) errors.push(phoneErr);

      // Date of Birth is OPTIONAL
      const { error: dobErr, parsed: parsedDob } = validateDateOfBirth(dateOfBirth);
      if (dobErr) errors.push(dobErr);

      // Normalize for duplicate checks
      const rollStr  = rollNumber.trim().toLowerCase();
      const classStr = className.trim().toLowerCase();
      const key      = rollStr ? `${rollStr}|${classStr}` : null;
      const phoneStr = parentPhone.trim();

      let status: 'valid' | 'invalid' | 'duplicate' = 'valid';

      // Check for roll number duplicates (only when roll number is provided)
      if (key) {
        if (seenInFile.has(key)) {
          errors.push('Duplicate roll number within this file');
          status = 'duplicate';
        } else if (existingSet.has(key)) {
          errors.push('Roll number already exists in database for this class');
          status = 'duplicate';
        }
      }

      // Check for phone number duplicates (only if phone is valid)
      if (phoneStr && /^\d{10}$/.test(phoneStr)) {
        if (seenPhonesInFile.has(phoneStr)) {
          errors.push('Duplicate phone number within this file');
          if (status === 'valid') status = 'duplicate';
        } else if (existingPhones.has(phoneStr)) {
          errors.push('Phone number already registered to another student');
          if (status === 'valid') status = 'duplicate';
        }
      }

      if (status === 'valid' && errors.length > 0) {
        status = 'invalid';
      }

      if (status === 'valid') {
        if (key) seenInFile.add(key);
        if (phoneStr) seenPhonesInFile.add(phoneStr);
      }

      previewRows.push({
        row_number: rowNumber,
        data: {
          name:          studentName.trim(),
          roll_number:   rollNumber.trim(),
          class:         className.trim(),
          division:      division.trim().toUpperCase(),
          parent_name:   parentName.trim(),
          parent_phone:  phoneStr,
          date_of_birth: parsedDob ?? dateOfBirth.trim(), // ISO if valid, raw if not
        },
        status,
        errors,
      });
    }

    const validRows      = previewRows.filter((r) => r.status === 'valid').length;
    const invalidRows    = previewRows.filter((r) => r.status === 'invalid').length;
    const duplicateRows  = previewRows.filter((r) => r.status === 'duplicate').length;

    const preview: PreviewResponse = {
      total_rows:     previewRows.length,
      valid_rows:     validRows,
      invalid_rows:   invalidRows,
      duplicate_rows: duplicateRows,
      rows:           previewRows,
    };

    // Cache the preview for 10 minutes
    const sessionId = uuidv4();
    previewCache.set(sessionId, {
      rows: previewRows,
      school_id,
      type: 'students',
      expires_at: Date.now() + 10 * 60 * 1000,
    });

    // Purge expired sessions
    purgeExpiredSessions();

    sendSuccess(res, { ...preview, import_session_id: sessionId });
  }
);

// ── POST /api/import/students/confirm ─────────────────────────────────────────
router.post('/students/confirm', requireRole('superadmin', 'schooladmin'), async (req: Request, res: Response) => {
  const { import_session_id } = req.body;

  if (!import_session_id || typeof import_session_id !== 'string') {
    sendError(res, 'import_session_id is required', 400);
    return;
  }

  const cached = previewCache.get(import_session_id);
  if (!cached) {
    sendError(res, 'Import session not found or expired. Please re-upload the file.', 404);
    return;
  }

  if (cached.type !== 'students') {
    sendError(res, 'Invalid session type. Expected students import.', 400);
    return;
  }

  if (cached.school_id !== req.user!.school_id) {
    sendError(res, 'Session does not belong to your school.', 403);
    return;
  }

  const validRows = cached.rows.filter((r) => r.status === 'valid');
  if (validRows.length === 0) {
    sendError(res, 'No valid rows to import.', 400);
    return;
  }

  // Fetch school name for the welcome SMS
  const { data: school } = await supabaseAdmin
    .from('schools')
    .select('name')
    .eq('id', cached.school_id)
    .maybeSingle();
  const schoolName = (school as Record<string, unknown> | null)?.name as string ?? 'your school';

  const errors: string[] = [];
  let importedCount = 0;

  // ── Insert students one-by-one so we can send SMS per student ────────────────
  // (Bulk insert is skipped here because each row needs a bcrypt hash + SMS)
  for (const row of validRows) {
    const data = row.data as {
      name:          string;
      roll_number:   string;
      class:         string;
      division:      string;
      parent_name:   string;
      parent_phone:  string;
      date_of_birth: string; // YYYY-MM-DD (already parsed in preview)
    };

    const studentId = uuidv4();
    const phone     = data.parent_phone;

    // Default password = last 5 digits of phone number
    const defaultPassword = phone.slice(-5);
    let passwordHash: string;
    try {
      passwordHash = await bcrypt.hash(defaultPassword, 10);
    } catch (hashErr) {
      errors.push(`Row ${row.row_number}: Failed to hash password — ${hashErr instanceof Error ? hashErr.message : String(hashErr)}`);
      continue;
    }

    const { error: insertErr } = await supabaseAdmin.from('students').insert({
      id:             studentId,
      full_name:      data.name,
      name:           data.name,      // keep legacy name column in sync
      school_id:      cached.school_id,
      class_name:     data.class,
      class:          data.class,     // legacy NOT NULL column in live DB
      section:        data.division,
      roll_number:    data.roll_number,
      phone_number:   phone,
      phone:          phone,          // keep legacy phone column in sync
      date_of_birth:  data.date_of_birth || null, // optional — null if not provided
      password_hash:  passwordHash,
      is_first_login: true,
      qr_code:        studentId,
      is_deleted:     false,
      created_at:     new Date().toISOString(),
    });

    if (insertErr) {
      console.error(`[bulkImport] Insert failed for row ${row.row_number} ("${data.name}"):`, insertErr.message);
      errors.push(`Row ${row.row_number} (${data.name}): ${insertErr.message}`);
      continue;
    }

    importedCount++;

    // ── Send welcome SMS (best-effort — never fail the import) ────────────────
    const smsMessage =
      `Welcome to Eduvo! Your child ${data.name} has been added to ${schoolName}. ` +
      `Download Eduvo app and login with: Phone: ${phone} Password: ${defaultPassword} ` +
      `Please change your password after first login.`;

    try {
      const smsSent = await sendSMS(phone, smsMessage);
      if (!smsSent) {
        console.warn(`[bulkImport] SMS not sent for student "${data.name}" (phone: ...${phone.slice(-4)})`);
      }
    } catch (smsErr) {
      // Log but never fail the import
      console.error(`[bulkImport] SMS error for student "${data.name}":`, smsErr);
    }

    // ── Audit log per student ─────────────────────────────────────────────────
    await logAudit(req.user!.id, 'bulk_import_student_created', {
      student_id:   studentId,
      student_name: data.name,
      school_id:    cached.school_id,
      class:        data.class,
      section:      data.division,
      roll_number:  data.roll_number,
    });
  }

  // Summary audit log
  await logAudit(req.user!.id, 'bulk_import_students', {
    count:     importedCount,
    school_id: cached.school_id,
  });

  // Remove session from cache
  previewCache.delete(import_session_id);

  sendSuccess(res, {
    imported: importedCount,
    skipped:  validRows.length - importedCount,
    errors,
  });
});

// ── GET /api/import/teachers/template ─────────────────────────────────────────
router.get('/teachers/template', requireRole('superadmin', 'schooladmin'), templateDownloadRateLimit, async (_req: Request, res: Response) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Teachers');

  // ── Header row ──────────────────────────────────────────────────────────────
  const headerRow = ws.addRow(['name', 'email', 'phone', 'assignments']);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } };

  // ── Example rows (one row per teacher, all assignments in one cell) ─────────
  ws.addRow(['Priya Shah', 'priya@school.com', '9876543210', '10A-Maths, 10B-Maths']);
  ws.addRow(['Ravi Mehta', 'ravi@school.com',  '9123456780', '9A-Hindi, 9B-Hindi, 8A-Hindi']);
  ws.addRow(['Sita Verma', 'sita@school.com',  '9988776655', '4A-Science']);
  ws.addRow(['Amit Patel', 'amit@school.com',  '9112233445', '']);  // no assignments yet

  // ── Instructions sheet ──────────────────────────────────────────────────────
  const info = wb.addWorksheet('Instructions');
  info.addRow(['Column', 'Required', 'Notes']);
  info.addRow(['name',        'Yes', 'Full name of the teacher']);
  info.addRow(['email',       'Yes', 'Email address — used as login username']);
  info.addRow(['phone',       'Yes', 'Phone number — used as default password']);
  info.addRow(['assignments', 'No',  'Comma-separated list in format: ClassDivision-Subject  e.g. 10A-Maths, 9B-Hindi, 8A-Science']);
  info.addRow([]);
  info.addRow(['Assignment format', '', 'ClassDivision-Subject  →  10A-Maths']);
  info.addRow(['Multiple classes',  '', 'Separate with commas  →  10A-Maths, 9B-Hindi, 8A-Science']);
  info.addRow(['No assignment',     '', 'Leave the cell blank — you can assign classes later from the dashboard']);
  info.columns = [{ width: 20 }, { width: 12 }, { width: 70 }];
  info.getRow(1).font = { bold: true };

  // ── Column widths on main sheet ─────────────────────────────────────────────
  ws.columns = [
    { width: 22 },  // name
    { width: 30 },  // email
    { width: 15 },  // phone
    { width: 50 },  // assignments
  ];

  const buffer = await wb.xlsx.writeBuffer();

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=teacher_import_template.xlsx');
  res.send(buffer as unknown as Buffer);
});

// ── POST /api/import/teachers/preview ─────────────────────────────────────────
router.post(
  '/teachers/preview',
  requireRole('superadmin', 'schooladmin'),
  importRateLimit,
  upload.single('file'),
  async (req: Request, res: Response) => {
    if (!req.file) {
      sendError(res, 'No file uploaded. Please attach an .xlsx or .xls file.', 400);
      return;
    }

    const school_id = req.user!.school_id;
    if (!school_id) {
      sendError(res, 'Your account is not linked to a school.', 403);
      return;
    }

    let rawRowsTeacher: unknown[][] = [];
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.file.buffer.buffer.slice(req.file.buffer.byteOffset, req.file.buffer.byteOffset + req.file.buffer.byteLength) as ArrayBuffer);
      const ws = wb.worksheets[0];
      if (!ws) throw new Error('No worksheet found');
      ws.eachRow((row, _rowNumber) => {
        const values = (row.values as unknown[]).slice(1);
        rawRowsTeacher.push(values);
      });
    } catch {
      sendError(res, 'Failed to parse Excel file. Ensure it is a valid .xlsx or .xls file.', 400);
      return;
    }

    const dataRows = rawRowsTeacher.slice(1).filter((row) => {
      return (row as unknown[]).some((cell) => cell !== '' && cell !== null && cell !== undefined);
    });

    if (dataRows.length === 0) {
      sendError(res, 'The file contains no data rows.', 400);
      return;
    }

    // Fetch existing teacher emails to check duplicates
    // Exclude soft-deleted teachers so re-importing them after removal works correctly
    const { data: existingTeachers, error: dbErr } = await supabaseAdmin
      .from('users')
      .select('email')
      .eq('role', 'teacher')
      .eq('school_id', school_id)
      .neq('is_deleted', true);

    if (dbErr) {
      sendError(res, 'Failed to check existing teachers.', 500);
      return;
    }

    const existingEmails = new Set<string>(
      (existingTeachers ?? []).map((t) => String(t.email).toLowerCase())
    );

    // ── First pass: collect all rows and group by email ────────────────────────
    // New format: one row per teacher. Column 4 (index 3) is a comma-separated
    // assignments string like "10A-Maths, 9B-Hindi, 8A-Science".
    // We still support the OLD multi-row format (separate class/division/subject
    // columns) as a fallback, so existing files keep working.
    interface RawTeacherRow {
      row_number: number;
      name: string;
      email: string;
      phone: string;
      // new single-row format
      assignments_raw: string;
      // old multi-row format (columns 3/4/5)
      class: string;
      division: string;
      subject: string;
    }

    const allRawRows: RawTeacherRow[] = [];
    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i] as unknown[];
      allRawRows.push({
        row_number:      i + 2,
        name:            cellToString(row[0]).trim(),
        email:           cellToString(row[1]).trim(),
        phone:           cellToString(row[2]).trim(),
        assignments_raw: cellToString(row[3]).trim(),  // new format: "10A-Maths, 9B-Hindi"
        class:           cellToString(row[3]).trim(),  // old format: class number
        division:        cellToString(row[4]).trim().toUpperCase(), // old format: division letter
        subject:         cellToString(row[5]).trim(),  // old format: subject
      });
    }

    /**
     * Parse a single assignments string like "10A-Maths, 9B-Hindi, 8A-Science"
     * into structured { class, division, subject } objects.
     * Each token is ClassDivision-Subject, e.g. "10A-Maths" → class=10, division=A, subject=Maths.
     * Division is the last letter of the class+division part before the dash.
     */
    function parseAssignmentsString(raw: string): Array<{ class: string; division: string; subject: string }> {
      if (!raw.trim()) return [];
      return raw
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean)
        .map((token) => {
          // Primary format: "10A-Maths" or "10 A - Maths" (dash separator)
          // Fallback format: "10A Maths" or "4b maths" (space separator, no dash)
          let classDiv: string;
          let subject: string;

          const dashIdx = token.indexOf('-');
          if (dashIdx !== -1) {
            classDiv = token.slice(0, dashIdx).trim();
            subject  = token.slice(dashIdx + 1).trim();
          } else {
            // No dash — try splitting class+division prefix from subject by space.
            // Match a leading class+division block (digits + optional letters) then the rest as subject.
            const spaceMatch = token.match(/^(\d+[A-Za-z]*)\s+(.+)$/);
            if (spaceMatch) {
              classDiv = spaceMatch[1].trim();
              subject  = spaceMatch[2].trim();
            } else {
              return null; // still malformed — skip
            }
          }

          if (!classDiv || !subject) return null;

          // Extract trailing letter(s) as division, rest as class number
          const divMatch = classDiv.match(/^(\d+)\s*([A-Za-z]+)$/);
          if (divMatch) {
            return { class: divMatch[1], division: divMatch[2].toUpperCase(), subject };
          }
          // If no division letter (e.g. just "10"), use class with empty division
          const numMatch = classDiv.match(/^(\d+)$/);
          if (numMatch) {
            return { class: numMatch[1], division: '', subject };
          }
          return null;
        })
        .filter((a): a is { class: string; division: string; subject: string } => a !== null);
    }

    /**
     * Detect whether this file uses the NEW single-row format (column 4 = assignments string)
     * or the OLD multi-row format (columns 4/5/6 = class/division/subject).
     * Heuristics (in order):
     * 1. If any row has a dash in column 4, it's definitely the new format.
     * 2. If any row's column 4 starts with a digit followed by a letter (e.g. "4b", "10A"), it's new format.
     * 3. If any row has a non-empty column 6 (old subject column), it's old format.
     * Default to new format if ambiguous.
     */
    const isNewFormat = (() => {
      // Check for explicit new-format signals
      for (const r of allRawRows) {
        if (r.assignments_raw.includes('-')) return true;
        // Matches patterns like "4b maths", "10A Science" — class+div prefix
        if (/^\d+[A-Za-z]/.test(r.assignments_raw)) return true;
      }
      // Check for old-format signal: a non-empty 6th column (subject)
      const hasOldFormatSubjectCol = allRawRows.some((r) => r.subject.length > 0);
      if (hasOldFormatSubjectCol) return false;
      return true; // default to new format
    })();

    // ── Group rows by email ────────────────────────────────────────────────────
    const emailToFirstRow = new Map<string, RawTeacherRow>();
    const emailToAssignments = new Map<string, Array<{ class: string; division: string; subject: string }>>();

    for (const r of allRawRows) {
      const key = r.email.toLowerCase();
      if (!emailToFirstRow.has(key)) {
        emailToFirstRow.set(key, r);
        emailToAssignments.set(key, []);
      }

      const list = emailToAssignments.get(key)!;

      if (isNewFormat) {
        // New format: parse the assignments_raw string once per unique email
        // (only process the first occurrence to avoid re-parsing duplicates)
        if (emailToFirstRow.get(key) === r) {
          const parsed = parseAssignmentsString(r.assignments_raw);
          list.push(...parsed);
        }
      } else {
        // Old multi-row format: each row is one assignment
        if (r.class || r.division || r.subject) {
          list.push({ class: r.class, division: r.division, subject: r.subject });
        }
      }
    }

    const previewRows: PreviewRow[] = [];

    for (const [emailKey, firstRow] of emailToFirstRow.entries()) {
      const assignments = emailToAssignments.get(emailKey) ?? [];
      const errors: string[] = [];

      if (!firstRow.name) errors.push('Name is required');
      if (!firstRow.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(firstRow.email)) {
        errors.push('Valid email is required');
      }
      if (!firstRow.phone || !/^\d{7,15}$/.test(firstRow.phone.replace(/[\s\-+]/g, ''))) {
        errors.push('Valid phone number is required (7–15 digits)');
      }

      let status: 'valid' | 'invalid' | 'duplicate' = 'valid';
      if (existingEmails.has(emailKey)) {
        errors.push('Email already exists in system');
        status = 'duplicate';
      } else if (errors.length > 0) {
        status = 'invalid';
      }

      // Format assignments summary for display
      const assignedClasses = assignments
        .map((a) => {
          if (a.class && a.division && a.subject) return `${a.class}${a.division} — ${a.subject}`;
          if (a.class && a.division) return `${a.class}${a.division}`;
          return '';
        })
        .filter(Boolean)
        .join(', ');

      previewRows.push({
        row_number: firstRow.row_number,
        data: {
          name:      firstRow.name,
          phone:     firstRow.phone,
          email:     firstRow.email,
          subject:   assignments.map((a) => a.subject).filter(Boolean).join(', '),
          assigned_classes: assignedClasses,
          // Store the structured assignments for confirm
          assignments,
        },
        status,
        errors,
      });
    }

    const validRows      = previewRows.filter((r) => r.status === 'valid').length;
    const invalidRows    = previewRows.filter((r) => r.status === 'invalid').length;
    const duplicateRows  = previewRows.filter((r) => r.status === 'duplicate').length;

    const preview: PreviewResponse = {
      total_rows:     previewRows.length,
      valid_rows:     validRows,
      invalid_rows:   invalidRows,
      duplicate_rows: duplicateRows,
      rows:           previewRows,
    };

    const sessionId = uuidv4();
    previewCache.set(sessionId, {
      rows: previewRows,
      school_id,
      type: 'teachers',
      expires_at: Date.now() + 10 * 60 * 1000,
    });

    purgeExpiredSessions();

    sendSuccess(res, { ...preview, import_session_id: sessionId });
  }
);

// ── POST /api/import/teachers/confirm ─────────────────────────────────────────
router.post('/teachers/confirm', requireRole('superadmin', 'schooladmin'), async (req: Request, res: Response) => {
  const { import_session_id } = req.body;

  if (!import_session_id || typeof import_session_id !== 'string') {
    sendError(res, 'import_session_id is required', 400);
    return;
  }

  const cached = previewCache.get(import_session_id);
  if (!cached) {
    sendError(res, 'Import session not found or expired. Please re-upload the file.', 404);
    return;
  }

  if (cached.type !== 'teachers') {
    sendError(res, 'Invalid session type. Expected teachers import.', 400);
    return;
  }

  if (cached.school_id !== req.user!.school_id) {
    sendError(res, 'Session does not belong to your school.', 403);
    return;
  }

  const validRows = cached.rows.filter((r) => r.status === 'valid');
  if (validRows.length === 0) {
    sendError(res, 'No valid rows to import.', 400);
    return;
  }

  const imported: string[] = [];
  const errors: string[] = [];

  for (const row of validRows) {
    try {
      const data = row.data as {
        name: string;
        phone: string;
        email: string;
        subject: string;
        assigned_classes: string;
        assignments?: Array<{ class: string; division: string; subject: string }>;
      };

      // ── Clean phone to digits only ─────────────────────────────────────────
      const phoneDigits = data.phone.replace(/[\s\-+]/g, '');
      // Default password = full phone number
      const defaultPassword = phoneDigits;

      // ── Create Supabase Auth user with phone as password ───────────────────
      // If the email exists in auth (e.g. from a previously soft-deleted teacher),
      // hard-delete the stale auth entry first so we can re-create cleanly.
      let { data: authUser, error: authErr } = await supabaseAdmin.auth.admin.createUser({
        email: data.email,
        password: defaultPassword,
        email_confirm: true,
        user_metadata: {
          name: data.name,
          role: 'teacher',
        },
      });

      if (authErr && authErr.message?.toLowerCase().includes('already been registered')) {
        // Find and delete the stale auth user, then retry
        const { data: existingAuthUsers } = await supabaseAdmin.auth.admin.listUsers();
        const staleUser = existingAuthUsers?.users?.find(
          (u) => u.email?.toLowerCase() === data.email.toLowerCase()
        );
        if (staleUser) {
          await supabaseAdmin.auth.admin.deleteUser(staleUser.id);
          // Also clean up any stale users row
          await supabaseAdmin.from('users').delete().eq('id', staleUser.id);
        }
        // Retry creation
        const retry = await supabaseAdmin.auth.admin.createUser({
          email: data.email,
          password: defaultPassword,
          email_confirm: true,
          user_metadata: { name: data.name, role: 'teacher' },
        });
        authUser = retry.data;
        authErr  = retry.error;
      }

      if (authErr || !authUser?.user) {
        errors.push(`Row ${row.row_number}: Failed to create auth user — ${authErr?.message ?? 'unknown error'}`);
        continue;
      }

      const userId = authUser.user.id;

      // ── Create users record with must_reset_password = true ────────────────
      const { error: userErr } = await supabaseAdmin.from('users').insert({
        id:                  userId,
        name:                data.name,
        email:               data.email,
        phone:               data.phone,
        role:                'teacher',
        school_id:           cached.school_id,
        must_reset_password: true,
        created_by:          req.user!.id,
        created_at:          new Date().toISOString(),
      });

      if (userErr) {
        errors.push(`Row ${row.row_number}: Failed to create user record — ${userErr.message}`);
        // Clean up auth user to avoid orphaned accounts
        await supabaseAdmin.auth.admin.deleteUser(userId);
        continue;
      }

      // ── Create teacher_assignments for each class/division/subject ──────────
      const structuredAssignments = data.assignments ?? [];

      if (structuredAssignments.length > 0) {
        // Require class + subject; division/section may be empty for some formats
        const assignmentRows = structuredAssignments
          .filter((a) => a.class && a.subject)
          .map((a) => ({
            teacher_id: userId,
            school_id:  cached.school_id,
            class_name: a.class,
            class:      a.class,      // keep legacy column in sync
            section:    (a.division ?? '').toUpperCase(),
            subject:    a.subject,
            // NOTE: no created_at — that column does not exist in teacher_assignments
          }));

        if (assignmentRows.length > 0) {
          const { error: assignErr } = await supabaseAdmin
            .from('teacher_assignments')
            .insert(assignmentRows);

          if (assignErr) {
            // Log but don't fail the import — teacher account was created
            console.error(`[bulkImport] Assignment insert failed for row ${row.row_number}:`, assignErr.message);
            errors.push(`Row ${row.row_number}: Teacher created but some assignments failed — ${assignErr.message}`);
          }
        }
      }

      imported.push(userId);

      await logAudit(req.user!.id, 'bulk_import_teacher_created', {
        teacher_id:   userId,
        teacher_name: data.name,
        school_id:    cached.school_id,
      });
    } catch (err) {
      errors.push(`Row ${row.row_number}: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  // Summary audit log
  await logAudit(req.user!.id, 'bulk_import_teachers', {
    count:     imported.length,
    school_id: cached.school_id,
  });

  // Remove session from cache
  previewCache.delete(import_session_id);

  sendSuccess(res, {
    imported: imported.length,
    skipped:  validRows.length - imported.length,
    errors,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MARKS IMPORT ROUTES
// These routes are for teachers only — they bypass the global schooladmin role
// guard by using per-route requireRole('teacher', 'schooladmin', 'superadmin').
// ═══════════════════════════════════════════════════════════════════════════════

// ── Rate limit: max 10 mark imports per teacher per day ───────────────────────
const marksImportRateLimit = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 10,
  keyGenerator: (req) => `marks_import:${req.user?.id ?? req.ip ?? 'unknown'}`,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: {
    success: false,
    message: 'Marks import limit reached. Maximum 10 mark imports per teacher per day.',
  },
});

// ── Multer config for marks: 2MB max ─────────────────────────────────────────
const marksUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.toLowerCase();
    const mime = file.mimetype.toLowerCase();
    const extOk = ext.endsWith('.xlsx') || ext.endsWith('.xls');
    const mimeOk = ALLOWED_EXCEL_MIMES.has(mime);

    if (extOk && (mimeOk || mime === 'application/octet-stream')) {
      cb(null, true);
    } else {
      cb(new Error('Only .xlsx and .xls files are allowed'));
    }
  },
});

// ── Helper: verify teacher is assigned to class+subject ──────────────────────
async function verifyTeacherAssignment(
  teacherId: string,
  schoolId: string,
  className: string,
  section: string,
  subjectName: string
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('teacher_assignments')
    .select('id')
    .eq('teacher_id', teacherId)
    .eq('school_id', schoolId)
    .ilike('class_name', className.trim())
    .ilike('section', section.trim())
    .ilike('subject', subjectName.trim())
    .maybeSingle();

  if (error) return false;
  return data !== null;
}

// ── GET /api/import/marks/template ────────────────────────────────────────────
router.get(
  '/marks/template',
  requireRole('teacher', 'schooladmin', 'superadmin'),
  templateDownloadRateLimit,
  async (req: Request, res: Response) => {
    const { class: className, section, subject: subjectName, exam_type, term } = req.query as Record<string, string>;

    // Validate required query params
    if (!className || !section || !subjectName || !exam_type || !term) {
      sendError(res, 'Query params required: class, section, subject, exam_type, term', 400);
      return;
    }

    const school_id = req.user!.school_id;
    if (!school_id) {
      sendError(res, 'Your account is not linked to a school.', 403);
      return;
    }

    // For teachers: verify assignment. schooladmin/superadmin can skip this check.
    if (req.user!.role === 'teacher') {
      const assigned = await verifyTeacherAssignment(
        req.user!.id,
        school_id,
        className,
        section,
        subjectName
      );
      if (!assigned) {
        sendError(res, 'You are not assigned to this class and subject.', 403);
        return;
      }
    }

    // Use subject name directly — no subjects table needed
    const subject = { name: subjectName };

    // Fetch students for this class and section
    const { data: students, error: studentsErr } = await supabaseAdmin
      .from('students')
      .select('id, full_name, roll_number')
      .eq('school_id', school_id)
      .ilike('class_name', className.trim())
      .ilike('section', section.trim())
      .eq('is_deleted', false)
      .order('roll_number', { ascending: true });

    if (studentsErr) {
      sendError(res, 'Failed to fetch students.', 500);
      return;
    }

    if (!students || students.length === 0) {
      sendError(res, `No students found for Class ${className} Section ${section}.`, 404);
      return;
    }

    // Build Excel workbook with ExcelJS
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Marks');

    // Rows 1-3: metadata header
    ws.addRow([`Class: ${className} Section: ${section}`]);
    ws.addRow([`Subject: ${subject.name}`]);
    ws.addRow([`Exam Type: ${exam_type} Term: ${term}`]);
    ws.addRow([]); // blank spacer
    ws.addRow(['Roll No', 'Student Name', 'Score', 'Max Score']); // column headers

    // Student data rows
    for (const s of (students as { id: string; full_name: string; roll_number: string }[])) {
      ws.addRow([s.roll_number, s.full_name, '', 100]);
    }

    // Column widths
    ws.columns = [
      { width: 14 }, { width: 28 }, { width: 10 }, { width: 12 },
    ];

    const buffer = await wb.xlsx.writeBuffer();

    const filename = `marks_${className}${section}_${subject.name}_${exam_type}_${term}.xlsx`
      .replace(/\s+/g, '_')
      .toLowerCase();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.send(buffer as unknown as Buffer);
  }
);

// ── POST /api/import/marks/preview ────────────────────────────────────────────
router.post(
  '/marks/preview',
  requireRole('teacher', 'schooladmin', 'superadmin'),
  marksImportRateLimit,
  marksUpload.single('file'),
  async (req: Request, res: Response) => {
    if (!req.file) {
      sendError(res, 'No file uploaded. Please attach an .xlsx or .xls file.', 400);
      return;
    }

    const school_id = req.user!.school_id;
    if (!school_id) {
      sendError(res, 'Your account is not linked to a school.', 403);
      return;
    }

    const { class: className, section, subject: subjectName, exam_type, term, test_name, date } =
      req.body as Record<string, string>;

    if (!className || !section || !subjectName || !exam_type || !term || !test_name || !date) {
      sendError(
        res,
        'Required fields: class, section, subject, exam_type, term, test_name, date',
        400
      );
      return;
    }

    // Use subject name directly — no subjects table needed
    const subject = { name: subjectName, id: '' };

    // For teachers: verify assignment
    if (req.user!.role === 'teacher') {
      const assigned = await verifyTeacherAssignment(
        req.user!.id,
        school_id,
        className,
        section,
        subjectName
      );
      if (!assigned) {
        sendError(res, 'You are not assigned to this class and subject.', 403);
        return;
      }
    }

    // Parse workbook with ExcelJS (safer for untrusted input)
    let rawRowsMarks: unknown[][] = [];
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.file.buffer.buffer.slice(req.file.buffer.byteOffset, req.file.buffer.byteOffset + req.file.buffer.byteLength) as ArrayBuffer);
      const ws = wb.worksheets[0];
      if (!ws) throw new Error('No worksheet found');
      ws.eachRow((row, _rowNumber) => {
        const values = (row.values as unknown[]).slice(1);
        rawRowsMarks.push(values);
      });
    } catch {
      sendError(res, 'Failed to parse Excel file. Ensure it is a valid .xlsx or .xls file.', 400);
      return;
    }

    // Skip rows 1-5 (indices 0-4): metadata + column headers
    const dataRows = rawRowsMarks.slice(5).filter((row) =>
      (row as unknown[]).some((cell) => cell !== '' && cell !== null && cell !== undefined)
    );

    if (dataRows.length === 0) {
      sendError(res, 'The file contains no student data rows (expected from row 6 onwards).', 400);
      return;
    }

    // Fetch all students for this class/section to validate roll numbers
    const { data: students, error: studentsErr } = await supabaseAdmin
      .from('students')
      .select('id, full_name, roll_number')
      .eq('school_id', school_id)
      .ilike('class_name', className.trim())
      .ilike('section', section.trim())
      .eq('is_deleted', false);

    if (studentsErr) {
      sendError(res, 'Failed to fetch students.', 500);
      return;
    }

    // Build roll_number → student map (case-insensitive)
    const studentMap = new Map<string, { id: string; full_name: string; roll_number: string }>();
    for (const s of (students ?? []) as { id: string; full_name: string; roll_number: string }[]) {
      studentMap.set(String(s.roll_number).trim().toLowerCase(), s);
    }

    // Fetch existing marks for this class+subject+exam_type+term to detect will_update
    const studentIds = [...studentMap.values()].map((s) => s.id);
    let existingMarksMap = new Map<string, string>(); // student_id → mark_id

    if (studentIds.length > 0) {
      const { data: existingMarks } = await supabaseAdmin
        .from('marks')
        .select('id, student_id')
        .in('student_id', studentIds)
        .eq('subject', subject.name)
        .eq('exam_type', exam_type)
        .eq('term', term);

      for (const m of (existingMarks ?? []) as { id: string; student_id: string }[]) {
        existingMarksMap.set(m.student_id, m.id);
      }
    }

    const previewRows: MarksPreviewRow[] = [];

    for (const row of dataRows as unknown[][]) {
      const rawRoll  = row[0]; // Column A: Roll Number
      const rawName  = row[1]; // Column B: Student Name (reference only)
      const rawScore = row[2]; // Column C: Score
      const rawMax   = row[3]; // Column D: Max Score

      const rollStr = String(rawRoll ?? '').trim();
      const errors: string[] = [];

      // Validate roll number
      if (!rollStr) {
        errors.push('Roll number is missing');
        previewRows.push({
          roll_number: rollStr,
          student_name: String(rawName ?? '').trim(),
          student_id: '',
          score: null,
          max_score: 100,
          percentage: null,
          status: 'invalid',
          errors,
        });
        continue;
      }

      // Find student by roll number
      const student = studentMap.get(rollStr.toLowerCase());
      if (!student) {
        errors.push(`No student with roll number "${rollStr}" found in Class ${className} Section ${section}`);
        previewRows.push({
          roll_number: rollStr,
          student_name: String(rawName ?? '').trim(),
          student_id: '',
          score: null,
          max_score: 100,
          percentage: null,
          status: 'invalid',
          errors,
        });
        continue;
      }

      // Validate score
      const scoreNum = rawScore === '' || rawScore === null || rawScore === undefined
        ? null
        : Number(rawScore);

      if (scoreNum === null || isNaN(scoreNum)) {
        errors.push('Score is required and must be a number');
      } else if (scoreNum < 0) {
        errors.push('Score cannot be negative');
      }

      // Validate max score
      const maxNum = rawMax === '' || rawMax === null || rawMax === undefined
        ? 100
        : Number(rawMax);

      if (isNaN(maxNum) || maxNum <= 0) {
        errors.push('Max score must be a positive number');
      }

      // Score cannot exceed max score
      if (
        scoreNum !== null &&
        !isNaN(scoreNum) &&
        !isNaN(maxNum) &&
        maxNum > 0 &&
        scoreNum > maxNum
      ) {
        errors.push(`Score (${scoreNum}) cannot exceed max score (${maxNum})`);
      }

      const existingMarkId = existingMarksMap.get(student.id);
      const willUpdate = !!existingMarkId;

      let status: MarksPreviewRow['status'];
      if (errors.length > 0) {
        status = 'invalid';
      } else if (willUpdate) {
        status = 'will_update';
      } else {
        status = 'valid';
      }

      const percentage =
        scoreNum !== null && !isNaN(scoreNum) && !isNaN(maxNum) && maxNum > 0
          ? Math.round((scoreNum / maxNum) * 100 * 100) / 100
          : null;

      previewRows.push({
        roll_number: student.roll_number,
        student_name: student.full_name,
        student_id: student.id,
        score: scoreNum !== null && !isNaN(scoreNum) ? scoreNum : null,
        max_score: !isNaN(maxNum) && maxNum > 0 ? maxNum : 100,
        percentage,
        status,
        errors,
        ...(existingMarkId ? { existing_mark_id: existingMarkId } : {}),
      });
    }

    const validRows      = previewRows.filter((r) => r.status === 'valid').length;
    const invalidRows    = previewRows.filter((r) => r.status === 'invalid').length;
    const willUpdateRows = previewRows.filter((r) => r.status === 'will_update').length;

    // Cache the preview
    const sessionId = uuidv4();
    marksPreviewCache.set(sessionId, {
      rows: previewRows,
      school_id,
      teacher_id: req.user!.id,
      type: 'marks',
      subject_name: subject.name,
      subject_id: '',
      class_name: className,
      section,
      exam_type,
      term,
      test_name,
      date,
      expires_at: Date.now() + 10 * 60 * 1000,
    });

    purgeExpiredSessions();

    sendSuccess(res, {
      session_id: sessionId,
      test_name,
      class: className,
      section,
      subject_name: subject.name,
      exam_type,
      term,
      total_students: previewRows.length,
      valid_rows: validRows,
      invalid_rows: invalidRows,
      will_update_rows: willUpdateRows,
      rows: previewRows.map(({ existing_mark_id: _omit, student_id: _sid, ...rest }) => rest),
    });
  }
);

// ── POST /api/import/marks/confirm ────────────────────────────────────────────
router.post(
  '/marks/confirm',
  requireRole('teacher', 'schooladmin', 'superadmin'),
  async (req: Request, res: Response) => {
    const { session_id } = req.body as { session_id?: string };

    if (!session_id || typeof session_id !== 'string') {
      sendError(res, 'session_id is required', 400);
      return;
    }

    const cached = marksPreviewCache.get(session_id);
    if (!cached) {
      sendError(res, 'Session not found or expired. Please re-upload the file.', 404);
      return;
    }

    // Verify session belongs to this teacher (schooladmin/superadmin can confirm any session in their school)
    const school_id = req.user!.school_id;
    if (cached.school_id !== school_id) {
      sendError(res, 'Session does not belong to your school.', 403);
      return;
    }

    if (req.user!.role === 'teacher' && cached.teacher_id !== req.user!.id) {
      sendError(res, 'Session does not belong to you.', 403);
      return;
    }

    const actionableRows = cached.rows.filter(
      (r) => r.status === 'valid' || r.status === 'will_update'
    );

    if (actionableRows.length === 0) {
      sendError(res, 'No valid rows to import.', 400);
      return;
    }

    let importedCount = 0;
    let updatedCount  = 0;
    const errors: string[] = [];

    for (const row of actionableRows) {
      if (row.score === null) {
        errors.push(`${row.roll_number}: Score is missing — skipped`);
        continue;
      }

      if (row.status === 'will_update' && row.existing_mark_id) {
        // Fetch old value for audit log
        const { data: oldMark } = await supabaseAdmin
          .from('marks')
          .select('score, max_score')
          .eq('id', row.existing_mark_id)
          .maybeSingle();

        const { error: updateErr } = await supabaseAdmin
          .from('marks')
          .update({
            score:       row.score,
            max_score:   row.max_score,
            recorded_by: req.user!.id,
          })
          .eq('id', row.existing_mark_id);

        if (updateErr) {
          errors.push(`${row.roll_number}: Failed to update — ${updateErr.message}`);
          continue;
        }

        updatedCount++;

        await logAudit(req.user!.id, 'bulk_marks_update', {
          mark_id:     row.existing_mark_id,
          student_id:  row.student_id,
          roll_number: row.roll_number,
          subject:     cached.subject_name,
          exam_type:   cached.exam_type,
          term:        cached.term,
          old_score:   (oldMark as { score: number; max_score: number } | null)?.score ?? null,
          old_max:     (oldMark as { score: number; max_score: number } | null)?.max_score ?? null,
          new_score:   row.score,
          new_max:     row.max_score,
          school_id,
        });
      } else {
        // Insert new mark
        const { error: insertErr } = await supabaseAdmin.from('marks').insert({
          student_id:  row.student_id,
          subject:     cached.subject_name,
          score:       row.score,
          max_score:   row.max_score,
          term:        cached.term,
          exam_type:   cached.exam_type,
          recorded_by: req.user!.id,
          created_at:  new Date().toISOString(),
        });

        if (insertErr) {
          errors.push(`${row.roll_number}: Failed to insert — ${insertErr.message}`);
          continue;
        }

        importedCount++;
      }
    }

    // Summary audit log
    await logAudit(req.user!.id, 'bulk_marks_import', {
      count:       importedCount,
      updated:     updatedCount,
      class:       cached.class_name,
      section:     cached.section,
      subject:     cached.subject_name,
      exam_type:   cached.exam_type,
      term:        cached.term,
      test_name:   cached.test_name,
      school_id,
    });

    // Remove session from cache
    marksPreviewCache.delete(session_id);

    sendSuccess(res, {
      imported: importedCount,
      updated:  updatedCount,
      errors,
    });
  }
);

export default router;
