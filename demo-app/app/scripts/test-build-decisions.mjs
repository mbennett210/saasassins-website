// The build-decisions catalog is well-formed, and its heavy-import-free index stays in
// lockstep with it. buildDecisions.js is a LIVING document (we append questions over time),
// so this gate catches the mistakes that appending invites: a duplicate/renumbered id, a
// bad type, a single question with two recommendations, a text question that grew options,
// a missing `added` date, or a BUILD_DECISION_INDEX that drifted from the catalog. It also
// holds EMAIL_DRAFT_ADDED to the draft id universe AND EMAIL_DRAFTS (the descriptors) to
// EMAIL_DRAFT_IDS in lockstep — the hub's Drafts tile counts EMAIL_DRAFTS while attention
// counts EMAIL_DRAFT_IDS, so a drift miscounts silently (the DEV console.error in
// emailDrafts.js is not a gate). Offline; the data modules import directly, and EMAIL_DRAFTS
// (which pulls the template builders that read Vite's import.meta.env) imports under node via
// the resolve shim + an import.meta.env load-shim, the same pattern test-name-ledger.mjs uses.
//   node app/scripts/test-build-decisions.mjs
import { registerHooks } from 'node:module';
import { installResolveShim } from './deletion-core.mjs';
import { DECISION_SECTIONS, DECISIONS, DECISION_BY_ID } from '../src/data/buildDecisions.js';
import { BUILD_DECISION_INDEX } from '../src/data/buildDecisionIds.js';
import { EMAIL_DRAFT_IDS, EMAIL_DRAFT_ADDED } from '../src/data/emailDraftIds.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.error('  ✗ ' + m); } };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const QID_RE = /^[A-Z]+-\d+$/;
const TYPES = new Set(['single', 'multi', 'text']);

// ── sections: unique ids ─────────────────────────────────────────────────────────
const sectionIds = DECISION_SECTIONS.map((s) => s.id);
ok(sectionIds.length > 0, 'there are sections');
ok(new Set(sectionIds).size === sectionIds.length, 'section ids are unique');
ok(DECISION_SECTIONS.every((s) => typeof s.title === 'string' && s.title && typeof s.blurb === 'string' && Array.isArray(s.settled)),
  'every section has a title, a blurb and a settled array');

// ── flat DECISIONS derives from the sections, in catalog order ─────────────────────
const flatFromSections = DECISION_SECTIONS.flatMap((s) => s.questions.map((q) => q.id));
ok(DECISIONS.length === flatFromSections.length && DECISIONS.every((q, i) => q.id === flatFromSections[i]),
  'DECISIONS is the sections flattened, in catalog order');
ok(DECISIONS.every((q) => sectionIds.includes(q.sectionId)), 'every flat decision carries a real sectionId');
ok(DECISIONS.every((q) => DECISION_BY_ID[q.id] === q), 'DECISION_BY_ID maps every id to its question');

// ── questions: ids unique, well-formed, valid types, valid added ───────────────────
const qIds = DECISIONS.map((q) => q.id);
ok(new Set(qIds).size === qIds.length, 'question ids are unique across the whole catalog');
ok(qIds.every((id) => QID_RE.test(id)), 'every question id matches ^[A-Z]+-\\d+$');
ok(DECISIONS.every((q) => TYPES.has(q.type)), 'every question has a valid type (single|multi|text)');
ok(DECISIONS.every((q) => typeof q.added === 'string' && DATE_RE.test(q.added)), 'every question has a YYYY-MM-DD `added` date');
ok(DECISIONS.every((q) => typeof q.q === 'string' && q.q.trim().length > 0), 'every question has non-empty text');

// ── options: single/multi have >=2 with unique ids; single <=1 rec; text has none ──
const optioned = DECISIONS.filter((q) => q.type !== 'text');
ok(optioned.every((q) => Array.isArray(q.options) && q.options.length >= 2), 'single/multi questions have >=2 options');
ok(optioned.every((q) => {
  const ids = q.options.map((o) => o.id);
  return new Set(ids).size === ids.length;
}), 'option ids are unique within each question');
ok(optioned.every((q) => q.options.every((o) => typeof o.id === 'string' && o.id && typeof o.label === 'string' && o.label)),
  'every option has an id and a label');
ok(DECISIONS.filter((q) => q.type === 'single').every((q) => q.options.filter((o) => o.rec).length <= 1),
  'a single-choice question has at most one recommended option');
