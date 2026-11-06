// LIVE DATA-OP — switch on Matt's approved customer messages in the shared org_state record
// (the release of docs/plans/2026-10-19-approved-messages.md, step 3).
//
// 🔴 NEVER RUN THIS AGAINST PRODUCTION WITHOUT THE OWNER'S RECORDED GO. A dry run against
//    production is still a production connection. The owner's go is relayed by the orchestrating
//    session and recorded in DATA_AND_SYNC.md §11.
// 🔴 RUN ORDER (the plan's release): 1. back up org_state and apply
//    supabase/migrations/20261019120000_customer_messages.sql; 2. push, and check the deploy, CI and
//    that the sample-record guard is live (api/_lib/customerMessages/send.js); 3. THIS op. Switched
//    on before the code that reads it is live, the OLD cron would send the four old templates with
//    no guard and no sent-log table.
//
//   node app/scripts/dataop-approved-messages.mjs --state <file.json>      # OFFLINE dry run on a saved blob
//   node app/scripts/dataop-approved-messages.mjs                          # DRY RUN, sandbox env
//   node app/scripts/dataop-approved-messages.mjs --apply                  # write, sandbox env
//   CONFIRM_PROD=<prod ref> node --env-file="<main checkout>/app/.env.local" app/scripts/dataop-approved-messages.mjs --prod
//   CONFIRM_PROD=<prod ref> node --env-file="<main checkout>/app/.env.local" app/scripts/dataop-approved-messages.mjs --prod --apply
//   …add --keep-off <key,key> to leave named messages OFF (e.g. the new-customer messages while
//   Matt's team is typing in the existing book: service_setup,booking_confirmation,post_service,upsell).
//
// WHAT IT DOES (one pure plan, planApprovedMessages, which the offline suite pins):
//   · every message the catalog has a trigger for (src/lib/customerMessages.js, `built`) gets its
//     template in `reminderTemplates`: a template already stored keeps its WORDS (the office may
//     have edited them) and is switched ON; a missing one is ADDED from the catalog's defaults
//     (Matt's approved wording) with the same id the seed uses (templateIdFor), switched ON;
//   · `--keep-off` names messages left (or switched) OFF instead;
//   · the welcome email keeps its switch (off: it has no trigger). Its WORDS follow the catalog's —
//     Matt's own wording from his Drafts note, 2026-10-20 — only while the stored subject and body
//     are, word for word, one of the defaults the app shipped before (WELCOME_EARLIER_DEFAULTS):
//     then nobody edited them, so moving them is not overriding the office. Words the office edited
//     are left as they are ('reword-skipped-edited'). Production holds the 2026-09-02 seed wording
//     (read 2026-10-20: "…as a Clean Space client…", byte-identical to it);
//   · every other template is untouched; no other slice changes, except that the retired
//     `reminderEvents` key is removed (its dedupe moved to the customer_messages table; nothing
//     reads it).
// With all 13 customers still sample records nothing sends: the run refuses every one of them.
//
// 🔴 AFTER THE RELEASE (it ran 2026-10-20 04:32: v643 → v644, 22 of 26 on, four held off on Daniel's
// call — DATA_AND_SYNC.md §11) the op only ADDS what is not stored yet (`releaseRan`): every stored
// template keeps its switch, whatever the flags, so a follow-up re-run cannot switch the four held
// messages on or undo a switch the office moved in Settings. The follow-up it exists for: the
// walkthrough confirmation (2026-10-20, deals now record the walkthrough's date and time), added ON
// because Matt approved it; `--keep-off walkthrough_confirm` adds it off instead. A second run is a
// no-op.
//
// GUARD CONTRACT (DATA_AND_SYNC.md §8.2), as dataop-om-permission-column.mjs: the shared
// scripts/_lib/liveGuard.mjs names the target before the first read and refuses the production
// ref without --prod AND CONFIRM_PROD; dry run is the default; a gitignored backup lands before the
// write; the version predicate rides ON the update; the row is READ BACK; a second run is a no-op.
// `reminderTemplates` is not a protected field, so no baseline alarm follows.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CUSTOMER_MESSAGES, MESSAGE_BY_KEY, MESSAGE_KEY, LEGACY_TEMPLATE_IDS, defaultTemplate } from '../src/lib/customerMessages.js';
import { IDENTITY } from '../src/brand/identity.generated.js';
import { MAX_STATE_BYTES } from '../api/_lib/blobBudget.js';
import { PROD_REF, ENV_DEFAULT, ENV_PROD, liveTarget, refuseTarget, printTarget, loadEnv } from './_lib/liveGuard.mjs';

export const OP_NAME = 'dataop-approved-messages';
export { PROD_REF };

// The messages this op switches on: every one with a trigger (approved = on).
export const APPROVED_KEYS = Object.freeze(CUSTOMER_MESSAGES.filter((m) => m.built).map((m) => m.key));

