import 'dotenv/config';
import { supabaseAdmin } from '../config/supabase';

const CYCLE_ID = '8327ba9a-6e79-4603-a33d-edbd22b53cc7';

async function main() {
  // Also delete dependent rows first (packs and tests reference this cycle)
  const { error: packsErr } = await supabaseAdmin
    .from('recovery_packs')
    .delete()
    .eq('cycle_id', CYCLE_ID);
  if (packsErr) console.warn('packs delete warning:', packsErr.message);
  else console.log('✔ recovery_packs deleted');

  const { error: testsErr } = await supabaseAdmin
    .from('monthly_recovery_tests')
    .delete()
    .eq('cycle_id', CYCLE_ID);
  if (testsErr) console.warn('tests delete warning:', testsErr.message);
  else console.log('✔ monthly_recovery_tests deleted');

  const { error: attemptsErr } = await supabaseAdmin
    .from('recovery_test_attempts')
    .delete()
    .eq('cycle_id', CYCLE_ID);
  if (attemptsErr) console.warn('attempts delete warning:', attemptsErr.message);
  else console.log('✔ recovery_test_attempts deleted');

  const { error: cycleErr } = await supabaseAdmin
    .from('recovery_cycles')
    .delete()
    .eq('id', CYCLE_ID);

  if (cycleErr) {
    console.error('cycle delete error:', cycleErr.message);
    process.exit(1);
  }

  console.log('✅ Cycle deleted. The recovery schedule page will now show "Generate Recovery Pack".');
}

main().catch((e) => { console.error(e); process.exit(1); });