ok(DECISIONS.filter((q) => q.type === 'text').every((q) => !('options' in q) || q.options === undefined),
  'text questions have no options');

// ── BUILD_DECISION_INDEX is in lockstep with the catalog (id, order, added) ────────
ok(BUILD_DECISION_INDEX.length === DECISIONS.length, 'BUILD_DECISION_INDEX has one entry per decision');
ok(BUILD_DECISION_INDEX.every((x, i) => x.id === DECISIONS[i].id && x.added === DECISIONS[i].added),
  'BUILD_DECISION_INDEX matches the catalog id-for-id, in order, with the same `added`');
ok(BUILD_DECISION_INDEX.every((x) => DATE_RE.test(x.added)), 'every index entry has a YYYY-MM-DD `added`');

// ── EMAIL_DRAFT_ADDED: keys are a subset of the draft ids, values are valid dates ──
const draftIdSet = new Set(EMAIL_DRAFT_IDS);
ok(Object.keys(EMAIL_DRAFT_ADDED).every((id) => draftIdSet.has(id)),
  'EMAIL_DRAFT_ADDED keys are a subset of EMAIL_DRAFT_IDS');
ok(Object.values(EMAIL_DRAFT_ADDED).every((d) => DATE_RE.test(d)),
  'every EMAIL_DRAFT_ADDED value is a YYYY-MM-DD date');

// ── EMAIL_DRAFTS (descriptors) ↔ EMAIL_DRAFT_IDS lockstep (same ids, same order) ──
// Import EMAIL_DRAFTS under node: the resolve shim adds .js to extensionless imports, and the
// load-shim injects a minimal import.meta.env so the template builders' top-level env reads
// don't throw (email.js reads import.meta.env.MODE without a guard).
installResolveShim();
registerHooks({
  load(url, ctx, next) {
    const r = next(url, ctx);
    if (/[\\/]src[\\/]/.test(url) && r.source && String(r.source).includes('import.meta.env')) {
      r.source = `if (!import.meta.env) import.meta.env = { MODE: 'test', PROD: false, DEV: true };\n${r.source}`;
    }
    return r;
  },
});
const { EMAIL_DRAFTS } = await import('../src/data/emailDrafts.js');
const descriptorIds = EMAIL_DRAFTS.map((d) => d.id);
ok(descriptorIds.length === EMAIL_DRAFT_IDS.length && descriptorIds.every((id, i) => id === EMAIL_DRAFT_IDS[i]),
  'EMAIL_DRAFTS descriptors and EMAIL_DRAFT_IDS are in lockstep (same ids, same order)');
ok(new Set(descriptorIds).size === descriptorIds.length, 'EMAIL_DRAFTS descriptor ids are unique');

// ── W1-R: the manager-time-approval Review batch (spec §9) ─────────────────────────
// PAY-15 (pending hours at payroll) and PAY-16 (who enters reimbursements) are appended
// to the `pay` section, and PAY-1/PAY-2/PAY-11 are re-flagged into the same 2026-09-27
// update so all five surface under "new" together. Oracles are the spec's option ids and
// the client-decision batch list, not the code under test. FAILS on pre-W1-R code (the
// two ids don't exist and the latest `added` is the 2026-09-25 batch of 123 questions).
const paySection = DECISION_SECTIONS.find((s) => s.id === 'pay');
ok(!!paySection, 'the `pay` section exists');
const optIds = (id) => (DECISION_BY_ID[id]?.options || []).map((o) => o.id);
const inPay = (id) => !!paySection && paySection.questions.some((q) => q.id === id);
ok(inPay('PAY-15'), 'PAY-15 is in the `pay` section');
ok(DECISION_BY_ID['PAY-15']?.type === 'single' && JSON.stringify(optIds('PAY-15')) === JSON.stringify(['a', 'b']),
  'PAY-15 is single with option ids [a, b] (spec §9)');
ok(DECISION_BY_ID['PAY-15']?.added === '2026-09-27', 'PAY-15 is added 2026-09-27');
ok(inPay('PAY-16'), 'PAY-16 is in the `pay` section');
ok(DECISION_BY_ID['PAY-16']?.type === 'single' && JSON.stringify(optIds('PAY-16')) === JSON.stringify(['a', 'b', 'c']),
  'PAY-16 is single with option ids [a, b, c] (spec §9)');
