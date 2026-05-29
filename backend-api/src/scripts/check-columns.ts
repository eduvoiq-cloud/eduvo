/// <reference types="node" />
import 'dotenv/config';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const TABLES = [
  'teacher_assignments',
  'attendance',
  'student_fees',
  'tests',
  'complaints',
  'announcements',
  'notifications',
];

async function main() {
  // Use the Supabase Management API / pg meta endpoint to list columns
  // Alternatively: call a known RPC or use the PostgREST OpenAPI spec
  const res = await fetch(`${SUPABASE_URL}/rest/v1/?select=*`, {
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Accept': 'application/openapi+json',
    },
  });

  if (!res.ok) {
    console.log('OpenAPI failed:', res.status, await res.text());
    return;
  }

  const spec = await res.json() as any;
  const definitions = spec.definitions ?? spec.components?.schemas ?? {};

  for (const table of TABLES) {
    const def = definitions[table];
    if (!def) {
      console.log(`${table}: NOT FOUND in OpenAPI spec`);
      continue;
    }
    const cols = Object.keys(def.properties ?? {});
    console.log(`${table}: ${cols.join(', ')}`);
  }
}

main().catch(console.error);
