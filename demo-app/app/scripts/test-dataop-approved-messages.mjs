// The release data-op that switches on Matt's approved messages (app/scripts/dataop-approved-
// messages.mjs), OFFLINE: its pure plan and the whole op on a fake transport — never a connection.
//   D1  on a production-shaped blob (the five old templates, all off; a reminderEvents list): the
//       dry run adds every missing approved message ON with the catalog's words and the seed's ids,
//       switches the four approved old ones ON, leaves the welcome email exactly as it is, adds the
//       walkthrough confirmation ON (built 2026-10-20), drops the retired reminderEvents — and
//       writes NOTHING
//   D2  --apply: a backup first, ONE compare-and-swap write, read back, nothing left to do
//   D3  a second run is a no-op (no write)
//   D4  --keep-off leaves the named messages off; a key that names no approved message is refused
//   D5  no other slice changes; a template's words the office edited are kept
//   D6  a CAS conflict writes nothing and fails
//   D7  the offline file transport never writes; the live section runs the shared guard first
//   D8  the follow-up on production AS THE RELEASE LEFT IT (22 on, four held off): the one change
//       is the walkthrough confirmation, added ON, with or without the release's --keep-off; every
//       stored switch stays (the four held ones, one the office moved); a second run is a no-op
//   D9  the welcome email's words (2026-10-20, Matt's own wording): production's stored wording —
//       an earlier default nobody edited — moves to the catalog's, its switch (off) and id kept; a
//       wording the office edited is LEFT; on production as it is today (v645) that is the one
//       change; a second run is a no-op
// REGRESSION (THE LAW II.3): on 811e54eb there is no op — every check fails. On 10a1d616 D1e and
// D8a–g fail (no walkthrough confirmation; a re-run without --keep-off switches the four held on).
// On 4ee4ca15 D9–D9d fail (no earlier defaults; the welcome email's stored words are never moved).
//   node app/scripts/test-dataop-approved-messages.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). Label first.
const ok = (label, cond, detail) => { if (cond) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${JSON.stringify(detail)})`); };
const soft = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };
const OP = await soft('./dataop-approved-messages.mjs');
const CM = await soft('../src/lib/customerMessages.js');
const { IDENTITY } = await soft('../src/brand/identity.generated.js');
ok('the op loads (and importing it opens nothing)', typeof OP.planApprovedMessages === 'function' && typeof OP.runApprovedMessagesOp === 'function', OP.__error);
const K = CM.MESSAGE_KEY || {};
const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

// Production as the plan read it (2026-10-19): the five old templates, every one off; the dead
// reminderEvents list; and the rest of the record.
const LEGACY = ['welcome_email', 'booking_confirmation', 'reminder_24h', 'day_of_eta', 'post_service'];
const prodBlob = () => ({
  company: { name: 'Clean Space', timezone: 'America/New_York' },
  clients: [{ id: 'cl_seed_evergreen', name: 'Las Olas Medical Group' }],
  users: [{ id: 'u_seed_kyler', role: 'owner' }],
  reminderTemplates: LEGACY.map((key) => ({ ...CM.defaultTemplate(CM.MESSAGE_BY_KEY[key]), enabled: false })),
  reminderEvents: [{ id: 're_x', templateKey: 'post_service', jobId: 'j_seed_x' }],
  marketingSuppressions: [],
});
function fakeT(blob, { conflict = false } = {}) {
  const t = { writes: 0, row: { state: structuredClone(blob), version: 50 } };
  t.readOrgState = async () => structuredClone(t.row);
  t.casWrite = async ({ baseVersion, state }) => {
    t.writes += 1;
    if (conflict || baseVersion !== t.row.version) return [];
    t.row = { state: structuredClone(state), version: t.row.version + 1 };
    return [{ version: t.row.version }];
  };
  return t;
}
const quiet = () => { const lines = []; return { log: (...a) => lines.push(a.join(' ')), err: (...a) => lines.push(a.join(' ')), lines }; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dataop-am-'));
const backupDir = pathToFileURL(`${tmp}/`);
const approved = OP.APPROVED_KEYS || [];

if (typeof OP.planApprovedMessages === 'function') {
  // ── D1 the dry run ──
  const plan = OP.planApprovedMessages(prodBlob());
  const by = Object.fromEntries(plan.rows.map((r) => [r.key, r.action]));
  const added = plan.rows.filter((r) => r.action === 'add').map((r) => r.key);
  ok(`D1a every approved message missing from production is ADDED, on (${approved.length - 4} of them)`, added.length === approved.length - 4 && added.every((k) => !LEGACY.includes(k)), added);
  ok('D1b the four approved old ones (booking, 24-hour, day-of, first-clean check-in) are switched ON', ['booking_confirmation', 'reminder_24h', 'day_of_eta', 'post_service'].every((k) => by[k] === 'switch-on'), by);
  const nextT = new Map(plan.state.reminderTemplates.map((t) => [t.key, t]));
  ok('D1c an added template carries the catalog\'s words (Matt\'s approved wording) and the seed\'s id', added.every((k) => { const t = nextT.get(k); const m = CM.MESSAGE_BY_KEY[k]; return t.subject === m.subject && t.body === m.body && t.id === CM.templateIdFor(k) && t.channel === m.channel && t.enabled === true; }));
  ok('D1d the welcome email is left exactly as it was (off)', canonical(nextT.get('welcome_email')) === canonical(prodBlob().reminderTemplates[0]) && !(K.welcome in by));
  ok('D1e the walkthrough confirmation (a trigger since 2026-10-20: a deal records its walkthrough) is added ON with the catalog\'s words', nextT.get(K.walkthroughConfirm)?.enabled === true && nextT.get(K.walkthroughConfirm)?.body === CM.MESSAGE_BY_KEY?.[K.walkthroughConfirm]?.body && by[K.walkthroughConfirm] === 'add', by[K.walkthroughConfirm]);
  ok('D1f the retired reminderEvents key is dropped (1 row)', !('reminderEvents' in plan.state) && plan.dropped.reminderEvents === 1);
  ok('D1g every approved message is on after the plan', approved.every((k) => nextT.get(k)?.enabled === true));
  const t1 = fakeT(prodBlob());
  const o1 = quiet();
  const rc1 = await OP.runApprovedMessagesOp({ t: t1, org: 'org', apply: false, backupDir, log: o1.log, err: o1.err });
  ok('🔴 D1h the dry run writes NOTHING (and says so)', rc1 === 0 && t1.writes === 0 && o1.lines.some((l) => /--dry-run/.test(l)), o1.lines.slice(-3));

  // ── D2 apply ──
  const t2 = fakeT(prodBlob());
  const o2 = quiet();
  const rc2 = await OP.runApprovedMessagesOp({ t: t2, org: 'org', apply: true, backupDir, log: o2.log, err: o2.err, now: new Date('2026-10-20T12:00:00Z') });
  const backups = fs.readdirSync(tmp).filter((f) => f.startsWith('orgstate-backup-'));
  ok('🔴 D2a --apply: ONE write, a backup first (of the blob as it was), read back clean', rc2 === 0 && t2.writes === 1 && backups.length === 1
    && JSON.parse(fs.readFileSync(path.join(tmp, backups[0]), 'utf8')).state.reminderEvents?.length === 1 && t2.row.version === 51, { rc2, writes: t2.writes, backups, tail: o2.lines.slice(-3) });
  ok('D2b …every approved message is on in the committed record', approved.every((k) => t2.row.state.reminderTemplates.find((x) => x.key === k)?.enabled === true));

  // ── D3 idempotent ──
  const o3 = quiet();
  const rc3 = await OP.runApprovedMessagesOp({ t: t2, org: 'org', apply: true, backupDir, log: o3.log, err: o3.err });
  ok('🔴 D3 a second run is a no-op: no write', rc3 === 0 && t2.writes === 1 && o3.lines.some((l) => /No-op/.test(l)), o3.lines.slice(-2));

  // ── D4 keep-off ──
  const keep = ['service_setup', 'booking_confirmation', 'post_service', 'upsell'];
  const kp = OP.planApprovedMessages(prodBlob(), { keepOff: keep });
  const kt = new Map(kp.state.reminderTemplates.map((t) => [t.key, t]));
  ok('D4a --keep-off leaves the named messages OFF (added off, or kept off) and the rest on', keep.every((k) => kt.get(k)?.enabled === false) && approved.filter((k) => !keep.includes(k)).every((k) => kt.get(k)?.enabled === true));
  const o4 = quiet();
  const rc4 = await OP.runApprovedMessagesOp({ t: fakeT(prodBlob()), org: 'org', apply: true, keepOff: [K.welcome], backupDir, log: o4.log, err: o4.err });
  ok('D4b a --keep-off key that names no approved message is refused', rc4 === 1 && o4.lines.some((l) => /names no approved message/.test(l)), o4.lines);

  // ── D5 nothing else ──
  const edited = prodBlob();
  edited.reminderTemplates[1] = { ...edited.reminderTemplates[1], body: 'Our own words, {client_contact}.' };
  const ep = OP.planApprovedMessages(edited);
  const strip = (s) => { const c = { ...s }; delete c.reminderTemplates; delete c.reminderEvents; return c; };
  ok('D5a no other slice changes', canonical(strip(ep.state)) === canonical(strip(edited)));
  ok('D5b a template\'s words the office edited are kept (only its switch moves)', ep.state.reminderTemplates.find((x) => x.key === 'booking_confirmation')?.body === 'Our own words, {client_contact}.' && ep.state.reminderTemplates.find((x) => x.key === 'booking_confirmation')?.enabled === true);

  // ── D6 conflict ──
  const t6 = fakeT(prodBlob(), { conflict: true });
  const o6 = quiet();
  const rc6 = await OP.runApprovedMessagesOp({ t: t6, org: 'org', apply: true, backupDir, log: o6.log, err: o6.err });
  ok('D6 a CAS conflict: nothing written, exit 1', rc6 === 1 && t6.row.version === 50 && o6.lines.some((l) => /CAS conflict/.test(l)));

  // ── D7 offline + the guard ──
  const file = path.join(tmp, 'blob.json');
  fs.writeFileSync(file, JSON.stringify({ version: 9, state: prodBlob() }));
  const ft = OP.fileTransport(file);
  let threw = false;
  try { await ft.casWrite({}); } catch { threw = true; }
  ok('D7a the offline file transport reads a saved blob and never writes', threw && (await ft.readOrgState()).version === 9);
  const src = fs.readFileSync(fileURLToPath(new URL('./dataop-approved-messages.mjs', import.meta.url)), 'utf8');
  ok('D7b the live section runs the shared guard (refuseTarget) and names the target (printTarget) before any read', /refuseTarget\(\{ transport, ref, prod: PROD, confirmProd: process\.env\.CONFIRM_PROD \}\)/.test(src) && src.indexOf('printTarget({') < src.indexOf("await import('pg')"));

  // ── D8 the follow-up: the walkthrough confirmation on production AS THE RELEASE LEFT IT ──
  // DATA_AND_SYNC.md §11, 2026-10-20 04:32:26: org_state v643 → v644, templates 5 → 27, 22 of the 26
  // approved on, four held OFF on Daniel's call until Matt's team has typed in the existing book
  // (`--keep-off service_setup,booking_confirmation,post_service,upsell`), the welcome email off,
  // nothing for the walkthrough confirmation, reminderEvents removed. Re-run now, the op must ADD the
  // walkthrough confirmation (on: Matt approved it) and leave every other switch exactly as it is —
  // with or without the release's flags, so a re-run that forgets them cannot undo Daniel's hold.
  const HELD = ['service_setup', 'booking_confirmation', 'post_service', 'upsell'];
  const RELEASED = approved.filter((k) => k !== K.walkthroughConfirm);
  // The release also stored the review request email and text (on); Google reviews left the
  // catalog on 2026-10-20, so they are no approved message any more — this op leaves them exactly
  // as stored, and dataop-retire-google-reviews.mjs removes them.
  const { RETIRED_MESSAGE_KEYS: RETIRED = [] } = await soft('./dataop-retire-google-reviews.mjs');
  // …and the past-due TEXT (on), which left the catalog on 2026-10-28 (billing is email only): this
  // op leaves it exactly as stored too, and the run sends nothing for it.
  const RETIRED_TEXT = ['payment_reminder_sms'];
  const STORED_RETIRED = [...RETIRED, ...RETIRED_TEXT];
  const retiredStored = () => STORED_RETIRED.map((key) => ({ id: CM.templateIdFor(key), key, channel: key.endsWith('_sms') ? 'sms' : 'email', subject: '', body: 'stored words', enabled: true }));
  const releasedBlob = () => {
    const b = prodBlob();
    delete b.reminderEvents;
    const legacy = b.reminderTemplates.map((t) => (RELEASED.includes(t.key) ? { ...t, enabled: !HELD.includes(t.key) } : t));
    const added = RELEASED.filter((k) => !LEGACY.includes(k)).map((k) => ({ ...CM.defaultTemplate(CM.MESSAGE_BY_KEY[k]), enabled: !HELD.includes(k) }));
    return { ...b, reminderTemplates: [...legacy, ...added, ...retiredStored()] };
  };
  const rb = releasedBlob();
  const releasedKeys = [...RELEASED, ...STORED_RETIRED];
  ok('D8 (fixture) the released blob is the ledger\'s: 27 templates, 22 of the 26 released on, the four held off, the welcome email off', rb.reminderTemplates.length === 27 && releasedKeys.length === 26 && RETIRED.length === 2
    && rb.reminderTemplates.filter((t) => releasedKeys.includes(t.key) && t.enabled).length === 22 && HELD.every((k) => rb.reminderTemplates.find((t) => t.key === k)?.enabled === false)
    && rb.reminderTemplates.find((t) => t.key === K.welcome)?.enabled === false, rb.reminderTemplates.length);
  const sameExcept = (next, before) => {
    const after = new Map(next.reminderTemplates.map((t) => [t.key, t]));
    const kept = before.reminderTemplates.every((t) => canonical(after.get(t.key)) === canonical(t));
    const strip = (s) => { const c = { ...s }; delete c.reminderTemplates; return c; };
    return kept && canonical(strip(next)) === canonical(strip(before)) && next.reminderTemplates.length === before.reminderTemplates.length + 1;
  };
  for (const [label, keepOff] of [['with no flags', []], ['with the release\'s --keep-off', HELD]]) {
    const p8 = OP.planApprovedMessages(releasedBlob(), { keepOff });
    const wt = p8.state.reminderTemplates.find((t) => t.key === K.walkthroughConfirm);
    const changes = p8.rows.filter((r) => ['add', 'add-off', 'switch-on', 'switch-off'].includes(r.action));
    ok(`🔴 D8a ${label}: the ONE change is the walkthrough confirmation, added ON with Matt's approved words and the seed's id`, changes.length === 1 && changes[0].key === K.walkthroughConfirm && changes[0].action === 'add'
      && wt?.enabled === true && wt.subject === CM.MESSAGE_BY_KEY[K.walkthroughConfirm].subject && wt.body === CM.MESSAGE_BY_KEY[K.walkthroughConfirm].body && wt.id === CM.templateIdFor(K.walkthroughConfirm), changes);
    ok(`🔴 D8b ${label}: every other template is exactly as the release left it (the four held stay OFF), and no other slice moves`, sameExcept(p8.state, releasedBlob()), p8.rows.filter((r) => r.action !== 'already-on'));
  }
  const t8 = fakeT(releasedBlob());
  const o8 = quiet();
  const rc8 = await OP.runApprovedMessagesOp({ t: t8, org: 'org', apply: true, backupDir, log: o8.log, err: o8.err, now: new Date('2026-10-21T12:00:00Z') });
  const onAfter = approved.length - HELD.length;
  ok(`D8c --apply on it: one compare-and-swap write, read back clean, ${onAfter} of the ${approved.length} approved on`, rc8 === 0 && t8.writes === 1 && t8.row.version === 51 && o8.lines.some((l) => l.includes(`${onAfter} of ${approved.length} approved messages on`)), o8.lines.slice(-3));
  ok('D8h the stored review request templates and the past-due text are no approved message: this op leaves them exactly as stored', !CM.MESSAGE_BY_KEY?.payment_reminder_sms && STORED_RETIRED.every((k) => canonical(t8.row.state.reminderTemplates.find((t) => t.key === k)) === canonical(retiredStored().find((t) => t.key === k))));
  const o8b = quiet();
  const rc8b = await OP.runApprovedMessagesOp({ t: t8, org: 'org', apply: true, backupDir, log: o8b.log, err: o8b.err });
  ok('🔴 D8d a blob that already has them (the 22, the four held, the walkthrough confirmation): a no-op, no write', rc8b === 0 && t8.writes === 1 && o8b.lines.some((l) => /No-op/.test(l)), o8b.lines.slice(-2));
  const officeOff = releasedBlob();
  officeOff.reminderTemplates = officeOff.reminderTemplates.map((t) => (t.key === K.complaintAck ? { ...t, enabled: false } : t));
  const p8e = OP.planApprovedMessages(officeOff);
  ok('🔴 D8e after the release a stored switch is the office\'s: one turned off in Settings stays off', p8e.state.reminderTemplates.find((t) => t.key === K.complaintAck)?.enabled === false && sameExcept(p8e.state, officeOff));
  const p8f = OP.planApprovedMessages(releasedBlob(), { keepOff: [K.walkthroughConfirm] });
  ok('D8f --keep-off walkthrough_confirm adds it OFF (held, like the four)', p8f.state.reminderTemplates.find((t) => t.key === K.walkthroughConfirm)?.enabled === false && p8f.rows.find((r) => r.key === K.walkthroughConfirm)?.action === 'add-off');
  const o8g = quiet();
  await OP.runApprovedMessagesOp({ t: fakeT(releasedBlob()), org: 'org', apply: false, backupDir, log: o8g.log, err: o8g.err });
  ok('D8g the dry run says the stored switches are left as they are', o8g.lines.some((l) => /left as (it is|they are)/.test(l)), o8g.lines);

  // ── D9 the welcome email's words ──
  const W = CM.MESSAGE_BY_KEY[K.welcome];
  const EARLIER = OP.WELCOME_EARLIER_DEFAULTS || [];
  // Production's stored welcome (read 2026-10-20 at v645): the 2026-09-02 seed wording, off.
  const stale = { id: CM.templateIdFor(K.welcome), key: K.welcome, channel: 'email', subject: EARLIER[1]?.subject, body: EARLIER[1]?.body, enabled: false };
  const todayBlob = () => {
    const b = releasedBlob();
    b.reminderTemplates = b.reminderTemplates.map((t) => (t.key === K.welcome ? { ...stale } : t));
    b.reminderTemplates.push({ ...CM.defaultTemplate(CM.MESSAGE_BY_KEY[K.walkthroughConfirm]), enabled: true });
    return b;
  };
  ok('D9 (fixture) the earlier defaults name the brand from the brand file, and production\'s stored wording is one of them', EARLIER.length === 4
    && EARLIER[1].subject === `Welcome to ${IDENTITY.name}` && EARLIER[1].body.includes(`as a ${IDENTITY.name} client`) && EARLIER[1].body.includes(IDENTITY.company.phone));
  const p9 = OP.planApprovedMessages(todayBlob());
  const w9 = p9.state.reminderTemplates.find((t) => t.key === K.welcome);
  ok('🔴 D9a the stored welcome (an earlier default nobody edited) moves to Matt\'s wording; its id and switch (off) are kept', w9?.subject === W.subject && w9?.body === W.body && w9.enabled === false && w9.id === stale.id
    && p9.rows.find((r) => r.key === K.welcome)?.action === 'reword', w9);
  const editedW = todayBlob();
  editedW.reminderTemplates = editedW.reminderTemplates.map((t) => (t.key === K.welcome ? { ...t, body: `${t.body}\n\nP.S. our own line.` } : t));
  const pe = OP.planApprovedMessages(editedW);
  ok('D9b words the office edited are LEFT (never overridden), and say so', canonical(pe.state.reminderTemplates.find((t) => t.key === K.welcome)) === canonical(editedW.reminderTemplates.find((t) => t.key === K.welcome))
    && pe.rows.find((r) => r.key === K.welcome)?.action === 'reword-skipped-edited' && pe.changed === false);
  const changes9 = p9.rows.filter((r) => ['add', 'add-off', 'switch-on', 'switch-off', 'reword'].includes(r.action));
  const before9 = todayBlob();
  const others = (s) => s.reminderTemplates.filter((t) => t.key !== K.welcome);
  const strip9 = (s) => { const c = { ...s }; delete c.reminderTemplates; return c; };
  ok('🔴 D9c on production as it is today (v645) the welcome email\'s words are the ONE change; every other template and slice stays', changes9.length === 1 && changes9[0].key === K.welcome
    && canonical(others(p9.state)) === canonical(others(before9)) && canonical(strip9(p9.state)) === canonical(strip9(before9)), changes9);
  const t9 = fakeT(todayBlob());
  const o9 = quiet();
  const rc9 = await OP.runApprovedMessagesOp({ t: t9, org: 'org', apply: true, backupDir, log: o9.log, err: o9.err, now: new Date('2026-10-21T13:00:00Z') });
  const o9b = quiet();
  const rc9b = await OP.runApprovedMessagesOp({ t: t9, org: 'org', apply: true, backupDir, log: o9b.log, err: o9b.err });
  ok('D9d --apply: one write, the dry-run line says the words moved; a second run is a no-op', rc9 === 0 && t9.writes === 1 && o9.lines.some((l) => /words moved from an earlier default/.test(l))
    && rc9b === 0 && t9.writes === 1 && o9b.lines.some((l) => /No-op/.test(l)), [o9.lines.slice(-4), o9b.lines.slice(-2)]);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`test-dataop-approved-messages: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