ok(DECISION_BY_ID['PAY-16']?.added === '2026-09-27', 'PAY-16 is added 2026-09-27');
// The 2026-09-27 batch is EXACTLY PAY-1, PAY-2, PAY-11, PAY-15, PAY-16 (spec §9 re-flag) —
// the guarantee is that those five share ONE date, so they surface under "new" together.
// It used to be written as "the LATEST batch is those five", which was the same thing only
// while nothing newer existed; ALR-10 (2026-09-28) is newer, and a later batch does not
// un-group the W1-R five. Both halves are pinned now: the W1-R batch by its own date, and
// the latest batch on its own, since "New" keys off the latest `added` date across the
// catalog and a stray date would quietly re-flag a whole section as new.
const batchOn = (date) => new Set(DECISIONS.filter((q) => q.added === date).map((q) => q.id));
const sameSet = (a, b) => a.size === b.size && [...b].every((id) => a.has(id));
const w1rBatch = batchOn('2026-09-27');
const expectedBatch = new Set(['PAY-1', 'PAY-2', 'PAY-11', 'PAY-15', 'PAY-16']);
ok(sameSet(w1rBatch, expectedBatch),
  `the 2026-09-27 batch is exactly {PAY-1, PAY-2, PAY-11, PAY-15, PAY-16} (got ${[...w1rBatch].sort().join(', ')})`);
// The 2026-09-28 pair keeps its own date, and so do the 2026-09-29 follow-ups to Matt's
// answers (docs/plans/2026-09-29-phase-2-plan.md §5, F1–F18, 26 questions), and HUB-19
// (2026-10-03, profile photos in the Client Hub), and HR-1..HR-5 (2026-10-04), Matt's
// employee-warnings ask, in the new `hr` section, and HUB-20..HUB-23 (2026-10-08), the
// redesigned Client Hub's open points (docs/plans/2026-10-08-client-hub-redesign.md §2.2).
// The 2026-10-09 batch is WO-19 + SUP-14, the manager view redesign's two open points
// (docs/plans/2026-10-09-manager-view-redesign.md §2.2), and the same day's follow-ups to
// Matt's Account Manager Hub email: HUB-24 (messages and requests as one queue), WO-20 /
// WO-21 (deadlines by type; issues), SUP-15..SUP-17 (stock levels, a delivery step, who
// delivers). The 2026-10-16 batch is 20 of QR-7..QR-28: one printed code with a view
// for each person, printing, what a visitor can report, and what codes do when things change
// (docs/plans/2026-10-16-qr-codes-by-role.md §5). QR-11 and QR-29 are held and QR-22 was
// decided by Daniel before publishing, so those three ids are not in the catalog.
// The 2026-10-17 batch is MISC-7 and MISC-8 (Daniel, after the system-email review): the app's
// Quotes page beside PandaDoc, and where replies to the app's email go. The latest batch
// (2026-10-20) is DES-1, the menu down the left side, the first design question (UI_RULES §179),
// written 2026-10-23 and filed with the 13 emails updated on 2026-10-20 so they stay New together
// (Daniel, 2026-10-23: "Keep all 14 on New").
ok(sameSet(batchOn('2026-09-28'), new Set(['ALR-10', 'MISC-5'])),
  `the 2026-09-28 batch is exactly {ALR-10, MISC-5} — Matt's reminder-timing and checklist-photo questions (got ${[...batchOn('2026-09-28')].sort().join(', ')})`);
const followUps = new Set(['HUB-15', 'HUB-16', 'HUB-17', 'HUB-18', 'WO-16', 'WO-17', 'WO-18', 'SUP-9', 'SUP-10',
  'ALR-11', 'ALR-12', 'LOG-9', 'CON-14', 'QB-13', 'QB-14', 'LANG-10', 'LANG-11',
  'PAY-17', 'PAY-18', 'PAY-19', 'PAY-20', 'PAY-21', 'GO-9', 'GO-10', 'GO-11', 'MISC-6']);
ok(sameSet(batchOn('2026-09-29'), followUps),
  `the 2026-09-29 batch is exactly the 26 follow-ups (got ${[...batchOn('2026-09-29')].sort().join(', ')})`);
const latestAdded = DECISIONS.reduce((m, q) => (q.added > m ? q.added : m), '');
const latestBatch = batchOn(latestAdded);
ok(sameSet(batchOn('2026-10-03'), new Set(['HUB-19'])),
  `the 2026-10-03 batch is exactly HUB-19 (got ${[...batchOn('2026-10-03')].sort().join(', ')})`);
