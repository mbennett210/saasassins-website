// LIVE DATA-OP — take what Google reviews left in the shared org_state record out of it (Daniel,
// 2026-10-20: "Get rid of google reviews it was not part of the original scope of this build
// anyway.").
//
// 🔴 NEVER RUN THIS AGAINST PRODUCTION WITHOUT THE OWNER'S RECORDED GO. A dry run against
//    production is still a production connection. The owner's go is relayed by the orchestrating
//    session and recorded in DATA_AND_SYNC.md §11.
// 🔴 RUN ORDER: right AFTER the deploy that removes Google reviews (the op refuses to run from a
//    tree that still has them: see `stillInCode`). Either order is safe for the data — the old code
//    reads a missing template as "off", a missing matrix row as the code default and a missing
//    `reviews` slice as a zero — but after the deploy nothing on screen ever shows the old rows: the
//    two matrix rows would otherwise sit under "Other" on Settings → Roles (Roles.jsx renders every
//    stored row no group claims).
//
//   node app/scripts/dataop-retire-google-reviews.mjs --state <file.json>   # OFFLINE dry run on a saved blob
//   node app/scripts/dataop-retire-google-reviews.mjs                       # DRY RUN, sandbox env
//   node app/scripts/dataop-retire-google-reviews.mjs --apply               # write, sandbox env
//   CONFIRM_PROD=<prod ref> node --env-file="<main checkout>/app/.env.local" app/scripts/dataop-retire-google-reviews.mjs --prod
//   CONFIRM_PROD=<prod ref> node --env-file="<main checkout>/app/.env.local" app/scripts/dataop-retire-google-reviews.mjs --prod --apply
//
// WHAT IT DOES (one pure plan, planRetireGoogleReviews, which the offline suite pins):
//   · `reminderTemplates`: the review request email and text (RETIRED_MESSAGE_KEYS) are REMOVED —
//     production stores both, switched ON (the approved-messages release added them, 2026-10-20);
//     every other template is untouched;
//   · `permissions`: the `reviews.view` and `reviews.manage` rows (RETIRED_PERMISSION_KEYS) are
//     removed; every other row is untouched;
//   · `userPermissionOverrides`: those two keys are taken out of any grant or revoke (none today);
//     a row left with neither is dropped, as the app prunes one on save;
//   · `users[].notificationPrefs.newGoogleReview` (the retired bell event) is removed where set
//     (none today);
//   · `company.googleReviewUrl` (the review requests' link) is removed where set (absent today);
//   · the retired `reviews` slice (the Reviews page's manual Indeed count) is removed.
// Nothing else changes. A second run is a no-op.
//
// The matrix and the roster are PROTECTED fields, so — as with every operator write to one
// (dataop-om-permission-column.mjs) — the next browser save takes the full protected-field check
// against this run's committed record and raises ONE `org_state.baseline_mismatch` alarm; that save
// stores a fresh digest. `protected_fingerprint` is deliberately left alone (stamping one here would
// launder the write). The deploy itself raises one too (the `reviews` position left the digest);
// run soon after it and the two arrive as one.
//
// GUARD CONTRACT (DATA_AND_SYNC.md §8.2), as dataop-approved-messages.mjs: the shared
// scripts/_lib/liveGuard.mjs names the target before the first read and refuses the production ref
// without --prod AND CONFIRM_PROD; dry run is the default; a gitignored backup lands before the
// write; the version predicate rides ON the update; the row is READ BACK; a second run is a no-op.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CUSTOMER_MESSAGES } from '../src/lib/customerMessages.js';
import { PERMISSIONS } from '../src/lib/roles.js';
import { MAX_STATE_BYTES } from '../api/_lib/blobBudget.js';
import { PROD_REF, ENV_DEFAULT, ENV_PROD, liveTarget, refuseTarget, printTarget, loadEnv } from './_lib/liveGuard.mjs';

export const OP_NAME = 'dataop-retire-google-reviews';
export { PROD_REF };

