// A DEAL'S WALKTHROUGH, AND THE CONFIRMATION MATT APPROVED (Daniel, 2026-10-20: "Add a date and
// time to deals (Recommended)").
//
// A deal (an opportunity) records when its walkthrough is (`walkthroughAt`, entered as a date and a
// time on the ORG's clock) and, optionally, where to meet (`walkthroughWhere`). The write stamps
// when that date and time was set or changed (`walkthroughSetAt`, lib/walkthrough stampWalkthrough
// through the reducer), and the customer-message engine (lib/reminderScheduler) confirms it to the
// deal's primary contact: once per date set, a changed time one updated confirmation.
//   W1  the catalog: the walkthrough confirmation has a trigger now, so it is built and ON by default
//   W2  the walker: one confirmation, to the deal's contact, its {date} {time} in the ORG's zone and
//       "where to meet" in the approved words' {site_name}; keyed by the deal and the date set
//   W3  🔴 NO BACK-BLAST: a date set longer ago than EVENT_MAX_AGE_HOURS, a deal from before this
//       build (no stamp) and a walkthrough already past send nothing
//   W4  the window, consent, a closed deal, a customer we no longer serve, the switch
//   W5  the stamps at the write (ADD_OPPORTUNITY / UPDATE_OPPORTUNITY): set, kept on other edits,
//       renewed on a change, cleared with the date; end to end into the walker
//   W6  the form's fields → the stored instant, on the org's clock (never the device's or UTC)
//   W7  the sample-record guard: the confirmation names its deal, so a seed deal is refused at the
//       one send step
//   W8  the screens: the deal editor sets it, a move into "Walkthrough Scheduled" asks (a prompt,
//       never a block), the board's card shows it
//
// Bounds and words are read from lib/customerMessages.js, never restated (THE LAW II.3).
// REGRESSION: on 10a1d616 the confirmation is not built, no walker sends it, nothing stamps a
// deal and no screen sets a date: every check but the W3/W4 "nothing" ones fails.
//   node app/scripts/test-walkthrough-confirmation.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadStore } from './deletion-core.mjs';