// 2026-10-04 also carries SUP-11..SUP-13, the three supplies calls the Supplies rebuild left
// for Matt: who may approve, a shared starting list, and how far back usage and spend go.
const hrBatch = new Set(['HR-1', 'HR-2', 'HR-3', 'HR-4', 'HR-5']);
const supBatch = new Set(['SUP-11', 'SUP-12', 'SUP-13']);
ok(sameSet(batchOn('2026-10-04'), new Set([...hrBatch, ...supBatch])),
  `the 2026-10-04 batch is exactly HR-1..HR-5 + SUP-11..SUP-13 (got ${[...batchOn('2026-10-04')].sort().join(', ')})`);
const hubRedesign = ['HUB-20', 'HUB-21', 'HUB-22', 'HUB-23'];
ok(sameSet(batchOn('2026-10-08'), new Set(hubRedesign)),
  `the 2026-10-08 batch is exactly HUB-20..HUB-23 (got ${[...batchOn('2026-10-08')].sort().join(', ')})`);
const mgrBatch = ['WO-19', 'SUP-14', 'HUB-24', 'WO-20', 'WO-21', 'SUP-15', 'SUP-16', 'SUP-17'];
ok(sameSet(batchOn('2026-10-09'), new Set(mgrBatch)),
  `the 2026-10-09 batch is exactly WO-19, SUP-14, HUB-24, WO-20, WO-21, SUP-15..SUP-17 (got ${[...batchOn('2026-10-09')].sort().join(', ')})`);
// The 22 ids of the 2026-10-16 batch (QR-11, QR-22 and QR-29 were taken out before publishing;
// QR-30 and QR-31, rating an area and a line about the company, came after Daniel saw the page).
const qrBatch = [7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23, 24, 25, 26, 27, 28, 30, 31].map((n) => `QR-${n}`);
ok(sameSet(batchOn('2026-10-16'), new Set(qrBatch)),
  `the 2026-10-16 batch is exactly the 22 QR questions (got ${[...batchOn('2026-10-16')].sort().join(', ')})`);
// The 2026-10-17 batch: MISC-7 and MISC-8 close the `misc` section, in order, each single and
// recommending (a); MISC-8 (d) "Another address" asks for a note. The oracle is the two
// questions as Daniel asked for them on 2026-10-17 ("let's add this as a question"), not the
// catalog under test.
const emailBatch = ['MISC-7', 'MISC-8'];
ok(sameSet(batchOn('2026-10-17'), new Set(emailBatch)),
  `the 2026-10-17 batch is exactly MISC-7 and MISC-8 (got ${[...batchOn('2026-10-17')].sort().join(', ')})`);
// The latest batch: DES-1 alone among the questions, dated with the 2026-10-20 email update (so
// "New" walks it and the 13 updated emails together), in its own `design` section (the last), single with no
// recommendation (Matt's pick), answers a-d for the four new menus, (e) keep today's, (f) another
// way with a note. The oracle is Daniel's ask on 2026-10-23 ("view these 4 mockups, or make a
// comment saying he will think of another way, or keep it the way it is"), not the catalog.
const designSection = DECISION_SECTIONS.find((s) => s.id === 'design');
ok(latestAdded === '2026-10-20' && sameSet(latestBatch, new Set(['DES-1'])),
  `the latest \`added\` batch is exactly DES-1 on 2026-10-20 (got ${latestAdded}: ${[...latestBatch].sort().join(', ')})`);
ok(!!designSection && DECISION_SECTIONS.at(-1) === designSection && designSection.questions.map((q) => q.id).join() === 'DES-1'
  && DECISION_BY_ID['DES-1']?.type === 'single' && optIds('DES-1').join() === 'a,b,c,d,e,f'
  && !DECISION_BY_ID['DES-1'].options.some((o) => o.rec) && DECISION_BY_ID['DES-1'].mockup === 'sidebar-directions'
  && DECISION_BY_ID['DES-1'].options.find((o) => o.id === 'f')?.needsNote === true,
  'DES-1 is the `design` section (the last), single with answers a..f and no recommendation, draws the sidebar mockup, and (f) asks for a note');
