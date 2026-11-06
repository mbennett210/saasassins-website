// The guard EVERY live data-op runs before it touches anything — DATA_AND_SYNC.md §8.2, in
// the direction CS-025 names (one implementation, not one per script).
//
// It answers three questions, all as VALUES, so a suite can prove them with no socket open:
//   · which transport does this environment offer, and what is it pointed at?  liveTarget
//   · may this run proceed at all?                                             refuseTarget
//   · what is it pointed at, said out loud before the first read?              printTarget
//
// The other two rules of §8.2 — a dry run is the DEFAULT, and a backup lands before any
// write — belong to each op's own body, because only the op knows what it would write.
//
// 🔴 IT NEVER OPENS ANYTHING. No driver import, no credential handling beyond reading names
// out of an env file. A refused run must make no query at all, which is only true if the
// refusal is decided before a driver is even imported.
import { readFileSync } from 'node:fs';

// The production project ref DATA_AND_SYNC.md §8.2 names in the CONFIRM_PROD contract.
export const PROD_REF = 'nvsbknowpkmhrzbkcwxs';
// Resolved by each op against ITS OWN import.meta.url, so both land on app/.env*.
export const ENV_DEFAULT = '../.env.sandbox.local';
export const ENV_PROD = '../.env.local';

// The project ref out of a Postgres connection string, without ever handling the password:
// the pooler carries it in the USERNAME (`postgres.<ref>`), the direct host in the HOST
// (`db.<ref>.supabase.co`). Anything else is unknown — and an unknown ref cannot be
// compared with PROD_REF, so `refuseTarget` refuses it rather than assume it is harmless.
export function refFromDbUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/^[a-z][a-z0-9+.-]*:\/\/(.*)$/i);
  if (!m) return null;
  // The LAST '@' splits userinfo from host: a password may legally contain one.
  const at = m[1].lastIndexOf('@');
  if (at < 0) return null;
  const user = m[1].slice(0, at).split(':')[0];
  const host = m[1].slice(at + 1).split(/[:/?]/)[0];
  const pooler = user.match(/^postgres\.([a-z0-9]+)$/i);
  if (pooler) return pooler[1].toLowerCase();
  const direct = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  return direct ? direct[1].toLowerCase() : null;
}

// Which live transport the environment offers, and what it is pointed at. The service-role
// pair wins whenever it is present; a bare SUPABASE_DB_URL takes the Postgres path (some
// machines hold only that connection string, which apply-migration.mjs already runs on).
export function liveTarget(env = process.env) {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    return { transport: 'supabase', ref: (env.SUPABASE_URL.match(/https:\/\/([a-z0-9]+)\./) || [])[1] || null };
  }
  if (env.SUPABASE_DB_URL) return { transport: 'pg', ref: refFromDbUrl(env.SUPABASE_DB_URL) };
  return { transport: null, ref: null };
}

// §8.2 rule 3 as a VALUE — the reason to refuse, or null to proceed. Decided before a driver
// is imported or a socket is opened, so a refused run makes no query at all.
export function refuseTarget({ transport, ref, prod, confirmProd }) {
  if (transport === 'pg' && !ref) {
    return '\n⛔ REFUSING: could not read the project ref from SUPABASE_DB_URL.\n'
      + '   Expected postgres.<ref>@… (pooler) or …@db.<ref>.supabase.co (direct).\n'
      + '   An unknown ref cannot be checked against the production ref, so it is refused.\n';
  }
  if (ref === PROD_REF && !(prod && confirmProd === PROD_REF)) {
    return `\n⛔ REFUSING the production ref ${ref}.\n`
      + `   Production needs BOTH --prod and CONFIRM_PROD=${PROD_REF} in the environment,\n`
      + "   plus the owner's go recorded in docs/playbook/DATA_AND_SYNC.md §11.\n";
  }
  return null;
}

// §8.2 rule 2 — printed BEFORE the first read, so a failed read still names what the run
// was pointed at. The ref and the org, never the credential that carried them.
// `org` is omitted by a caller that has none — a DDL migration touches the whole project,
// not one org — and the line is then left out rather than printed as "undefined".
export function printTarget({ op = '', ref, org = null, envLabel, transport, apply, log = console.log }) {
  log(`\n── ${op} ${apply ? '(ARMED)' : '(dry run)'} ─────────────────────────`);
  log(`  credentials  : ${envLabel}`);
  log(`  transport    : ${transport === 'pg' ? 'postgres (SUPABASE_DB_URL)' : 'supabase-js (service role)'}`);
  log(`  Supabase ref : ${ref}${ref === PROD_REF ? '  ⚠ PRODUCTION' : ''}`);
  if (org) log(`  org id       : ${org}`);
}

// Read an env file into process.env WITHOUT overwriting what is already there — a run
// started with `node --env-file=<checkout>/app/.env.local …` already carries the credential
// and this read simply finds nothing (a worktree has no env file of its own). Returns
// whether a file was read, so the op can say which credentials it used.
export function loadEnv(envFile, baseUrl) {
  try {
    for (const line of readFileSync(new URL(envFile, baseUrl), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    return true;
  } catch { return false; }
}
