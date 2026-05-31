import { Router, Request, Response } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../config/supabase';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/roles';
import { sendSuccess, sendError } from '../utils/response';
import { templateDownloadRateLimit } from '../middleware/rateLimit';
import { sendSMS } from '../services/smsService';

const router = Router();

// ── All routes require authentication + school_admin role ─────────────────────
router.use(authenticate);
router.use(requireRole('schooladmin'));

// ── In-memory session cache (TTL: 10 minutes) ─────────────────────────────────
interface CachedPreview {
  rows: PreviewRow[];
  school_id: string;
  type: 'students' | 'teachers';
  expires_at: number;
}
const previewCache = new Map<string, CachedPreview>();

/** Purge expired sessions from the cache. */
function purgeExpiredSessions(): void {
  const now = Date.now();
  for (const [key, val] of previewCache.entries()) {
    if (val.expires_at < now) previewCache.delete(key);
  }
}

// ── Rate limit: max 3 imports per hour per school ─────────────────────────────
const importRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  keyGenerator: (req) => req.user?.school_id ?? req.ip ?? 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
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

// ── Validation helpers ────────────────────────────────────────────────────────
function validateStudentName(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'Student Name is required';
  if (name.length > 100) return 'Student Name must be max 100 characters';
  if (!/^[a-zA-Z\s]+$/.test(name)) return 'Student Name must not contain special characters';
  return null;
}