// What Google reviews left in the record. The code no longer names any of it (that is the point),
// so these are the stored names, written once, here.
export const RETIRED_MESSAGE_KEYS = Object.freeze(['review_request', 'review_request_sms']);
export const RETIRED_PERMISSION_KEYS = Object.freeze(['reviews.view', 'reviews.manage']);
export const RETIRED_NOTIFICATION_EVENT = 'newGoogleReview';
export const RETIRED_COMPANY_FIELDS = Object.freeze(['googleReviewUrl']);
export const RETIRED_SLICES = Object.freeze(['reviews']);

const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

// The op runs only from a tree that has removed Google reviews: if the catalog still carries a
// review request, or the matrix still defines a reviews key, the code would put them straight back
// (or keep reading them), so the op refuses.
export function stillInCode() {
  const messages = CUSTOMER_MESSAGES.filter((m) => RETIRED_MESSAGE_KEYS.includes(m.key)).map((m) => m.key);
  const permissions = RETIRED_PERMISSION_KEYS.filter((k) => k in PERMISSIONS);
  return [...messages, ...permissions];
}

// PURE. The whole plan from the stored blob.
//   → { state (the next blob), removed: { templates: [{ id, key, enabled }], permissions: [id],
//       overrides: [{ userId, keys }], notificationPrefs: [userId], companyFields: [name],
//       slices: [name] }, changed }
export function planRetireGoogleReviews(state) {
  const s = state && typeof state === 'object' ? state : {};
  const removed = { templates: [], permissions: [], overrides: [], notificationPrefs: [], companyFields: [], slices: [] };
  const next = { ...s };

  if (Array.isArray(s.reminderTemplates)) {
    const keep = [];
    for (const t of s.reminderTemplates) {
      if (t && RETIRED_MESSAGE_KEYS.includes(t.key)) removed.templates.push({ id: t.id, key: t.key, enabled: t.enabled === true });
      else keep.push(t);
    }
    if (removed.templates.length) next.reminderTemplates = keep;
  }

  if (Array.isArray(s.permissions)) {
    const keep = [];
    for (const p of s.permissions) {
      if (p && RETIRED_PERMISSION_KEYS.includes(p.id)) removed.permissions.push(p.id);
      else keep.push(p);
    }
    if (removed.permissions.length) next.permissions = keep;
  }

  if (Array.isArray(s.userPermissionOverrides)) {
    let touched = false;
    const rows = [];
    for (const o of s.userPermissionOverrides) {
      const named = [...(o?.grants || []), ...(o?.revokes || [])].filter((k) => RETIRED_PERMISSION_KEYS.includes(k));
      if (!o || !named.length) { rows.push(o); continue; }
      touched = true;
      removed.overrides.push({ userId: o.userId, keys: [...new Set(named)] });
      const grants = (o.grants || []).filter((k) => !RETIRED_PERMISSION_KEYS.includes(k));
      const revokes = (o.revokes || []).filter((k) => !RETIRED_PERMISSION_KEYS.includes(k));
      if (grants.length || revokes.length) rows.push({ ...o, grants, revokes });
    }
    if (touched) next.userPermissionOverrides = rows;
  }

  if (Array.isArray(s.users)) {
    let touched = false;
    const users = s.users.map((u) => {
      if (!u?.notificationPrefs || typeof u.notificationPrefs !== 'object' || !(RETIRED_NOTIFICATION_EVENT in u.notificationPrefs)) return u;
      touched = true;
      removed.notificationPrefs.push(u.id);
      const { [RETIRED_NOTIFICATION_EVENT]: _gone, ...prefs } = u.notificationPrefs;
      return { ...u, notificationPrefs: prefs };
    });
    if (touched) next.users = users;
  }

  if (s.company && typeof s.company === 'object') {
    const fields = RETIRED_COMPANY_FIELDS.filter((f) => f in s.company);
    if (fields.length) {
      const company = { ...s.company };
      for (const f of fields) delete company[f];
      next.company = company;
      removed.companyFields.push(...fields);
    }
  }

  for (const k of RETIRED_SLICES) {
    if (k in next) { delete next[k]; removed.slices.push(k); }
  }

  const changed = Object.values(removed).some((list) => list.length > 0);
  return { state: next, removed, changed };
}

