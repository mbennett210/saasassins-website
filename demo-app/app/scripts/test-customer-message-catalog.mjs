// ONE SOURCE FOR THE WORDS (Matt's approved messages, 2026-10-19).
//
// Matt accepted each customer message's wording in Review (the Drafts catalog). That wording must
// be what the office edits in Settings → Customer Reminders and what a customer receives, and the
// Drafts preview must keep showing exactly what goes out. So the text lives in ONE place,
// src/lib/customerMessages.js, and:
//   A. every approved message's template, filled with the Drafts sample, is word for word the
//      wording Matt accepted (app/scripts/fixtures/approved-messages.json, rendered from the
//      Drafts catalog at 811e54eb — brand values as «NAME», «PHONE», …); a draft the review freeze
//      RETIRED (src/data/reviewManifest.json retiredDrafts: the two review requests, 2026-10-20)
//      keeps its record there and must have NO catalog message;
//   B. the Drafts preview renders the catalog through the cron's own composer (composeMessage):
//      the preview IS the message, the opt-out line on the non-transactional ones included;
//   C. the seed's reminderTemplates are the catalog's defaults, every approved message ON,
//      the welcome email off, nothing seeded without a trigger;
//   D. the consent list of "nudges" is derived from the catalog's `transactional: false`.
//
// REGRESSION (THE LAW II.3): on 811e54eb there is no catalog — A, B (the composer), C and D fail.
//   node app/scripts/test-customer-message-catalog.mjs
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';