function validateRollNumber(roll: unknown): string | null {
  if (typeof roll !== 'string' && typeof roll !== 'number') return 'Roll Number is required';
  const str = String(roll).trim();
  if (!str) return 'Roll Number is required';
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
 * Validate Date of Birth in DD/MM/YYYY format.
 * Returns an error string or null if valid.
 * Also checks student age is between 3 and 25 years.
 */
function validateDateOfBirth(dob: unknown): { error: string | null; parsed: string | null } {
  if (!dob || (typeof dob === 'string' && !String(dob).trim())) {
    return { error: 'Date of Birth is required (format: DD/MM/YYYY)', parsed: null };
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
router.get('/students/template', templateDownloadRateLimit, (_req: Request, res: Response) => {
  const wb = XLSX.utils.book_new();

  // Header row — Parent Phone IS the login phone number for the student account.
  // Date of Birth format: DD/MM/YYYY
  const headers = [
    'Student Name',
    'Roll Number',
    'Class',
    'Division',
    'Parent Name',
    'Parent Phone',
    'Date of Birth (DD/MM/YYYY)',
  ];

  // Example rows
  const exampleRows = [
    ['John Doe', 'R001', '10', 'A', 'Jane Doe', '9876543210', '15/08/2010'],
    ['Alice Smith', 'R002', '10', 'B', 'Bob Smith', '9876543211', '22/03/2011'],
  ];

  const data = [headers, ...exampleRows];
  const ws = XLSX.utils.aoa_to_sheet(data);

  XLSX.utils.book_append_sheet(wb, ws, 'Students');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=student_import_template.xlsx');
  res.send(buffer);
});

// ── POST /api/import/students/preview ─────────────────────────────────────────
router.post(
  '/students/preview',
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

    // Parse workbook
    let wb: XLSX.WorkBook;
    try {
      wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    } catch {
      sendError(res, 'Failed to parse Excel file. Ensure it is a valid .xlsx or .xls file.', 400);
      return;
    }

    const ws = wb.Sheets[wb.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' });

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
      const studentName = row[0];
      const rollNumber  = row[1];
      const className   = row[2];
      const division    = row[3];
      const parentName  = row[4];
      const parentPhone = row[5];
      const dateOfBirth = row[6];

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

      // Date of Birth is REQUIRED
      const { error: dobErr, parsed: parsedDob } = validateDateOfBirth(dateOfBirth);
      if (dobErr) errors.push(dobErr);

      // Normalize for duplicate checks
      const rollStr  = String(rollNumber).trim().toLowerCase();
      const classStr = String(className).trim().toLowerCase();
      const key      = `${rollStr}|${classStr}`;
      const phoneStr = String(parentPhone || '').trim();

      let status: 'valid' | 'invalid' | 'duplicate' = 'valid';

      // Check for roll number duplicates
      if (seenInFile.has(key)) {
        errors.push('Duplicate roll number within this file');
        status = 'duplicate';
      } else if (existingSet.has(key)) {
        errors.push('Roll number already exists in database for this class');
        status = 'duplicate';
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
        seenInFile.add(key);
        if (phoneStr) seenPhonesInFile.add(phoneStr);
      }

      previewRows.push({
        row_number: rowNumber,
        data: {
          name:          String(studentName || '').trim(),
          roll_number:   String(rollNumber || '').trim(),
          class:         String(className || '').trim(),
          division:      String(division || '').trim().toUpperCase(),
          parent_name:   String(parentName || '').trim(),
          parent_phone:  phoneStr,
          date_of_birth: parsedDob ?? String(dateOfBirth || '').trim(), // ISO if valid, raw if not
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
router.post('/students/confirm', async (req: Request, res: Response) => {
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
      school_id:      cached.school_id,
      class_name:     data.class,
      section:        data.division,
      roll_number:    data.roll_number,
      phone_number:   phone,
      phone:          phone,          // keep legacy column in sync if it exists
      date_of_birth:  data.date_of_birth,
      password_hash:  passwordHash,
      is_first_login: true,
      qr_code:        studentId,
      is_deleted:     false,
      created_at:     new Date().toISOString(),
    });

    if (insertErr) {
      errors.push(`Row ${row.row_number}: ${insertErr.message}`);
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
router.get('/teachers/template', templateDownloadRateLimit, (_req: Request, res: Response) => {
  const wb = XLSX.utils.book_new();

  const headers = [
    'Teacher Name',
    'Phone Number',
    'Email',
    'Subject',
    'Assigned Classes',
  ];

  const exampleRows = [
    ['John Smith', '9876543210', 'john.smith@school.com', 'Mathematics', '10A, 10B, 9A'],
    ['Jane Doe', '9876543211', 'jane.doe@school.com', 'English', '8A, 8B'],
  ];

  const data = [headers, ...exampleRows];
  const ws = XLSX.utils.aoa_to_sheet(data);

  XLSX.utils.book_append_sheet(wb, ws, 'Teachers');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=teacher_import_template.xlsx');
  res.send(buffer);
});

// ── POST /api/import/teachers/preview ─────────────────────────────────────────
router.post(
  '/teachers/preview',
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

    let wb: XLSX.WorkBook;
    try {
      wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    } catch {
      sendError(res, 'Failed to parse Excel file. Ensure it is a valid .xlsx or .xls file.', 400);
      return;
    }

    const ws = wb.Sheets[wb.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' });

    const dataRows = rawRows.slice(1).filter((row) => {
      return row.some((cell) => cell !== '' && cell !== null && cell !== undefined);
    });

    if (dataRows.length === 0) {
      sendError(res, 'The file contains no data rows.', 400);
      return;
    }

    // Fetch existing teacher emails to check duplicates
    const { data: existingTeachers, error: dbErr } = await supabaseAdmin
      .from('users')
      .select('email')
      .eq('role', 'teacher')
      .eq('school_id', school_id);

    if (dbErr) {
      sendError(res, 'Failed to check existing teachers.', 500);
      return;
    }

    const existingEmails = new Set<string>(
      (existingTeachers ?? []).map((t) => String(t.email).toLowerCase())
    );

    const seenInFile = new Set<string>();
    const previewRows: PreviewRow[] = [];

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const rowNumber = i + 2;

      const teacherName = row[0];
      const phone = row[1];
      const email = row[2];
      const subject = row[3];
      const assignedClasses = row[4];

      const errors: string[] = [];

      const nameErr = validateTeacherName(teacherName);
      if (nameErr) errors.push(nameErr);

      const phoneErr = validateTeacherPhone(phone);
      if (phoneErr) errors.push(phoneErr);

      const emailErr = validateTeacherEmail(email);
      if (emailErr) errors.push(emailErr);

      const subjectErr = validateSubject(subject);
      if (subjectErr) errors.push(subjectErr);

      const classesErr = validateAssignedClasses(assignedClasses);
      if (classesErr) errors.push(classesErr);

      const emailStr = String(email || '').trim().toLowerCase();
      let status: 'valid' | 'invalid' | 'duplicate' = 'valid';

      if (seenInFile.has(emailStr)) {
        errors.push('Duplicate email within this file');
        status = 'duplicate';
      } else if (existingEmails.has(emailStr)) {
        errors.push('Email already exists in system');
        status = 'duplicate';
      } else if (errors.length > 0) {
        status = 'invalid';
      } else {
        seenInFile.add(emailStr);
      }

      previewRows.push({
        row_number: rowNumber,
        data: {
          name: String(teacherName || '').trim(),
          phone: String(phone || '').trim(),
          email: String(email || '').trim(),
          subject: String(subject || '').trim(),
          assigned_classes: String(assignedClasses || '').trim(),
        },
        status,
        errors,
      });
    }

    const validRows = previewRows.filter((r) => r.status === 'valid').length;
    const invalidRows = previewRows.filter((r) => r.status === 'invalid').length;
    const duplicateRows = previewRows.filter((r) => r.status === 'duplicate').length;

    const preview: PreviewResponse = {
      total_rows: previewRows.length,
      valid_rows: validRows,
      invalid_rows: invalidRows,
      duplicate_rows: duplicateRows,
      rows: previewRows,
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
router.post('/teachers/confirm', async (req: Request, res: Response) => {
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
      };

      // Create Supabase auth user for teacher
      const { data: authUser, error: authErr } = await supabaseAdmin.auth.admin.createUser({
        email: data.email,
        email_confirm: true,
        user_metadata: {
          name: data.name,
          role: 'teacher',
        },
      });

      if (authErr || !authUser.user) {
        errors.push(`Row ${row.row_number}: Failed to create auth user - ${authErr?.message}`);
        continue;
      }

      const userId = authUser.user.id;

      // Create users record
      const { error: userErr } = await supabaseAdmin.from('users').insert({
        id: userId,
        name: data.name,
        email: data.email,
        role: 'teacher',
        school_id: cached.school_id,
        created_by: req.user!.id,
        created_at: new Date().toISOString(),
      });

      if (userErr) {
        errors.push(`Row ${row.row_number}: Failed to create user record - ${userErr.message}`);
        // Clean up auth user
        await supabaseAdmin.auth.admin.deleteUser(userId);
        continue;
      }

      // Parse assigned classes: "10A, 10B, 9A" → [{class: "10", section: "A"}, ...]
      const classesList = data.assigned_classes
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);

      const assignments = classesList.map((cls) => {
        // Extract class and section: "10A" → class="10", section="A"
        const match = cls.match(/^(\d+)([A-Z])$/i);
        if (!match) return null;
        return {
          teacher_id: userId,
          school_id: cached.school_id,
          class_name: match[1],
          section: match[2].toUpperCase(),
          subject: data.subject,
          created_at: new Date().toISOString(),
        };
      }).filter((a) => a !== null);

      if (assignments.length > 0) {
        const { error: assignErr } = await supabaseAdmin
          .from('teacher_assignments')
          .insert(assignments);

        if (assignErr) {
          errors.push(`Row ${row.row_number}: Failed to create assignments - ${assignErr.message}`);
        }
      }

      // TODO: Send welcome email to teacher (requires email service integration)
      // Intentionally not logging email address to avoid PII in server logs.

      imported.push(userId);
    } catch (err) {
      errors.push(`Row ${row.row_number}: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  // Log to audit_logs
  await logAudit(req.user!.id, 'bulk_import_teachers', {
    count: imported.length,
    school_id: cached.school_id,
  });

  // Remove session from cache
  previewCache.delete(import_session_id);

  sendSuccess(res, {
    imported: imported.length,
    skipped: validRows.length - imported.length,
    errors,
  });
});

export default router;
