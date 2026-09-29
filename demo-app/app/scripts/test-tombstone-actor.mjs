// job_deletes must record WHO (Sept 3). The tombstone is written by the
// trg_jobs_tombstone trigger, so the actor reaches it through a txn-local GUC set
// by the SECURITY DEFINER delete_jobs() RPC (server path), or the JWT org_user_id
// claim (direct browser fallback). Source-shape test over the migration + wiring.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0; const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const mig = read('../supabase/migrations/20260903120000_job_deletes_actor.sql');
ok('🔴 adds the deleted_by column', /add column if not exists deleted_by\b/.test(mig));
ok('  adds deleted_by_tab', /add column if not exists deleted_by_tab\b/.test(mig));
ok('🔴 the trigger reads the server actor GUC', /current_setting\('rfs\.actor_id', true\)/.test(mig));
ok('  and falls back to the JWT app_metadata.org_user_id claim for the direct browser path', /request\.jwt\.claims[\s\S]{0,80}->\s*'app_metadata'\s*->>\s*'org_user_id'/.test(mig));
ok('  the trigger writes deleted_by into job_deletes', /insert into public\.job_deletes[\s\S]{0,200}deleted_by/.test(mig));
ok('🔴 delete_jobs sets the actor GUC then deletes, one txn', /create or replace function public\.delete_jobs[\s\S]{0,400}set_config\('rfs\.actor_id'[\s\S]{0,200}delete from public\.jobs/.test(mig));
ok('  delete_jobs is service_role-only', /grant\s+execute on function public\.delete_jobs\([^)]*\) to service_role/.test(mig) && /revoke execute on function public\.delete_jobs\([^)]*\) from public, anon, authenticated/.test(mig));

const jt = read('api/_lib/jobsTable.js');
ok('🔴 writeJobsDelta deletes via the attributing RPC', /sb\.rpc\('delete_jobs', \{ p_org: ORG_ID, p_ids: chunk, p_actor: orgUserId \|\| null/.test(jt));
ok('  with a graceful fallback when the RPC is not deployed yet', /rpcErr\.code === 'PGRST202' \|\| rpcErr\.code === '42883'[\s\S]{0,160}from\('jobs'\)\.delete\(\)/.test(jt));
ok('  writeJobsDelta accepts orgUserId', /export async function writeJobsDelta\(\{[^}]*orgUserId/.test(jt));

const jd = read('api/state/jobs-delta.js');
ok('🔴 the handler passes the roster id as the actor', /orgUserId: a\.orgUserId \|\| null/.test(jd));

console.log(`\ntombstone actor: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