// Every welcome-email wording the app shipped before Matt's (the history of src/data/seed.js and
// src/lib/customerMessages.js), as the brand file renders them: a stored welcome template holding
// one of these, subject AND body, was never edited.
export const WELCOME_EARLIER_DEFAULTS = Object.freeze([
  // the first seed (to 12185f57's parent): an em dash, the name and phone written out
  { subject: `Welcome to ${IDENTITY.name}`, body: `Hi {client_contact},\n\nWelcome aboard — we're glad to have {company} as a ${IDENTITY.name} client. You'll receive a confirmation the day before each cleaning, and we'll check in after your first visit.\n\nQuestions? Reply to this email or call us at ${IDENTITY.company.phone}.\n\n— The ${IDENTITY.name} team` },
  // 12185f57 (2026-09-02, the em-dash sweep): production's stored wording
  { subject: `Welcome to ${IDENTITY.name}`, body: `Hi {client_contact},\n\nWelcome aboard. We're glad to have {company} as a ${IDENTITY.name} client. You'll receive a confirmation the day before each cleaning, and we'll check in after your first visit.\n\nQuestions? Reply to this email or call us at ${IDENTITY.company.phone}.\n\nThe ${IDENTITY.name} team` },
  // 42b04791 / b0283106 (2026-09-25, CS-387: the brand named once)
  { subject: `Welcome to ${IDENTITY.name}`, body: `Hi {client_contact},\n\nWelcome aboard. We're glad to have you as a client. You'll receive a confirmation the day before each cleaning, and we'll check in after your first visit.\n\nQuestions? Reply to this email or call us at ${IDENTITY.company.phone}.\n\nThe ${IDENTITY.name} team` },
  // b690ba06 (2026-10-19, the one catalog): the same words as tokens
  { subject: 'Welcome to {company}', body: "Hi {client_contact},\n\nWelcome aboard. We're glad to have you as a client. You'll receive a confirmation the day before each cleaning, and we'll check in after your first visit.\n\nQuestions? Reply to this email or call us at {company_phone}.\n\nThe {company} team" },
]);
const isEarlierWelcome = (t) => WELCOME_EARLIER_DEFAULTS.some((d) => t?.subject === d.subject && t?.body === d.body);

const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

// Has the release already run on this blob? It has once a template only the catalog brought is
// stored (an `rt_<key>` one, not one of the five that predate it): the release added 22 of them.
// From then on every stored switch is the office's (Settings → Customer Reminders) or Daniel's
// hold, and a re-run never moves one.
export function releaseRan(state) {
  const stored = Array.isArray(state?.reminderTemplates) ? state.reminderTemplates : [];
  return stored.some((t) => t && MESSAGE_BY_KEY[t.key] && !(t.key in LEGACY_TEMPLATE_IDS));
}

// PURE. The whole plan from the stored blob.
//   → { state (the next blob), rows: [{ key, action: 'add'|'add-off'|'switch-on'|'already-on'|'keep-off'|'switch-off'|'left'
//         |'reword'|'reword-skipped-edited' }],
//       dropped: { reminderEvents: n }, changed, unknownKeepOff: [], released }
// BEFORE the release: every approved template is switched on (or kept off), and missing ones added.
// AFTER it (a follow-up, such as the walkthrough confirmation on 2026-10-20): only the approved
// messages not stored yet are added (on, or off with --keep-off); every stored template is left
// exactly as it is ('already-on', or 'left' when it is off), so a re-run that forgets the release's
// --keep-off cannot switch Daniel's four held messages on, nor undo a switch the office moved.
export function planApprovedMessages(state, { keepOff = [] } = {}) {
  const off = new Set(keepOff);
  const unknownKeepOff = [...off].filter((k) => !APPROVED_KEYS.includes(k));
  const stored = Array.isArray(state?.reminderTemplates) ? state.reminderTemplates : [];
  const byKey = new Map(stored.map((t) => [t?.key, t]));
  const released = releaseRan(state);
  const rows = [];
  const welcome = MESSAGE_BY_KEY[MESSAGE_KEY.welcome];
  const next = stored.map((t) => {
    if (t && t.key === MESSAGE_KEY.welcome) {
      // Its switch is never touched; its words follow Matt's only while nobody edited them.
      if (t.subject === welcome.subject && t.body === welcome.body) return t;
      if (isEarlierWelcome(t)) { rows.push({ key: t.key, action: 'reword' }); return { ...t, subject: welcome.subject, body: welcome.body }; }
      rows.push({ key: t.key, action: 'reword-skipped-edited' });
      return t;
    }
    if (!t || !APPROVED_KEYS.includes(t.key)) return t;             // anything else: untouched
    if (released) { rows.push({ key: t.key, action: t.enabled === true ? 'already-on' : 'left' }); return t; }
    const want = !off.has(t.key);
    if ((t.enabled === true) === want) { rows.push({ key: t.key, action: want ? 'already-on' : 'keep-off' }); return t; }
    rows.push({ key: t.key, action: want ? 'switch-on' : 'switch-off' });
    return { ...t, enabled: want };
  });
  for (const key of APPROVED_KEYS) {
    if (byKey.has(key)) continue;
    const t = { ...defaultTemplate(MESSAGE_BY_KEY[key]), enabled: !off.has(key) };
    next.push(t);
    rows.push({ key, action: t.enabled ? 'add' : 'add-off' });
  }
  const dropped = { reminderEvents: Array.isArray(state?.reminderEvents) ? state.reminderEvents.length : (state && 'reminderEvents' in state ? 0 : null) };
  const nextState = { ...state, reminderTemplates: next };
  if (nextState && 'reminderEvents' in nextState) delete nextState.reminderEvents;
  const changed = rows.some((r) => ['add', 'add-off', 'switch-on', 'switch-off', 'reword'].includes(r.action)) || dropped.reminderEvents !== null;
  return { state: nextState, rows, dropped, changed, unknownKeepOff, released };
}

