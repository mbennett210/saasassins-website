// WAITING ON US (CS-864, Daniel's pick A from the mockup, 2026-10-23). A draft the client sent back
// with a note counted as resolved (lib/clientReview isDraftResolved: any note), so it left the
// attention count and the open list, and only the amber badge seen while walking Drafts showed it:
// Matt's ten change requests of 2026-09-30 sat unseen until 2026-10-17. Now it has its own place.
//   L  the rule (lib/clientReview): waiting = a note on the draft's current words with no
//      acceptance (isDraftWaitingOnUs); a change of words after the note puts it back in Drafts to
//      sign off as New; Request changes with no note yet still owes the note; retired drafts never
//      count; reviewSummary gives the count and ids and leaves `attention` as it was
//   H  the hub, RENDERED with the real provider over a stubbed store: a Waiting on us tile after
//      Drafts to sign off ("N sent back to us", an amber full ring round N) and "· N waiting on us"
//      on the hero's line, the attention figure unchanged; nothing drawn while nothing waits (the
//      production shape today: every note older than the change that answered it)
//   W  its list (?area=waiting): each waiting draft, the day it came back, its note and Open the
//      draft; an empty list says so
//   C  a sent-back draft's card: the amber "Waiting on us" badge and the line under its verdict
// REGRESSION (THE LAW II.3): on 6b35afb1 (the tree before it) 21 of the 28 checks fail; the 7 that
// pass there are the two controls, what the fix leaves as it was (L9 and H4, the attention count;
// L10, the draft we changed since its note) and H5 and C3 (nothing waiting, nothing drawn).
//   node app/scripts/test-review-waiting.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { rolldown } from 'rolldown';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). Label first.
const ok = (label, cond, detail) => { if (cond) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`); };
registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx); } catch (err) {
      const base = spec.split('/').pop() || spec;
      if ((spec.startsWith('./') || spec.startsWith('../')) && !base.includes('.')) return next(`${spec}.js`, ctx);
      throw err;
    }
  },
  load(url, ctx, next) {
    const r = next(url, ctx);
    if (url.startsWith('file:') && url.includes('/src/') && r.source) {
      return { ...r, source: String(r.source).replaceAll('import.meta.env', '({ MODE: "test", PROD: false, DEV: false })') };
    }
    return r;
  },
});
const soft = async (rel) => { try { return await import(pathToFileURL(path.join(APP, rel)).href); } catch (e) { return { __error: e?.message || String(e) }; } };

const CR = await soft('src/lib/clientReview.js');
const IDS = await soft('src/data/emailDraftIds.js');
const BD = await soft('src/data/buildDecisionIds.js');
const ids = IDS.EMAIL_DRAFT_IDS || [];
const CHANGED = IDS.EMAIL_DRAFT_CHANGED || {};
const ADDED = IDS.EMAIL_DRAFT_ADDED || {};
const INDEX = BD.BUILD_DECISION_INDEX || [];
ok('control: the review rules and both catalog indexes load', typeof CR.reviewSummary === 'function' && ids.length > 0 && INDEX.length > 0, CR.__error || IDS.__error || BD.__error);

// A draft never changed (no EMAIL_DRAFT_CHANGED day) and one that was, from the live catalog.
const PLAIN = ids.find((id) => !CHANGED[id] && !ADDED[id]);
const CHANGED_ID = ids.find((id) => CHANGED[id]);
const DAY = CHANGED[CHANGED_ID];
const note = (text, at) => ({ id: `n_${at}`, text, at });
const SENT = '2026-10-23T15:40:00.000Z';
const OLD = '2026-09-30T14:41:20.445Z';
const waiting = typeof CR.isDraftWaitingOnUs === 'function' ? CR.isDraftWaitingOnUs : () => undefined;

// ── L. the rule ───────────────────────────────────────────────────────────────────────────
ok('🔴 L1 sent back (Request changes + a note) on words never changed: waiting on us', waiting({ status: 'changes', at: SENT, notes: [note('Less formal, please.', SENT)] }, null) === true);
ok('🔴 L2 a note alone, with no verdict: waiting on us too (it came back with a note)', waiting({ notes: [note('Say the account manager will call.', SENT)] }, null) === true);
ok('🔴 L3 a legacy single-string note counts as the note', waiting({ status: 'changes', at: OLD, note: 'this is done in panda docs' }, null) === true);
ok('L4 accepted, with or without a note: not waiting', waiting({ status: 'accepted', at: SENT, notes: [note('Looks good.', SENT)] }, null) === false
  && waiting({ status: 'accepted', at: SENT }, null) === false);
ok('🔴 L5 Request changes with no note yet: not waiting (it still owes the note)', waiting({ status: 'changes', at: SENT }, null) === false);
ok('🔴 L6 the note is older than our change of words: not waiting (back in Drafts to sign off)', !!DAY && waiting({ status: 'changes', at: OLD, notes: [note('x', OLD)] }, DAY) === false);
ok('🔴 L7 sent back again after our change: waiting', !!DAY && waiting({ status: 'changes', at: SENT, notes: [note('old', OLD), note('Still too long.', SENT)] }, DAY) === true);

const review = (drafts, decisions = {}) => ({ sections: {}, picks: {}, decisions, drafts });
const sum = (r) => (typeof CR.reviewSummary === 'function' ? CR.reviewSummary(r, INDEX, ids, ADDED, CHANGED) : {});
const backAt = { status: 'changes', at: SENT, notes: [note('Make this sound less formal.', SENT)] };
const changedLater = { status: 'changes', at: OLD, notes: [note('this is done differently', OLD)] };
const s1 = sum(review({ [PLAIN]: backAt, [CHANGED_ID]: changedLater, 'quote-doc': { status: 'changes', at: SENT, notes: [note('retired', SENT)] } }));
ok('🔴 L8 reviewSummary counts the waiting drafts and lists them (catalog ids only; a retired one never)',
  s1.waitingDrafts === 1 && JSON.stringify(s1.waitingDraftIds) === JSON.stringify([PLAIN]), { waitingDrafts: s1.waitingDrafts, ids: s1.waitingDraftIds });
const s0 = sum(review({}));
ok('🔴 L9 …and leaves "need your attention" as it was: a waiting draft is not pending and not added on top',
  s1.attention === s1.openDecisions + s1.pendingDrafts && s1.pendingDrafts === s0.pendingDrafts - 1 && s1.attention === s0.attention - 1,
  { s1: [s1.attention, s1.pendingDrafts], s0: [s0.attention, s0.pendingDrafts] });
ok('L10 the draft changed after its note is pending again, and New on its change day', !!DAY && !s1.waitingDraftIds?.includes(CHANGED_ID)
  && (s1.latestUpdate !== DAY || s1.newDraftIds.includes(CHANGED_ID)));
const wn = typeof CR.waitingNotes === 'function' ? CR.waitingNotes : () => [];
ok('🔴 L11 the notes it came back with: those on its current words, else the newest',
  JSON.stringify(wn({ notes: [note('old', OLD), note('new', SENT)] }, DAY).map((n) => n.text)) === JSON.stringify(['new'])
  && JSON.stringify(wn({ status: 'changes', at: SENT, notes: [note('old', OLD)] }, DAY).map((n) => n.text)) === JSON.stringify(['old'])
  && JSON.stringify(wn({ note: 'legacy', notes: [note('second', SENT)] }, null).map((n) => n.text)) === JSON.stringify(['legacy', 'second']));

// ── H, W, C. rendered: the real provider, hub, list and card over a stubbed store ─────────────
const CACHE = path.join(APP, 'node_modules', '.cache');
fs.mkdirSync(CACHE, { recursive: true });
const tmp = fs.mkdtempSync(path.join(CACHE, 'test-review-waiting-'));
const abs = (...p) => JSON.stringify(path.join(APP, ...p).split(path.sep).join('/'));
const hasWaitingList = fs.existsSync(path.join(APP, 'src', 'pages', 'review', 'ReviewWaiting.jsx'));
fs.writeFileSync(path.join(tmp, 'entry.jsx'), `import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import { ClientReviewProvider } from ${abs('src', 'store', 'ClientReviewProvider.jsx')};
import ReviewHub from ${abs('src', 'pages', 'review', 'ReviewHub.jsx')};
import DraftCard from ${abs('src', 'pages', 'review', 'DraftCard.jsx')};
import { EMAIL_DRAFTS } from ${abs('src', 'data', 'emailDrafts.js')};
${hasWaitingList ? `import ReviewWaiting from ${abs('src', 'pages', 'review', 'ReviewWaiting.jsx')};` : 'const ReviewWaiting = () => null;'}
const inReview = (el) => (state) => { globalThis.__REVIEW_TEST_STATE = state; return renderToStaticMarkup(h(ClientReviewProvider, null, el)); };
export const hub = inReview(h(ReviewHub, { onOpenArea() {} }));
export const list = inReview(h(ReviewWaiting, { onExit() {}, onOpenDraft() {} }));
export const card = (id) => inReview(h(DraftCard, { draft: EMAIL_DRAFTS.find((d) => d.id === id) }));
`);
const SHIMS = {
  '\0store': `export function useSelector(select) { return select(globalThis.__REVIEW_TEST_STATE); }
export function useDispatch() { return () => {}; }
export function useStore() { return globalThis.__REVIEW_TEST_STATE; }`,
  '\0reducer': 'export const ACTIONS = new Proxy({}, { get: (_, k) => String(k) });',
  '\0toast': `const no = () => {};
export function useToast() { return { success: no, error: no, info: no, warning: no }; }
export default function Toast() { return null; }`,
  '\0confirm': 'export default function ConfirmDialog() { return null; }',
  '\0preview': 'export default function DraftPreview() { return null; }',
  '\0i18n-react': `export function useT() { return (k) => k; }
export function useLanguage() { return 'en'; }`,
};
const plugin = {
  name: 'review-waiting-test',
  resolveId(id, importer) {
    const from = importer || '';
    if (/[\\/]store[\\/]ClientReviewProvider\.jsx$/.test(from) && /^\.\/index(\.jsx?)?$/.test(id)) return '\0store';
    if (/[\\/]store[\\/]ClientReviewProvider\.jsx$/.test(from) && /^\.\/reducer(\.js)?$/.test(id)) return '\0reducer';
    if (/(^|[\\/])Toast(\.jsx)?$/.test(id)) return '\0toast';
    if (/(^|[\\/])ConfirmDialog(\.jsx)?$/.test(id)) return '\0confirm';
    if (/(^|[\\/])DraftPreview(\.jsx)?$/.test(id)) return '\0preview';
    if (/(^|[\\/])i18n[\\/]react(\.jsx?)?$/.test(id)) return '\0i18n-react';
    return null;
  },
  load(id) { return Object.hasOwn(SHIMS, id) ? SHIMS[id] : null; },
};
let views = null;
try {
  const bundle = await rolldown({
    input: path.join(tmp, 'entry.jsx'), platform: 'node', cwd: APP, logLevel: 'silent', plugins: [plugin],
    transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ MODE: 'test', PROD: false, DEV: false, SSR: true }) } },
    moduleTypes: { '.html': 'text' },
  });
  await bundle.write({ file: path.join(tmp, 'views.mjs'), format: 'esm' });
  views = await import(pathToFileURL(path.join(tmp, 'views.mjs')).href);
} catch (e) {
  fails.push(`the Review hub, the Waiting on us list and the draft card bundle (${String(e?.message || e).split('\n')[0]})`);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
const draw = (fn, state) => { try { return fn(state); } catch (e) { fails.push(`render: ${String(e?.message || e).split('\n')[0]}`); return ''; } };
const text = (s) => String(s || '').replace(/<!-- -->/g, '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ').trim();
const STATE = (drafts, decisions = {}) => ({ clientReview: review(drafts, decisions) });
const tiles = (html) => [...html.matchAll(/<button type="button" class="(review-tile[^"]*)"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => ({ cls: m[1], text: text(m[2]) }));

if (views) {
  // H. one sent back (PLAIN), one we changed since (CHANGED_ID, Matt's Sep 30 shape)
  const one = STATE({ [PLAIN]: backAt, [CHANGED_ID]: changedLater });
  const hubHtml = draw(views.hub, one);
  const t = tiles(hubHtml);
  const last = t[t.length - 1] || {};
  const prev = t[t.length - 2] || {};
  ok('control: the hub renders its tiles, Drafts to sign off among them', t.some((x) => x.text.includes('Drafts to sign off')), t.map((x) => x.text));
  ok('🔴 H1 a Waiting on us tile comes right after Drafts to sign off', /Waiting on us/.test(last.text) && /Drafts to sign off/.test(prev.text), t.slice(-2).map((x) => x.text));
  ok('🔴 H2 …saying "1 sent back to us", amber (is-waiting), its ring a full amber arc round "1"',
    /1 sent back to us/.test(last.text) && /\bis-waiting\b/.test(last.cls)
    && /class="review-ring-fill is-warn"/.test(hubHtml) && /<text class="review-ring-num"[^>]*>1<\/text>/.test(hubHtml.slice(hubHtml.lastIndexOf('review-tile is-waiting'))), last);
  const sub = text(/class="review-hero-sub"[^>]*>([\s\S]*?)<\/div>/.exec(hubHtml)?.[1]);
  ok('🔴 H3 the hero line ends "· 1 waiting on us"', /drafts pending · 1 waiting on us$/.test(sub), sub);
  const want = sum(review({ [PLAIN]: backAt, [CHANGED_ID]: changedLater }));
  const num = Number(text(/class="review-hero-num"[^>]*>([\s\S]*?)<\/div>/.exec(hubHtml)?.[1]));
  ok('H4 the attention figure is the open questions plus the pending drafts, the waiting one not in it', num === want.attention && num === want.openDecisions + want.pendingDrafts && new RegExp(`· ${want.pendingDrafts} drafts pending`).test(sub), { num, want: want.attention });

  // Nothing waiting: the production shape today (every note older than the change that answered it).
  const none = STATE({ [CHANGED_ID]: changedLater });
  const hubNone = draw(views.hub, none);
  ok('H5 nothing waiting: no tile and no "waiting on us" on the hub', !!hubNone && !/Waiting on us|waiting on us/.test(text(hubNone)) && !/is-waiting/.test(hubNone));

  // All caught up, one still with us: the caught-up line says so.
  const allDone = { decisions: {}, drafts: {} };
  for (const d of INDEX) allDone.decisions[d.id] = { choice: 'a', at: SENT };
  for (const id of ids) allDone.drafts[id] = { status: 'accepted', at: SENT };
  allDone.drafts[PLAIN] = backAt;
  const hubCaught = draw(views.hub, STATE(allDone.drafts, allDone.decisions));
  ok('🔴 H6 all caught up with one sent back: "Nothing needs your attention right now · 1 waiting on us."',
    /You’re all caught up/.test(text(hubCaught)) && /Nothing needs your attention right now · 1 waiting on us ?\./.test(text(hubCaught)) && /is-waiting/.test(hubCaught), text(hubCaught).slice(0, 220));

  // W. the list
  const listHtml = draw(views.list, one);
  const lt = text(listHtml);
  ok('🔴 W1 the list is headed Waiting on us with its count, and says nothing in it needs the client', /All areas Waiting on us 1/.test(lt) && /Nothing here needs you\./.test(lt), lt.slice(0, 200));
  const rows = [...listHtml.matchAll(/<div class="review-wait-row">([\s\S]*?)<\/button><\/div>/g)].map((m) => text(m[1]));
  ok('🔴 W2 one row: the draft\'s name, "Sent back Oct 23", the note it came back with and Open the draft',
    rows.length === 1 && /Sent back Oct 23/.test(rows[0]) && rows[0].includes('Make this sound less formal.') && /Open the draft →$/.test(rows[0]), rows);
  ok('🔴 W3 the draft we changed since is not in it', rows.length === 1 && !/this is done differently/.test(lt));
  const listNone = text(draw(views.list, none));
  ok('W4 nothing waiting: the list says so', /Nothing is waiting on us/.test(listNone), listNone.slice(0, 160));

  // C. the card
  const cardHtml = draw(views.card(PLAIN), one);
  const meta = /class="review-meta"[^>]*>([\s\S]*?)<div class="review-q"/.exec(cardHtml)?.[1] || '';
  ok('🔴 C1 a sent-back draft\'s card wears the amber "Waiting on us" badge in place of "Changes requested"',
    /class="[^"]*\bamber\b[^"]*"[^>]*>Waiting on us</.test(meta) && !/Changes requested/.test(text(meta)), text(meta));
  ok('🔴 C2 …and says it under its verdict: "Waiting on us. We’re changing the words to match your note."',
    /class="review-wait-callout"/.test(cardHtml) && /Waiting on us\. We’re changing the words to match your note\. It comes back here marked New for a fresh look\./.test(text(cardHtml))
    && cardHtml.indexOf('review-wait-callout') > cardHtml.indexOf('drafts-verdict'), text(cardHtml).slice(0, 300));
  const cardChanged = draw(views.card(CHANGED_ID), one);
  ok('C3 a draft we changed since its note: no waiting badge, no waiting line', !!cardChanged && !/Waiting on us/.test(text(cardChanged)));
}

// ── wiring the hub to the list ────────────────────────────────────────────────────────────
const reviewPage = (() => { try { return fs.readFileSync(path.join(APP, 'src', 'pages', 'Review.jsx'), 'utf8'); } catch { return ''; } })();
ok('🔴 R1 the Review page draws the list for ?area=waiting, its Open the draft pushing Drafts to sign off at that draft',
  /area === 'waiting'[\s\S]{0,80}<ReviewWaiting/.test(reviewPage) && /onOpenDraft=\{\(id\) => setParams\(\{ area: 'drafts', item: id \}, \{ replace: false \}\)\}/.test(reviewPage));
ok('🔴 R2 the hub\'s tile opens it as a list (pushed, so Back returns to the hub), not a walk', /if \(a === 'waiting'\) \{ setParams\(\{ area: a \}, \{ replace: false \}\); return; \}/.test(reviewPage));

console.log(`test-review-waiting: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
}
