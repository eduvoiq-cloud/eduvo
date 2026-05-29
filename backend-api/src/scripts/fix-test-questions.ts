/// <reference types="node" />
import 'dotenv/config';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function main(): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      'apikey':        SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      sql: `ALTER TABLE test_questions ADD COLUMN IF NOT EXISTS type text;`,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Error (${res.status}): ${body}`);
    process.exit(1);
  }

  console.log('Done');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