const APP = fileURLToPath(new URL('..', import.meta.url));
let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). Label first.
const ok = (label, cond, detail) => { if (cond) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`); };

// The browser modules the Drafts catalog imports read `import.meta.env` (Vite's) and import
// without extensions; this lets node load them as the build would, in a test-only mode.
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
const soft = async (rel) => { try { return await import(pathToFileURL(`${APP}${rel}`).href); } catch (e) { return { __error: e?.message || String(e) }; } };

const CM = await soft('src/lib/customerMessages.js');
const drafts = await soft('src/data/emailDrafts.js');
const seed = await soft('src/data/seed.js');
const consent = await soft('src/lib/contactConsent.js');
const { IDENTITY } = await import(pathToFileURL(`${APP}src/brand/identity.generated.js`).href);
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/approved-messages.json', import.meta.url), 'utf8')).drafts;
const RETIRED = JSON.parse(readFileSync(new URL('../src/data/reviewManifest.json', import.meta.url), 'utf8')).retiredDrafts || {};

const norm = (s) => (s == null ? s : String(s)
  .replaceAll(IDENTITY.appUrl, '«APP_URL»')
  .replaceAll(IDENTITY.company.signatory.name, '«SIGNATORY»')
  .replaceAll(IDENTITY.company.phone, '«PHONE»')
  .replaceAll(`${IDENTITY.monogram}-`, '«MONOGRAM»-')
  .replaceAll(IDENTITY.name, '«NAME»'));

const byDraft = CM.MESSAGE_BY_DRAFT_ID || {};
const SAMPLE = drafts.SAMPLE_TOKENS || null;
ok('the catalog loads', !!CM.CUSTOMER_MESSAGES, CM.__error);
ok('the Drafts catalog exports the sample it previews with (SAMPLE_TOKENS)', !!SAMPLE, drafts.__error);

// ── A. the approved wording ──────────────────────────────────────────────────
for (const [draftId, want] of Object.entries(FIXTURE)) {
  const m = byDraft[draftId];
  if (draftId in RETIRED) { ok(`A0 ${draftId}: RETIRED in the review freeze, so no catalog message carries it`, !m); continue; }
  ok(`A1 ${draftId}: a catalog message carries it`, !!m);
  if (!m || !SAMPLE) continue;
  const subject = norm(CM.interpolate(m.subject, SAMPLE)) || null;
  const body = norm(CM.interpolate(m.body, SAMPLE));
  ok(`🔴 A2 ${draftId}: the subject is word for word what Matt accepted`, (subject || null) === (want.subject || null), { subject, want: want.subject });
  ok(`🔴 A3 ${draftId}: the body is word for word what Matt accepted`, body === want.body, { body, want: want.body });
  const leftover = `${m.subject} ${m.body}`.match(/\{[a-z_]+\}/g)?.filter((t) => !(t.slice(1, -1) in SAMPLE)) || [];
  ok(`A4 ${draftId}: every token it uses is one the sample (and buildTokens) fills`, leftover.length === 0, leftover);
}
ok('A5 the fixture holds the 23 approved new messages (failed payment excluded) and the four approved existing ones', Object.keys(FIXTURE).length === 27 && !('failed-payment' in FIXTURE));
ok('A6 no sample value is baked into a template (the brand name, the sample customer or site)', (CM.CUSTOMER_MESSAGES || []).every((m) => !`${m.subject}${m.body}`.includes(IDENTITY.name) && !/Bayside|Jordan/.test(`${m.subject}${m.body}`)));

// ── B. the preview is the message ────────────────────────────────────────────
const list = drafts.EMAIL_DRAFTS || [];
for (const m of CM.CUSTOMER_MESSAGES || []) {
  const d = list.find((x) => x.id === m.draftId);
  ok(`B1 ${m.draftId}: the Drafts page shows it`, !!d);
  if (!d || !SAMPLE) continue;
  const shown = d.render();
  const sent = CM.composeMessage(m, null, SAMPLE, { unsubscribeUrl: 'X' });
  const sentBody = sent.body.replace(/unsubscribe here: X$/, 'unsubscribe here: ');
  const shownBody = String(shown.body || '').replace(/unsubscribe here: \S+$/, 'unsubscribe here: ');
  ok(`🔴 B2 ${m.draftId}: the preview's body is the composer's (what the cron sends)`, shownBody === sentBody, { shownBody, sentBody });
  if (m.channel === 'email') ok(`B3 ${m.draftId}: the preview's subject is the composer's`, shown.subject === sent.subject, { shown: shown.subject, sent: sent.subject });
  ok(`B4 ${m.draftId}: the opt-out line rides only the non-transactional ones`, /To stop these emails|Reply STOP to opt out/.test(sent.body) === (m.transactional === false));
  const expected = m.key === 'welcome_email' ? 'off' : (m.built ? 'live' : 'draft');
  ok(`B5 ${m.draftId}: its Drafts state says what it is (${expected})`, d.buildState === expected, d.buildState);
}
ok('B6 the composer reports a missing NEEDED token (a pay link)', typeof CM.composeMessage === 'function' && JSON.stringify(CM.composeMessage(CM.MESSAGE_BY_KEY?.upcoming_due, null, { ...SAMPLE, pay_link: '' }).missing) === '["pay_link"]');

// ── C. the seed ──────────────────────────────────────────────────────────────
const seeded = seed.INITIAL_STATE?.reminderTemplates || [];
ok('C1 the seed loads', seeded.length > 0, seed.__error);
for (const m of CM.CUSTOMER_MESSAGES || []) {
  const t = seeded.find((x) => x.key === m.key);
  if (!m.built && m.key !== 'welcome_email') { ok(`C2 ${m.key}: no trigger, so not seeded`, !t); continue; }
  ok(`C3 ${m.key}: seeded with the catalog's text and channel`, !!t && t.subject === m.subject && t.body === m.body && t.channel === m.channel, t);
  ok(`C4 ${m.key}: ${m.key === 'welcome_email' ? 'off' : 'ON'} by default (approved = on)`, !!t && t.enabled === (m.key !== 'welcome_email'), t?.enabled);
  ok(`C5 ${m.key}: its template id is the one the release data-op writes`, !!t && t.id === CM.templateIdFor(m.key), t?.id);
}
ok('C6 every seeded template is a catalog message', seeded.every((t) => !!CM.MESSAGE_BY_KEY?.[t.key]), seeded.map((t) => t.key));
ok('C7 the five templates that predate the catalog keep their stored ids', ['welcome_email', 'booking_confirmation', 'reminder_24h', 'day_of_eta', 'post_service'].every((k) => CM.templateIdFor?.(k) === CM.LEGACY_TEMPLATE_IDS?.[k] && /^rt_seed_/.test(CM.LEGACY_TEMPLATE_IDS?.[k])));

// ── D. consent ───────────────────────────────────────────────────────────────
const nudges = (CM.CUSTOMER_MESSAGES || []).filter((m) => m.transactional === false).map((m) => m.key).sort();
ok('D1 the consent list of nudges IS the catalog\'s non-transactional messages', consent.NON_TRANSACTIONAL_REMINDER_KEYS instanceof Set && JSON.stringify([...consent.NON_TRANSACTIONAL_REMINDER_KEYS].sort()) === JSON.stringify(nudges), { consent: [...(consent.NON_TRANSACTIONAL_REMINDER_KEYS || [])], nudges });
ok('D2 the plan\'s nudges are among them (renewal offer, upsell, win-back, the survey; the review requests left with Google reviews)', ['renewal_offer', 'upsell', 'win_back', 'satisfaction_survey'].every((k) => nudges.includes(k)));

console.log(`test-customer-message-catalog: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