// ── the transports (as dataop-approved-messages.mjs) ─────────────────────────
export function pgTransport(client) {
  return {
    readOrgState: async (org) => {
      const { rows } = await client.query('select state, version from public.org_state where organization_id = $1', [org]);
      return rows[0] ? { state: rows[0].state, version: Number(rows[0].version) } : null;
    },
    casWrite: async ({ org, baseVersion, state }) => {
      const { rows } = await client.query(
        'update public.org_state set state = $1::jsonb, version = version + 1, updated_at = now(),'
        + ' updated_via = $2, updated_by = null, updated_by_build = null, updated_by_tab = $3'
        + ' where organization_id = $4 and version = $5 returning version',
        [state, `script:${OP_NAME}`, `script:${OP_NAME}`, org, baseVersion]);
      return rows;
    },
  };
}
export function supabaseTransport(db) {
  return {
    readOrgState: async (org) => {
      const { data, error } = await db.from('org_state').select('state, version').eq('organization_id', org).maybeSingle();
      if (error) throw new Error(`org_state read failed: ${error.message}`);
      return data ? { state: data.state, version: Number(data.version) } : null;
    },
    casWrite: async ({ org, baseVersion, state, nowIso }) => {
      const { data, error } = await db.from('org_state').update({
        state, version: (baseVersion || 0) + 1, updated_at: nowIso,
        updated_via: `script:${OP_NAME}`, updated_by: null, updated_by_build: null, updated_by_tab: `script:${OP_NAME}`,
      }).eq('organization_id', org).eq('version', baseVersion).select('version');
      if (error) throw new Error(error.message);
      return data || [];
    },
  };
}
// OFFLINE: a saved blob ({ version, state } or a bare state) — reads only; a write is refused.
export function fileTransport(path) {
  return {
    readOrgState: async () => {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      return raw && raw.state ? { state: raw.state, version: Number(raw.version || 0) } : { state: raw, version: 0 };
    },
    casWrite: async () => { throw new Error('an offline run never writes'); },
  };
}

// ── the op ───────────────────────────────────────────────────────────────────
export async function runRetireGoogleReviewsOp({
  t, org, apply = false, now = new Date(), backupDir = new URL('./', import.meta.url),
  log = console.log, err = console.error, inCode = stillInCode,
} = {}) {
  const live = inCode();
  if (live.length) { err(`Refusing: this tree still has Google reviews (${live.join(', ')}). Run the op from the tree that removed them, after its deploy.`); return 1; }
  let snap;
  try { snap = await t.readOrgState(org); } catch (e) { err(e.message); return 1; }
  if (!snap?.state) { err('org_state not initialized for this org.'); return 1; }
  const plan = planRetireGoogleReviews(snap.state);
  const r = plan.removed;
  log(`  org_state         : v${snap.version}, ${(snap.state.reminderTemplates || []).length} stored template(s)`);
  log(`  templates removed : ${r.templates.length ? r.templates.map((x) => `${x.key} (${x.id}, ${x.enabled ? 'on' : 'off'})`).join(', ') : 'none stored'}`);
  log(`  matrix rows       : ${r.permissions.length ? r.permissions.join(', ') : 'none stored'}`);
  log(`  overrides         : ${r.overrides.length ? r.overrides.map((o) => `${o.userId} (${o.keys.join(', ')})`).join('; ') : 'none name them'}`);
  log(`  bell preferences  : ${r.notificationPrefs.length ? `${r.notificationPrefs.length} member(s) carry ${RETIRED_NOTIFICATION_EVENT}` : 'none carry it'}`);
  log(`  company fields    : ${r.companyFields.length ? r.companyFields.join(', ') : 'none set'}`);
  log(`  retired slices    : ${r.slices.length ? r.slices.map((k) => `${k} ${JSON.stringify(snap.state[k])}`).join(', ') : 'none present'}`);
  if (!plan.changed) { log('\n✓ Nothing of Google reviews is stored. No-op.\n'); return 0; }
  if (!apply) { log('\n--dry-run (the default): nothing written. Re-run with --apply to arm.\n'); return 0; }

  const bytes = Buffer.byteLength(JSON.stringify(plan.state), 'utf8');
  if (bytes > MAX_STATE_BYTES) { err(`Refusing: the result is ${Math.round(bytes / 1024)} KB, over the ${Math.round(MAX_STATE_BYTES / 1024)} KB ceiling.`); return 1; }
  const nowIso = now.toISOString();
  const backupName = `orgstate-backup-${nowIso.replace(/[:.]/g, '-')}.json`;
  writeFileSync(new URL(`./${backupName}`, backupDir), JSON.stringify({ version: snap.version, state: snap.state }));
  JSON.parse(readFileSync(new URL(`./${backupName}`, backupDir), 'utf8'));
  let wrote;
  try { wrote = await t.casWrite({ org, baseVersion: snap.version, state: plan.state, nowIso }); } catch (e) { err(`Write failed: ${e.message}`); return 1; }
  if (!wrote || !wrote.length) { err('CAS conflict — org_state changed under me. Nothing written; re-run.'); return 1; }
  let back;
  try { back = await t.readOrgState(org); } catch (e) { err(`read-back failed: ${e.message}. The write committed; re-run the dry run to check, backup app/scripts/${backupName}.`); return 1; }
  const again = planRetireGoogleReviews(back?.state || {});
  if (!back || back.version !== snap.version + 1 || canonical(back.state) !== canonical(plan.state) || again.changed) {
    err(`read-back does not match the write (read v${back?.version ?? '?'}, expected v${snap.version + 1}). Restore from app/scripts/${backupName} if needed.`);
    return 1;
  }
  log(`\n✓ org_state v${snap.version} → ${back.version}: nothing of Google reviews is stored. Read back: nothing left to do.`);
  log(`  Backup: app/scripts/${backupName}\n`);
  return 0;
}