const miscSection = DECISION_SECTIONS.find((s) => s.id === 'misc');
const miscRecOf = (id) => (DECISION_BY_ID[id]?.options || []).filter((o) => o.rec).map((o) => o.id).join();
ok(!!miscSection && miscSection.questions.slice(-3).map((q) => q.id).join() === 'MISC-6,MISC-7,MISC-8'
  && DECISION_BY_ID['MISC-7']?.type === 'single' && optIds('MISC-7').join() === 'a,b,c' && miscRecOf('MISC-7') === 'a'
  && DECISION_BY_ID['MISC-8']?.type === 'single' && optIds('MISC-8').join() === 'a,b,c,d' && miscRecOf('MISC-8') === 'a'
  && DECISION_BY_ID['MISC-8'].options.find((o) => o.id === 'd')?.needsNote === true,
  'MISC-7 and MISC-8 close the misc section, in order, with their published types, option ids and recommendations; MISC-8 (d) asks for a note');
// They close the `qr` section, in order, with the published types, option ids and
// recommendations (the plan's §5 is the oracle, not the catalog under test).
const qrSection = DECISION_SECTIONS.find((s) => s.id === 'qr');
const qrIds = ['QR-1', 'QR-2', 'QR-3', 'QR-4', 'QR-5', 'QR-6', ...qrBatch];
ok(!!qrSection && qrSection.questions.map((q) => q.id).join() === qrIds.join(), 'the `qr` section holds QR-1..QR-6 and the 22 new questions, in order');
ok(['QR-11', 'QR-22', 'QR-29'].every((id) => !DECISION_BY_ID[id]), 'QR-11 and QR-29 (held) and QR-22 (decided) are not in the catalog');
const qrShape = {
  'QR-7': ['multi', 'a,b,c,d', 'a'], 'QR-8': ['single', 'a,b', 'a'], 'QR-9': ['text', '', ''], 'QR-10': ['single', 'a,b', 'a'],
  'QR-12': ['single', 'a,b,c', 'a'], 'QR-13': ['single', 'a,b', 'a'], 'QR-14': ['single', 'a,b,c', 'a'],
  'QR-15': ['single', 'a,b', ''], 'QR-16': ['single', 'a,b,c', 'a'], 'QR-17': ['single', 'a,b,c,d', 'a'], 'QR-18': ['single', 'a,b', 'a'],
  'QR-19': ['single', 'a,b,c', 'a'], 'QR-20': ['single', 'a,b', 'a'], 'QR-21': ['single', 'a,b', 'a'],
  'QR-23': ['multi', 'a,b,c,d,e,f', 'a,b,c,d,e'], 'QR-24': ['single', 'a,b,c', 'a'], 'QR-25': ['single', 'a,b', 'a'],
  'QR-26': ['single', 'a,b', 'b'], 'QR-27': ['single', 'a,b', 'a'], 'QR-28': ['single', 'a,b,c', 'a'],
  'QR-30': ['single', 'a,b,c', 'a'], 'QR-31': ['single', 'a,b,c,d', ''],
};
const qrRecOf = (id) => (DECISION_BY_ID[id]?.options || []).filter((o) => o.rec).map((o) => o.id).join();
const qrWrong = Object.entries(qrShape).filter(([id, [type, opts, rec]]) => DECISION_BY_ID[id]?.type !== type
  || optIds(id).join() !== opts || qrRecOf(id) !== rec);
ok(qrWrong.length === 0, `the 22 QR questions have their published types, option ids and recommendations (wrong: ${qrWrong.map(([id]) => id).join(', ') || 'none'})`);
ok(['QR-7', 'QR-16', 'QR-17', 'QR-28'].every((id) => DECISION_BY_ID[id]?.key === true)
  && qrBatch.filter((id) => DECISION_BY_ID[id]?.key).length === 4,
  'the QR batch flags exactly QR-7, QR-16, QR-17 and QR-28 as key decisions');
ok(DECISION_BY_ID['QR-7']?.options?.find((o) => o.id === 'd')?.needsNote === true
  && DECISION_BY_ID['QR-17']?.options?.find((o) => o.id === 'd')?.needsNote === true,
  'QR-7 (d) and QR-17 (d) ask for a note');
const recOf = (id) => (DECISION_BY_ID[id]?.options || []).filter((o) => o.rec).map((o) => o.id).join();
const woSection = DECISION_SECTIONS.find((s) => s.questions.some((q) => q.id === 'WO-1'));
ok(!!woSection && woSection.questions.slice(-3).map((q) => q.id).join() === 'WO-19,WO-20,WO-21'
  && ['WO-19', 'WO-20', 'WO-21'].every((id) => DECISION_BY_ID[id]?.type === 'single' && optIds(id).join() === 'a,b,c' && recOf(id) === 'a')
  && DECISION_BY_ID['WO-20'].options.find((o) => o.id === 'c')?.needsNote === true,
  'WO-19..WO-21 close the work orders section, in order, each single with options a, b, c, recommending (a); WO-20 (c) asks for a note');
