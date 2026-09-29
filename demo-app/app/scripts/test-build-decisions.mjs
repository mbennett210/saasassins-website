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

console.log(`build decisions: ${pass}/${pass + fail} passed  (${DECISION_SECTIONS.length} sections, ${DECISIONS.length} questions)`);
process.exit(fail ? 1 : 0);