const APP = fileURLToPath(new URL('..', import.meta.url));
const soft = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };
const RS = await soft('../src/lib/reminderScheduler.js');
const CM = await soft('../src/lib/customerMessages.js');
const WT = await soft('../src/lib/walkthrough.js');
const DATES = await soft('../src/lib/dates.js');
const IDS = await soft('../src/lib/ids.js');
const SEND = await soft('../api/_lib/customerMessages/send.js');

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). Label first.
const ok = (label, cond, detail) => { if (cond) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`); };
const due = typeof RS.getDueMessages === 'function' ? RS.getDueMessages : () => [];
const mk = (...a) => (typeof RS.messageKey === 'function' ? RS.messageKey(...a) : '?');
const fmtT = (...a) => (typeof RS.fmtCustomerTime === 'function' ? RS.fmtCustomerTime(...a) : '?');
const fmtD = (...a) => (typeof RS.fmtCustomerDate === 'function' ? RS.fmtCustomerDate(...a) : '?');
const K = CM.MESSAGE_KEY || {};
const KEY = K.walkthroughConfirm;
const MSG = CM.MESSAGE_BY_KEY?.[KEY] || {};
const HOUR = 3600e3;
const MAX_AGE = (CM.EVENT_MAX_AGE_HOURS || 48) * HOUR;

// 12:00 in Los Angeles (19:00 UTC) — inside the window; 03:00 LA is outside it.
const TZ = 'America/Los_Angeles';
const NOW = new Date('2026-11-04T20:00:00.000Z');        // Wed 12:00 PST
const NIGHT = new Date('2026-11-04T11:00:00.000Z');      // Wed 03:00 PST
const iso = (ms) => new Date(ms).toISOString();
const ago = (h, now = NOW) => iso(now.getTime() - h * HOUR);
// Thu Nov 5, 19:30 in Los Angeles — already Friday Nov 6 in UTC, so a wrong zone shows.
const WHEN = '2026-11-06T03:30:00.000Z';

const allOn = () => (CM.DEFAULT_REMINDER_TEMPLATES || []).map((t) => ({ ...t, enabled: true }));
const deal = (o = {}) => ({
  id: 'opp1', clientId: 'cl1', primaryContactId: 'ct1', pipelineId: 'pl1', stage: 'walkthrough', status: 'open',
  walkthroughAt: WHEN, walkthroughSetAt: ago(1), walkthroughWhere: 'Main lobby, Suite 400', ...o,
});
function book(overrides = {}) {
  return {
    company: { name: 'Clean Co', email: 'office@clean.test', phone: '555-0100', timezone: TZ },
    reminderTemplates: allOn(),
    clients: [{ id: 'cl1', name: 'Acme Tower', email: 'acme@corp.test', phone: '+15555550001', primaryContactId: 'ct1', statusOverride: 'lead' }],
    contacts: [
      { id: 'ct1', firstName: 'Ann', lastName: 'Lee', email: 'ann@corp.test', phone: '+15555550002', companyId: 'cl1' },
      { id: 'ct2', firstName: 'Sam', lastName: 'Ray', email: 'sam@corp.test', companyId: 'cl1' },
    ],
    sites: [{ id: 's1', clientId: 'cl1', name: 'Acme Tower, Lobby' }],
    services: [],
    users: [],
    marketingSuppressions: [],
    opportunities: [deal()],
    ...overrides,
  };
}
const run = (state = book(), now = NOW) => due({ state, jobs: [] }, now).filter((d) => d.templateKey === KEY);

// ── W1 the catalog ───────────────────────────────────────────────────────────
ok('W1a the walkthrough confirmation is in the catalog', !!MSG.key, CM.__error);
ok('W1b it has a trigger now: built', MSG.built === true, MSG.built);
ok('W1c approved = on: the seed carries its template ON, with the catalog\'s words and the shared id', (() => {
  const t = (CM.DEFAULT_REMINDER_TEMPLATES || []).find((x) => x.key === KEY);
  return !!t && t.enabled === true && t.subject === MSG.subject && t.body === MSG.body && t.id === CM.templateIdFor?.(KEY);
})());
ok('W1d its Settings line no longer says it cannot be sent', !!MSG.when && !/Not sent yet|does not record/.test(MSG.when), MSG.when);

// ── W2 the walker ────────────────────────────────────────────────────────────
{
  const r = run();
  ok('W2a a walkthrough set an hour ago: ONE confirmation, by email, to the deal\'s primary contact', r.length === 1 && r[0].recipient === 'ann@corp.test' && r[0].channel === 'email', r.map((d) => [d.id, d.recipient]));
  const d = r[0] || { tokens: {}, refs: {}, body: '' };
  ok('W2b its date and time are the ORG\'s (Los Angeles), not the server\'s UTC', d.tokens.date === fmtD(WHEN, TZ) && d.tokens.time === fmtT(WHEN, TZ) && d.tokens.date !== fmtD(WHEN, 'UTC'), d.tokens);
  ok('W2c the approved words, filled: "We will meet you at <where> on <date> at <time>"', d.body.includes(`We will meet you at Main lobby, Suite 400 on ${fmtD(WHEN, TZ)} at ${fmtT(WHEN, TZ)}`) && /^Hi Ann,/.test(d.body), d.body);
  ok('W2d the subject is the approved one, filled with the company', d.subject === CM.interpolate?.(MSG.subject, { company: 'Clean Co' }), d.subject);
  ok('W2e keyed by the deal, its walkthrough and when it was set (the sent log\'s dedupe identity)', d.id === mk(KEY, 'opp1', Date.parse(WHEN), Date.parse(deal().walkthroughSetAt)) && run()[0]?.id === d.id, d.id);
  ok('W2f it names its deal (refs.opportunityId) and the company', d.refs.opportunityId === 'opp1' && d.refs.clientId === 'cl1' && d.refs.contactId === 'ct1' && d.subjectId === 'opp1', d.refs);
  ok('W2g a receipt, not a nudge: no opt-out line', !/To stop these emails/.test(d.body) && MSG.transactional === true);
  const noNote = run(book({ opportunities: [deal({ walkthroughWhere: '  ' })] }))[0];
  ok('W2h no "where to meet": the company\'s location', noNote?.tokens?.site_name === 'Acme Tower, Lobby', noNote?.tokens);
  const noSite = run(book({ sites: [], opportunities: [deal({ walkthroughWhere: null })] }))[0];
  ok('W2i …and with no location, the company\'s name', noSite?.tokens?.site_name === 'Acme Tower', noSite?.tokens);
  const moved = run(book({ opportunities: [deal({ walkthroughAt: '2026-11-07T17:00:00.000Z', walkthroughSetAt: ago(0.2) })] }));
  ok('W2j a changed date or time is a NEW confirmation (a new key), with the new time; still one for the deal', moved.length === 1 && moved[0].id !== d.id && moved[0].tokens.time === fmtT('2026-11-07T17:00:00.000Z', TZ), moved.map((x) => x.id));
  const noOwnContact = run(book({ opportunities: [deal({ primaryContactId: null })] }));
  ok('W2k a deal with no contact of its own: the company\'s primary contact (as the card shows it)', noOwnContact[0]?.recipient === 'ann@corp.test', noOwnContact);
  const other = run(book({ opportunities: [deal({ primaryContactId: 'ct2' })] }));
  ok('W2l a deal that runs through someone else: that person', other[0]?.recipient === 'sam@corp.test', other);
}

// ── W3 no back-blast ─────────────────────────────────────────────────────────
ok('🔴 W3a no back-blast: a date set longer ago than EVENT_MAX_AGE_HOURS sends nothing (switching the message on never confirms old walkthroughs)', run(book({ opportunities: [deal({ walkthroughSetAt: iso(NOW.getTime() - MAX_AGE - HOUR) })] })).length === 0);
ok('🔴 W3b a deal from before this build (a date, no stamp) sends nothing', run(book({ opportunities: [deal({ walkthroughSetAt: undefined })] })).length === 0);
ok('🔴 W3c a walkthrough already past sends nothing, even with a fresh stamp', run(book({ opportunities: [deal({ walkthroughAt: ago(2), walkthroughSetAt: ago(1) })] })).length === 0);
ok('W3d a stamp in the future (a clock the server does not trust) is not an event', run(book({ opportunities: [deal({ walkthroughSetAt: iso(NOW.getTime() + HOUR) })] })).length === 0);
ok('W3e a deal with no walkthrough sends nothing', run(book({ opportunities: [deal({ walkthroughAt: null, walkthroughSetAt: null })] })).length === 0);

// ── W4 the window, consent, the deal, the customer, the switch ───────────────
ok(`W4a the send window: ${MSG.immediate ? 'immediate, it goes at 3 a.m. too' : 'not at 3 a.m. (not an immediate message)'}`,
  run(book({ opportunities: [deal({ walkthroughSetAt: ago(1, NIGHT) })] }), NIGHT).length === (MSG.immediate ? 1 : 0));
for (const status of ['won', 'lost']) ok(`W4b a ${status} deal gets no confirmation`, run(book({ opportunities: [deal({ status })] })).length === 0);
ok('W4c a contact marked Do Not Contact gets nothing', run(book({ contacts: [{ ...book().contacts[0], doNotContact: true }] })).length === 0);
ok('W4d a contact opted out of reminders gets nothing', run(book({ contacts: [{ ...book().contacts[0], reminderOptOut: true }] })).length === 0);
ok('W4e a contact with no email gets nothing — and a prospect\'s message never falls back to the company\'s address', run(book({ contacts: [{ ...book().contacts[0], email: '' }] })).length === 0);
for (const status of [{ statusOverride: 'archived', archivedAt: ago(100) }, { statusOverride: 'inactive' }, { type: 'vendor' }]) {
  ok(`W4f a company we no longer deal with (${JSON.stringify(status)}) gets nothing`, run(book({ clients: [{ ...book().clients[0], ...status }] })).length === 0);
}
ok('W4g a deal whose company is gone gets nothing', run(book({ clients: [] })).length === 0);
ok('W4h the template switched off: nothing (the switch is the office\'s)', run(book({ reminderTemplates: allOn().map((t) => (t.key === KEY ? { ...t, enabled: false } : t)) })).length === 0);
ok('W4i several deals: one confirmation each', run(book({ opportunities: [deal(), deal({ id: 'opp2', primaryContactId: 'ct2' })] })).length === 2);

// ── W5 the stamps at the write ───────────────────────────────────────────────
{
  const { reducer, ACTIONS, INITIAL_STATE } = await loadStore();
  const s0 = { ...INITIAL_STATE, opportunities: (INITIAL_STATE.opportunities || []).map((o) => ({ ...o, walkthroughAt: null, walkthroughSetAt: null })) };
  const id = s0.opportunities.find((o) => o.status === 'open' && o.stage !== (WT.WALKTHROUGH_STAGE_KEY || 'walkthrough'))?.id;
  const get = (s) => s.opportunities.find((o) => o.id === id) || {};
  const at1 = '2026-11-06T03:30:00.000Z';
  const t0 = Date.now();
  const s1 = reducer(s0, { type: ACTIONS.UPDATE_OPPORTUNITY, id, patch: { walkthroughAt: at1, walkthroughWhere: 'Front desk' } });
  ok('W5a setting a deal\'s walkthrough stamps when it was set (walkthroughSetAt, now)', get(s1).walkthroughAt === at1 && Date.parse(get(s1).walkthroughSetAt) >= t0 - 1000 && Date.parse(get(s1).walkthroughSetAt) <= Date.now() + 1000, get(s1));
  const s2 = reducer({ ...s1, opportunities: s1.opportunities.map((o) => (o.id === id ? { ...o, walkthroughSetAt: '2026-01-01T00:00:00.000Z' } : o)) }, { type: ACTIONS.UPDATE_OPPORTUNITY, id, patch: { title: 'New name', walkthroughWhere: 'Side door', walkthroughAt: at1 } });
  ok('W5b another edit (the name, where to meet, the same time saved again) keeps the stamp: no new confirmation', get(s2).walkthroughSetAt === '2026-01-01T00:00:00.000Z', get(s2).walkthroughSetAt);
  const s3 = reducer(s2, { type: ACTIONS.UPDATE_OPPORTUNITY, id, patch: { walkthroughAt: '2026-11-07T17:00:00.000Z' } });
  ok('W5c changing the date or time renews the stamp (one updated confirmation)', Date.parse(get(s3).walkthroughSetAt) >= t0 - 1000, get(s3).walkthroughSetAt);
  const s4 = reducer(s3, { type: ACTIONS.UPDATE_OPPORTUNITY, id, patch: { walkthroughAt: null } });
  ok('W5d clearing the date clears the stamp', get(s4).walkthroughAt === null && get(s4).walkthroughSetAt === null, get(s4));
  const s5 = reducer(s0, { type: ACTIONS.ADD_OPPORTUNITY, opportunity: { id: 'opp_new_x', clientId: s0.clients[0].id, pipelineId: s0.pipelines[0].id, stage: s0.pipelines[0].stages[0].key, walkthroughAt: at1 } });
  ok('W5e a deal added with a walkthrough is stamped too', !!s5.opportunities.find((o) => o.id === 'opp_new_x')?.walkthroughSetAt);
  const s6 = reducer(s0, { type: ACTIONS.SET_OPPORTUNITY_STAGE, id, stage: WT.WALKTHROUGH_STAGE_KEY, pipelineId: get(s0).pipelineId });
  ok('W5f moving a deal into "Walkthrough Scheduled" sets no date by itself (the office is asked)', !get(s6).walkthroughSetAt && !get(s6).walkthroughAt, get(s6));
  // End to end: what the reducer wrote is what the walker confirms.
  const setMs = Date.parse(get(s1).walkthroughSetAt ?? '');
  const later = new Date((Number.isFinite(setMs) ? setMs : Date.now()) + 60e3);
  const e2e = reducer(s0, { type: ACTIONS.UPDATE_OPPORTUNITY, id, patch: { walkthroughAt: iso(later.getTime() + 48 * HOUR) } });
  const items = due({ state: { ...e2e, company: { ...e2e.company, timezone: TZ }, reminderTemplates: allOn() }, jobs: [] }, later).filter((d) => d.templateKey === KEY && d.refs.opportunityId === id);
  ok('W5g end to end: the reducer\'s stamped deal is due as a confirmation (window permitting)', !(RS.isInSendWindow || (() => true))(later, TZ) || items.length === 1, items.map((d) => d.id));
}

// ── W6 the form's fields → the stored instant ────────────────────────────────
{
  const wp = typeof WT.walkthroughPatch === 'function' ? WT.walkthroughPatch : () => ({});
  const a = wp({ date: '2026-11-05', time: '19:30', where: '  Main lobby,   Suite 400 ' }, TZ);
  ok('W6a a date and a time are the ORG\'s wall clock: they read back the same in the org zone', a.patch?.walkthroughAt && DATES.splitIso?.(a.patch.walkthroughAt, TZ)?.date === '2026-11-05' && DATES.splitIso(a.patch.walkthroughAt, TZ).time === '19:30', a);
  ok('W6b …and are not the same instant in UTC (a device- or server-zone parse would be)', a.patch?.walkthroughAt && a.patch.walkthroughAt !== DATES.composeIso?.('2026-11-05', '19:30', 'UTC'), a);
  ok('W6c where to meet: trimmed, one line, spaces collapsed', a.patch?.walkthroughWhere === 'Main lobby, Suite 400', a.patch?.walkthroughWhere);
  ok('W6d a time typed by hand ("7:30 pm") is read as 19:30', wp({ date: '2026-11-05', time: '7:30 pm' }, TZ).patch?.walkthroughAt === a.patch?.walkthroughAt);
  ok('W6e a date with no time asks for the time', wp({ date: '2026-11-05', time: '' }, TZ).error === 'time');
  ok('W6f a time with no date asks for the date', wp({ date: '', time: '10:00' }, TZ).error === 'date');
  ok('W6g a time that is not a time is refused (never a wrong instant)', wp({ date: '2026-11-05', time: '1975' }, TZ).error === 'time');
  ok('W6h both empty: no walkthrough (cleared)', wp({ date: '', time: '', where: '' }, TZ).patch?.walkthroughAt === null && wp({}, TZ).patch?.walkthroughWhere === null);
  ok(`W6i where to meet is capped at WALKTHROUGH_WHERE_MAX (${WT.WALKTHROUGH_WHERE_MAX})`, (wp({ date: '2026-11-05', time: '10:00', where: 'x'.repeat(500) }, TZ).patch?.walkthroughWhere || '').length === WT.WALKTHROUGH_WHERE_MAX);
  const f = typeof WT.walkthroughFields === 'function' ? WT.walkthroughFields({ walkthroughAt: a.patch?.walkthroughAt, walkthroughWhere: 'Front desk' }, TZ) : {};
  ok('W6j the editor reads a stored walkthrough back into the same date, time and note (lossless round trip)', f.date === '2026-11-05' && f.time === '19:30' && f.where === 'Front desk', f);
  const { INITIAL_STATE } = await loadStore();
  ok('W6k the stage it asks on is the pipeline\'s "Walkthrough Scheduled" key, as the seed\'s Master board declares it', INITIAL_STATE.pipelines.some((p) => p.stages.some((s) => s.label === 'Walkthrough Scheduled' && WT.isWalkthroughStage?.(s.key))));
}

// ── W7 the sample-record guard ───────────────────────────────────────────────
{
  const seedDeal = IDS.seedId?.('opp', 'aventura') || 'opp_seed_aventura';
  const item = run(book({ opportunities: [deal({ id: seedDeal })] }))[0];
  ok('W7a a seed deal\'s confirmation names the deal in its refs', item?.refs?.opportunityId === seedDeal, item?.refs);
  ok('🔴 W7b …so the send step\'s guard finds it as a sample record (a real customer and contact around it)', IDS.seedRecordIn?.(item?.refs) === seedDeal, item?.refs);
  const r = typeof SEND.sendCustomerMessage === 'function' && item
    ? await SEND.sendCustomerMessage({ templateKey: KEY, channel: 'email', to: item.recipient, subject: item.subject, body: item.body, refs: item.refs })
    : null;
  ok('🔴 W7c …and refuses it before any transport', r?.ok === false && r?.refused === SEND.SAMPLE_RECORD_REFUSAL && r?.recordId === seedDeal, r || SEND.__error);
}

// ── W8 the screens ───────────────────────────────────────────────────────────
{
  const read = (rel) => { try { return fs.readFileSync(`${APP}${rel}`, 'utf8'); } catch { return ''; } };
  const board = read('src/components/PipelineBoard.jsx');
  const editor = read('src/components/OpportunityDetailModal.jsx');
  const card = read('src/components/PipelineCard.jsx');
  const prompt = read('src/components/WalkthroughPrompt.jsx');
  const addModal = read('src/components/AddContactsToStageModal.jsx');
  ok('W8a the deal editor sets the date, the time and where to meet, and saves them through walkthroughPatch → UPDATE_OPPORTUNITY', /walkthroughPatch\(/.test(editor) && /WalkthroughFields/.test(editor) && /UPDATE_OPPORTUNITY/.test(editor));
  ok('W8b the editor asks when the Stage is set to "Walkthrough Scheduled" with no date (isWalkthroughStage)', /isWalkthroughStage\(draft\.stage\)/.test(editor));
  ok('W8c the prompt saves through walkthroughPatch → UPDATE_OPPORTUNITY, and "Not now" closes it writing nothing', /walkthroughPatch\(/.test(prompt) && /ACTIONS\.UPDATE_OPPORTUNITY/.test(prompt) && /walkthrough\.prompt\.notNow/.test(prompt));
  const drop = board.slice(board.indexOf('const handleDrop'), board.indexOf('const selectionCount'));
  ok('W8d a drop into "Walkthrough Scheduled" MOVES the deal first, then asks (a prompt, never a block)', drop.indexOf('SET_OPPORTUNITY_STAGE') > -1 && drop.indexOf('askWalkthrough(') > drop.indexOf('SET_OPPORTUNITY_STAGE') && /<WalkthroughPrompt/.test(board), drop.slice(-400));
  ok('W8e a deal added straight to the stage is asked about too', /onAdded/.test(addModal) && /onAdded=\{/.test(board));
  ok('W8f the board\'s card shows the walkthrough (and that one is missing on a deal in the stage)', /walkthrough\.card\.when/.test(card) && /walkthrough\.card\.notSet/.test(card));
  const en = read('src/i18n/catalog/en.js');
  const keys = [...`${editor}${card}${prompt}${read('src/components/WalkthroughFields.jsx')}`.matchAll(/t\('(walkthrough\.[a-zA-Z.]+)'/g)].map((m) => m[1]);
  ok('W8g every walkthrough word on screen is a catalog line (UI_RULES §140)', keys.length >= 8 && keys.every((k) => en.includes(`'${k}':`)), keys.filter((k) => !en.includes(`'${k}':`)));
}

console.log(`test-walkthrough-confirmation: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