const hubSection = DECISION_SECTIONS.find((s) => s.questions.some((q) => q.id === 'HUB-1'));
ok(!!hubSection && hubSection.questions.slice(-5).map((q) => q.id).join() === [...hubRedesign, 'HUB-24'].join()
  && hubRedesign.every((id) => DECISION_BY_ID[id]?.type === 'single' && optIds(id).join() === 'a,b'
    && DECISION_BY_ID[id].options.filter((o) => o.rec).map((o) => o.id).join() === 'a')
  && DECISION_BY_ID['HUB-24']?.type === 'single' && optIds('HUB-24').join() === 'a,b,c' && recOf('HUB-24') === 'a'
  && DECISION_BY_ID['HUB-24'].options.find((o) => o.id === 'c')?.needsNote === true,
  'HUB-20..HUB-24 close the Client Hub section, in order: HUB-20..23 single a, b, recommending (a); HUB-24 (messages and requests as one queue) single a, b, c, recommending (a), (c) asks for a note');
const supSection = DECISION_SECTIONS.find((s) => s.questions.some((q) => q.id === 'SUP-1'));
ok(!!supSection && supSection.questions.slice(-7).map((q) => q.id).join() === 'SUP-11,SUP-12,SUP-13,SUP-14,SUP-15,SUP-16,SUP-17'
  && ['SUP-11', 'SUP-12', 'SUP-13'].every((id) => DECISION_BY_ID[id]?.type === 'single' && optIds(id).join() === 'a,b,c')
  && DECISION_BY_ID['SUP-14']?.type === 'single' && optIds('SUP-14').join() === 'a,b' && recOf('SUP-14') === 'a'
  && ['SUP-15', 'SUP-16', 'SUP-17'].every((id) => DECISION_BY_ID[id]?.type === 'single' && optIds(id).join() === 'a,b,c' && recOf(id) === 'a'),
  'SUP-11..SUP-17 close the supplies section, in order: SUP-11..13 single a, b, c; SUP-14 single a, b, recommending (a); SUP-15..17 (stock levels, a delivery step, who delivers) single a, b, c, recommending (a)');
const hrSection = DECISION_SECTIONS.find((s) => s.id === 'hr');
ok(!!hrSection && hrSection.questions.map((q) => q.id).join() === 'HR-1,HR-2,HR-3,HR-4,HR-5',
  'the `hr` section holds exactly HR-1..HR-5, in order');
const hrShape = { 'HR-1': ['single', 'a,b,c'], 'HR-2': ['multi', 'a,b,c,d,e'], 'HR-3': ['single', 'a,b,c'],
  'HR-4': ['single', 'a,b,c,d'], 'HR-5': ['single', 'a,b,c,d'] };
ok(Object.entries(hrShape).every(([id, [type, opts]]) => DECISION_BY_ID[id]?.type === type && optIds(id).join() === opts
  && !DECISION_BY_ID[id].options.some((o) => o.rec)),
  'HR-1..HR-5 (employee warnings) have their published types and option ids, and recommend none: they are Matt\'s calls');
ok(DECISION_BY_ID['HUB-19']?.type === 'single' && JSON.stringify(optIds('HUB-19')) === JSON.stringify(['a', 'b', 'c'])
  && !DECISION_BY_ID['HUB-19'].options.some((o) => o.rec),
  'HUB-19 (cleaner photos in the Client Hub) is single with options [a, b, c] and recommends none: it is Matt\'s call');
ok(DECISION_BY_ID['MISC-5']?.type === 'single' && JSON.stringify(optIds('MISC-5')) === JSON.stringify(['a', 'b', 'c', 'd'])
  && DECISION_BY_ID['MISC-5'].options.filter((o) => o.rec).map((o) => o.id).join() === 'a'
  && DECISION_BY_ID['MISC-5'].options.find((o) => o.id === 'd')?.needsNote === true,
  'MISC-5 (CS-547, checklist photos) is single with options [a, b, c, d], recommends (a), and (d) asks for a note');

console.log(`build decisions: ${pass}/${pass + fail} passed  (${DECISION_SECTIONS.length} sections, ${DECISIONS.length} questions)`);
process.exit(fail ? 1 : 0);
