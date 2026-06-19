/**
 * Seed script: imports CBSE and GSEB chapter data from Excel files
 * into the chapter_library table.
 *
 * Usage:  npm run seed:chapters
 *
 * Safe to re-run — upsert on (board, class, subject, chapter_number) means
 * duplicates are silently ignored.
 */

import * as path from 'path';
import ExcelJS from 'exceljs';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import * as dotenv from 'dotenv';

// Load .env from backend-api root
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// ── Validate environment ──────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    '[seed] ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env'
  );
  process.exit(1);
}

// ── Supabase client with service role (bypasses RLS) ─────────────────────────
// Node 20 has no native WebSocket — provide the `ws` package as transport
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: ws as any },
});

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChapterRow {
  board: string;
  class: number;
  subject: string;
  chapter_number: number;
  chapter_name: string;
  topics: string;
}

// ── Read one Excel file ───────────────────────────────────────────────────────

async function readExcelFile(filePath: string): Promise<ChapterRow[]> {
  console.log(`[seed] Reading: ${filePath}`);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  // Try sheet named "All Chapters" first, fall back to first sheet
  const sheet =
    workbook.getWorksheet('All Chapters') ?? workbook.worksheets[0];

  if (!sheet) {
    console.error(`[seed] ERROR: No sheets found in ${filePath}`);
    return [];
  }

  console.log(`[seed]   Sheet: "${sheet.name}"`);

  // Build a header → column-index map from row 1
  const headerRow = sheet.getRow(1);
  const headerMap: Record<string, number> = {};
  headerRow.eachCell((cell, colNumber) => {
    const header = String(cell.value ?? '').trim();
    if (header) headerMap[header] = colNumber;
  });

  const getCell = (row: ExcelJS.Row, header: string): string => {
    const colIdx = headerMap[header];
    if (!colIdx) return '';
    const val = row.getCell(colIdx).value;
    return String(val ?? '').trim();
  };

  const rows: ChapterRow[] = [];
  let skipped = 0;

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // skip header

    const board       = getCell(row, 'Board');
    const classRaw    = getCell(row, 'Class');
    const subject     = getCell(row, 'Subject');
    const chapterNoRaw = getCell(row, 'Chapter No.');
    const chapterName = getCell(row, 'Chapter Name');
    const topics      = getCell(row, 'Topics');

    const classNum   = parseInt(classRaw, 10);
    const chapterNum = parseInt(chapterNoRaw, 10);

    if (!board || !subject || !chapterName || isNaN(classNum) || isNaN(chapterNum)) {
      skipped++;
      return;
    }

    rows.push({ board, class: classNum, subject, chapter_number: chapterNum, chapter_name: chapterName, topics });
  });

  console.log(`[seed]   Raw rows: ${rows.length + skipped}`);
  if (skipped > 0) {
    console.log(`[seed]   Skipped ${skipped} rows with missing required fields`);
  }

  return rows;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[seed] Starting chapter library seed…\n');

  // Resolve file paths relative to this script's location (scripts/)
  const scriptsDir = __dirname;
  const cbsePath = path.resolve(scriptsDir, 'Data', 'CBSE_Chapter_Library_CORRECTED.xlsx');
  const gsebPath = path.resolve(scriptsDir, 'Data', 'GSEB_Chapter_Library_CORRECTED (1).xlsx');

  // Read both files
  const cbseRows = await readExcelFile(cbsePath);
  const gsebRows = await readExcelFile(gsebPath);

  const allRows = [...cbseRows, ...gsebRows];
  console.log(`\n[seed] Total rows to process: ${allRows.length}`);

  if (allRows.length === 0) {
    console.log('[seed] No rows to insert. Exiting.');
    process.exit(0);
  }

  // Insert in batches of 100
  const BATCH_SIZE = 100;
  const totalBatches = Math.ceil(allRows.length / BATCH_SIZE);
  let totalInserted = 0;
  let totalSkipped = 0;

  for (let i = 0; i < allRows.length; i += BATCH_SIZE) {
    const batch = allRows.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    console.log(
      `[seed] Inserting batch ${batchNum} of ${totalBatches} (${batch.length} rows)…`
    );

    const { error, count } = await supabase
      .from('chapter_library')
      .upsert(batch, {
        onConflict: 'board,class,subject,chapter_number',
        ignoreDuplicates: true,
        count: 'exact',
      });

    if (error) {
      console.error(`[seed] ERROR in batch ${batchNum}:`, error.message);
      console.error('[seed] Aborting.');
      process.exit(1);
    }

    const inserted = count ?? batch.length;
    const skipped = batch.length - inserted;
    totalInserted += inserted;
    totalSkipped += skipped;
  }

  console.log(
    `\n[seed] Done. ${totalInserted} rows inserted, ${totalSkipped} skipped (duplicates)`
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('[seed] Unexpected error:', err);
  process.exit(1);
});