// ── the transports (as dataop-om-permission-column.mjs) ──────────────────────
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
export async function runApprovedMessagesOp({
  t, org, apply = false, keepOff = [], now = new Date(), backupDir = new URL('./', import.meta.url),
  log = console.log, err = console.error,
} = {}) {
  let snap;
  try { snap = await t.readOrgState(org); } catch (e) { err(e.message); return 1; }
  if (!snap?.state) { err('org_state not initialized for this org.'); return 1; }
  const plan = planApprovedMessages(snap.state, { keepOff });
  if (plan.unknownKeepOff.length) { err(`Refusing: --keep-off names no approved message: ${plan.unknownKeepOff.join(', ')} (the keys are ${APPROVED_KEYS.join(', ')}).`); return 1; }
  const stored = (snap.state.reminderTemplates || []).length;
  log(`  org_state    : v${snap.version}, ${stored} stored template(s), ${APPROVED_KEYS.length} approved messages`);
  log('');
  const count = (a) => plan.rows.filter((r) => r.action === a).length;
  for (const r of plan.rows) log(`   · ${String(r.key).padEnd(24)} ${r.action}`);
  log('');
  log(`  added ${count('add')} on, ${count('add-off')} off · switched on ${count('switch-on')} · switched off ${count('switch-off')} · already on ${count('already-on')} · kept off ${count('keep-off')} · left off ${count('left')}`);
  if (plan.released) {
    log('  the release already ran on this record: every stored template\'s switch is left as it is (the office\'s, in Settings → Customer Reminders); only approved messages not stored yet are added');
    const ignored = keepOff.filter((k) => (snap.state.reminderTemplates || []).some((x) => x?.key === k));
    if (ignored.length) log(`  --keep-off names stored template(s), left as they are: ${ignored.join(', ')}`);
  }
  const welcome = (snap.state.reminderTemplates || []).find((x) => x?.key === MESSAGE_KEY.welcome);
  const reword = plan.rows.find((r) => r.key === MESSAGE_KEY.welcome)?.action;
  const words = reword === 'reword' ? "moved from an earlier default nobody edited to Matt's (the catalog's)"
    : reword === 'reword-skipped-edited' ? 'LEFT: the office edited them' : welcome ? "already Matt's" : '-';
  log(`  welcome email: switch untouched (${welcome ? (welcome.enabled ? 'on' : 'off') : 'not stored'}); words ${words}`);
  log(`  reminderEvents: ${plan.dropped.reminderEvents === null ? 'not present' : `${plan.dropped.reminderEvents} row(s) — the key is removed (retired)`}`);
  if (!plan.changed) { log('\n✓ Every approved message is already on (or kept off as asked). No-op.\n'); return 0; }
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
  const again = planApprovedMessages(back?.state || {}, { keepOff });
  if (!back || back.version !== snap.version + 1 || canonical(back.state.reminderTemplates) !== canonical(plan.state.reminderTemplates) || again.changed) {
    err(`read-back does not match the write (read v${back?.version ?? '?'}, expected v${snap.version + 1}). Restore from app/scripts/${backupName} if needed.`);
    return 1;
  }
  const on = (back.state.reminderTemplates || []).filter((x) => APPROVED_KEYS.includes(x.key) && x.enabled === true).length;
  log(`\n✓ org_state v${snap.version} → ${back.version}: ${on} of ${APPROVED_KEYS.length} approved messages on. Read back: nothing left to do.`);
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
  const keepOff = (at('--keep-off') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ORG = process.env.CLEANSPACE_ORG_ID || '00000000-0000-0000-0000-000000000001';
  const file = at('--state');
  if (file) {
    if (APPLY) { console.error('An offline run (--state) never writes; drop --apply.'); process.exitCode = 1; } else {
      console.log(`\n── ${OP_NAME} (OFFLINE dry run on ${file}) ─────────────────────────`);
      process.exitCode = await runApprovedMessagesOp({ t: fileTransport(file), org: ORG, apply: false, keepOff });
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
          process.exitCode = await runApprovedMessagesOp({ t: pgTransport(client), org: ORG, apply: APPLY, keepOff });
        } catch (e) {
          console.error('connect failed:', e.message);
          process.exitCode = 1;
        } finally { await client.end().catch(() => {}); }
      } else {
        const { createClient } = await import('@supabase/supabase-js');
        const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
        process.exitCode = await runApprovedMessagesOp({ t: supabaseTransport(db), org: ORG, apply: APPLY, keepOff });
      }
    }
  }
}
