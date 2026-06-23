/**
 * benchmark-gemini.ts
 *
 * Runs the same question-generation prompt against three Gemini models
 * and prints a side-by-side speed + quality report.
 *
 * Usage:
 *   npx ts-node src/scripts/benchmark-gemini.ts
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Load .env from backend-api root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ── Config ────────────────────────────────────────────────────────────────────

const MODELS = [
  { id: 'gemini-2.5-flash',    label: 'Gemini 2.5 Flash (current)' },
  { id: 'gemini-2.0-flash',    label: 'Gemini 2.0 Flash'           },
  { id: 'gemini-1.5-flash-8b', label: 'Gemini Flash Lite (1.5-8b)' },
];

// A realistic sample passage — same text for all three models so the comparison is fair.
const SAMPLE_CONTENT = `
Photosynthesis is the process by which green plants, algae, and some bacteria convert
light energy (usually from the sun) into chemical energy stored in glucose. This process
takes place mainly in the chloroplasts, which contain the green pigment chlorophyll.

The overall equation for photosynthesis is:
  6CO2 + 6H2O + light energy → C6H12O6 + 6O2

Photosynthesis occurs in two main stages:
1. Light-dependent reactions (in the thylakoid membranes): Light energy splits water
   molecules, releasing oxygen as a by-product and producing ATP and NADPH.
2. Light-independent reactions / Calvin cycle (in the stroma): ATP and NADPH are used
   to fix carbon dioxide into glucose through a series of enzyme-controlled reactions.

Factors that affect the rate of photosynthesis include light intensity, carbon dioxide
concentration, temperature, and the availability of water. At very high temperatures,
enzymes denature and photosynthesis slows or stops.
`.trim();

const MCQ_COUNT    = 3;
const THEORY_COUNT = 2;
const SUBJECT      = 'Biology';
const CLASS_LEVEL  = 'Class 10';
const DIFFICULTY   = 'medium';

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPrompt(): string {
  return `<content>
${SAMPLE_CONTENT}
</content>

Subject: ${SUBJECT}
Class: ${CLASS_LEVEL}
Difficulty: ${DIFFICULTY}
Generate ${MCQ_COUNT} MCQ questions and ${THEORY_COUNT} theory questions based on the content above.
Return this exact JSON structure:
{
  "mcq_questions": [
    {
      "question": "question text",
      "option_a": "option text",
      "option_b": "option text",
      "option_c": "option text",
      "option_d": "option text",
      "correct_option": "a",
      "marks": 1
    }
  ],
  "theory_questions": [
    {
      "question": "question text",
      "expected_answer": "brief answer guide for teacher",
      "marks": 5
    }
  ]
}`;
}

const SYSTEM_INSTRUCTION = [
  'You are an experienced teacher creating exam questions.',
  'Generate questions ONLY based on the provided content.',
  'Do NOT add information not present in the content.',
  'Do NOT hallucinate facts.',
  'Return ONLY valid JSON. No markdown, no explanation.',
].join('\n');

interface BenchmarkResult {
  model:          string;
  label:          string;
  durationSec:    number;
  tokensUsed:     number;
  mcqCount:       number;
  theoryCount:    number;
  parseOk:        boolean;
  error?:         string;
  questions?:     Record<string, unknown>;
}

async function runModel(modelId: string, label: string, apiKey: string): Promise<BenchmarkResult> {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`▶  Testing: ${label}`);
  console.log(`   Model ID: ${modelId}`);
  console.log(`${'─'.repeat(60)}`);

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelId,
    systemInstruction: SYSTEM_INSTRUCTION,
    generationConfig: {
      responseMimeType: 'application/json',
    },
  });

  const prompt = buildPrompt();
  const t0 = performance.now();

  let responseText = '';
  let tokensUsed   = 0;

  try {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    const t1 = performance.now();
    responseText = result.response.text().trim();
    tokensUsed   = result.response.usageMetadata?.totalTokenCount ?? 0;

    const durationSec = (t1 - t0) / 1000;
    console.log(`   ⏱  Response time : ${durationSec.toFixed(3)}s`);
    console.log(`   🔢 Tokens used   : ${tokensUsed}`);

    // Parse JSON
    let parsed: Record<string, unknown>;
    try {
      const jsonText = responseText
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
      parsed = JSON.parse(jsonText) as Record<string, unknown>;
    } catch {
      console.log(`   ❌ JSON parse FAILED`);
      console.log(`   Raw response snippet: ${responseText.slice(0, 200)}`);
      return { model: modelId, label, durationSec, tokensUsed, mcqCount: 0, theoryCount: 0, parseOk: false, error: 'JSON parse failed' };
    }

    const mcqs    = Array.isArray(parsed.mcq_questions)    ? (parsed.mcq_questions    as unknown[]).length : 0;
    const theories = Array.isArray(parsed.theory_questions) ? (parsed.theory_questions as unknown[]).length : 0;

    console.log(`   ✅ Parse OK — MCQs: ${mcqs}, Theory: ${theories}`);

    // Print sample question
    if (mcqs > 0) {
      const q = (parsed.mcq_questions as Array<Record<string, unknown>>)[0];
      console.log(`\n   Sample MCQ:`);
      console.log(`     Q: ${q.question}`);
      console.log(`     A) ${q.option_a}  B) ${q.option_b}`);
      console.log(`     C) ${q.option_c}  D) ${q.option_d}`);
      console.log(`     Correct: ${String(q.correct_option).toUpperCase()}`);
    }
    if (theories > 0) {
      const q = (parsed.theory_questions as Array<Record<string, unknown>>)[0];
      console.log(`\n   Sample Theory:`);
      console.log(`     Q: ${q.question}`);
      console.log(`     Expected: ${String(q.expected_answer).slice(0, 120)}...`);
    }

    return { model: modelId, label, durationSec, tokensUsed, mcqCount: mcqs, theoryCount: theories, parseOk: true, questions: parsed };

  } catch (err) {
    const t1 = performance.now();
    const durationSec = (t1 - t0) / 1000;
    const message = err instanceof Error ? err.message : String(err);
    console.log(`   ❌ API ERROR: ${message}`);
    return { model: modelId, label, durationSec, tokensUsed, mcqCount: 0, theoryCount: 0, parseOk: false, error: message };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('❌  GEMINI_API_KEY not found in .env');
    process.exit(1);
  }

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║        GEMINI MODEL BENCHMARK — EduVo Question Gen        ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`\nContent: ${SAMPLE_CONTENT.split('\n')[0].slice(0, 60)}...`);
  console.log(`Config : ${MCQ_COUNT} MCQs + ${THEORY_COUNT} Theory | ${DIFFICULTY} | ${SUBJECT} ${CLASS_LEVEL}`);
  console.log(`Models : ${MODELS.length} (run sequentially to avoid rate limits)`);

  const results: BenchmarkResult[] = [];

  for (const { id, label } of MODELS) {
    const result = await runModel(id, label, apiKey);
    results.push(result);
    // Small pause between calls to be kind to rate limits
    if (id !== MODELS[MODELS.length - 1].id) {
      console.log('\n   Waiting 3s before next model...');
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // ── Summary table ─────────────────────────────────────────────────────────
  console.log('\n\n');
  console.log('╔═══════════════════════════════════════════════════════════════════════════╗');
  console.log('║                        BENCHMARK SUMMARY                                 ║');
  console.log('╠═══════════════════╦════════════╦══════════════╦═══════════╦══════════════╣');
  console.log('║ Model             ║ Time (sec) ║ Tokens Used  ║ Questions ║ Parse OK?    ║');
  console.log('╠═══════════════════╬════════════╬══════════════╬═══════════╬══════════════╣');

  for (const r of results) {
    const name     = r.label.padEnd(17).slice(0, 17);
    const time     = r.durationSec.toFixed(3).padStart(10);
    const tokens   = String(r.tokensUsed).padStart(12);
    const qCount   = `${r.mcqCount}M+${r.theoryCount}T`.padStart(9);
    const parseOk  = (r.parseOk ? '✅ Yes' : `❌ ${(r.error ?? '').slice(0, 8)}`).padEnd(12);
    console.log(`║ ${name} ║ ${time} ║ ${tokens} ║ ${qCount} ║ ${parseOk} ║`);
  }

  console.log('╚═══════════════════╩════════════╩══════════════╩═══════════╩══════════════╝');

  // Fastest
  const successful = results.filter(r => r.parseOk);
  if (successful.length > 0) {
    const fastest  = successful.reduce((a, b) => a.durationSec < b.durationSec ? a : b);
    const slowest  = successful.reduce((a, b) => a.durationSec > b.durationSec ? a : b);
    console.log(`\n🏆 Fastest : ${fastest.label} (${fastest.durationSec.toFixed(3)}s)`);
    console.log(`🐢 Slowest : ${slowest.label} (${slowest.durationSec.toFixed(3)}s)`);
    if (fastest.durationSec > 0) {
      const speedup = slowest.durationSec / fastest.durationSec;
      console.log(`⚡ Speedup : ${speedup.toFixed(1)}× faster`);
    }
  }

  console.log('\nDone. Check sample questions above to assess quality.\n');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