// ── live section ─────────────────────────────────────────────────────────────
const isMain = !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const argv = process.argv.slice(2);
  const APPLY = argv.includes('--apply');
  const PROD = argv.includes('--prod');
  const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const ORG = process.env.CLEANSPACE_ORG_ID || '00000000-0000-0000-0000-000000000001';
  const file = at('--state');
  if (file) {
    if (APPLY) { console.error('An offline run (--state) never writes; drop --apply.'); process.exitCode = 1; } else {
      console.log(`\n── ${OP_NAME} (OFFLINE dry run on ${file}) ─────────────────────────`);
      process.exitCode = await runRetireGoogleReviewsOp({ t: fileTransport(file), org: ORG, apply: false });
    }
  } else {
    const envFile = PROD ? ENV_PROD : ENV_DEFAULT;
    const loaded = loadEnv(envFile, import.meta.url);
    const { transport, ref } = liveTarget(process.env);
    const refusal = transport && refuseTarget({ transport, ref, prod: PROD, confirmProd: process.env.CONFIRM_PROD });
    if (!transport) {
      console.error(`Missing SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_DB_URL (looked in app/${envFile.replace('../', '')}${loaded ? '' : ' — file not found'}).`);
      process.exitCode = 1;
    } else if (refusal) {
      console.error(refusal);
      process.exitCode = 1;
    } else {
      printTarget({ op: OP_NAME, ref: ref || '(unknown)', org: ORG, transport, apply: APPLY, envLabel: loaded ? `app/${envFile.replace('../', '')}` : 'the preloaded environment' });
      if (transport === 'pg') {
        const { default: pg } = await import('pg');
        const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
        try {
          await client.connect();   // once: a failed password is never retried
          process.exitCode = await runRetireGoogleReviewsOp({ t: pgTransport(client), org: ORG, apply: APPLY });
        } catch (e) {
          console.error('connect failed:', e.message);
          process.exitCode = 1;
        } finally { await client.end().catch(() => {}); }
      } else {
        const { createClient } = await import('@supabase/supabase-js');
        const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
        process.exitCode = await runRetireGoogleReviewsOp({ t: supabaseTransport(db), org: ORG, apply: APPLY });
      }
    }
  }
}
