// THE REVIEW SECTION'S DRAFTS, BROUGHT IN LINE WITH WHAT GOES OUT (Daniel, 2026-10-20: "Make the
// changes"), under the review freeze (CS-402, UI_RULES §130): Matt's earlier answers stay attached,
// and every new or changed entry surfaces as New for him.
//   N  six NEW entries for emails that already go out, each rendered by its REAL builder: the four
//      customer-hub emails (src/lib/clientHubEmails.js) and the two sign-in emails ("Set up your …
//      account", "Reset your … password": setPasswordEmail, moved to the shared src/lib/signInEmail.js
//      so the preview can import it); published in the freeze and dated in EMAIL_DRAFT_ADDED
//   T  "Team invitation" (the demo-only invite staff never get) is RETIRED and the real account-setup
//      email takes its place under a NEW id, so Matt's acceptance of the old one cannot transfer to
//      the new words: it is unanswered and New
//   Q  "Quote email" is RETIRED (nothing sends it); its builder, src/lib/email.js buildQuoteEmail,
//      and the demo sign-request builder go with it (replace-means-delete)
//   S  the e-signature emails' builders live in the shared src/lib/quoteEmails.js; api/_lib/quotes/emails.js
//      is gone and the routes import the one copy. (Their two drafts, "E-signature request" and
//      "Signed-agreement copy", were retired on 2026-10-23 with the Quotes page, which Matt keeps in
//      PandaDoc: test-quotes-hidden.mjs holds that, so their render checks S1/S2 left with them.)
//   P  the inspection report preview carries sample photos: under each area, captioned Before /
//      After, and the rest under "Additional photos"
//   W  the welcome email takes Matt's own wording from his Drafts note, the brand's phone and name
//      as tokens, and stays switched off
//   B  Invoice sent, Payment receipt and Past-due notice read "Sent by QuickBooks, not the app"
//   C  CHANGED entries (EMAIL_DRAFT_CHANGED): one answered BEFORE its change is open again and New,
//      its answer and notes still attached; one answered after it is not; the pending count follows
//   F  the freeze: the new ids are published, the retired ones listed with a reason
// REGRESSION (THE LAW II.3): on 4ee4ca15 (the tree before it) 35 checks fail; the rest are skipped
// there (no EMAIL_DRAFT_CHANGED) or are the control.
//   node app/scripts/test-review-drafts-update.mjs
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';

const APP = fileURLToPath(new URL('..', import.meta.url));
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
const soft = async (rel) => { try { return await import(pathToFileURL(`${APP}${rel}`).href); } catch (e) { return { __error: e?.message || String(e) }; } };
const read = (rel) => { try { return readFileSync(`${APP}${rel}`, 'utf8'); } catch { return ''; } };

const D = await soft('src/data/emailDrafts.js');
const IDS = await soft('src/data/emailDraftIds.js');
const CR = await soft('src/lib/clientReview.js');
const CM = await soft('src/lib/customerMessages.js');
const HUB = await soft('src/lib/clientHubEmails.js');
const SIGNIN = await soft('src/lib/signInEmail.js');
const SHARED = await soft('src/pages/review/reviewShared.js');
const { IDENTITY } = await import(pathToFileURL(`${APP}src/brand/identity.generated.js`).href);
let manifest = {};
try { manifest = JSON.parse(read('src/data/reviewManifest.json')); } catch { manifest = {}; }
ok('control: the Drafts catalog loads', Array.isArray(D.EMAIL_DRAFTS), D.__error);
const byId = Object.fromEntries((D.EMAIL_DRAFTS || []).map((d) => [d.id, d]));
const draftIds = IDS.EMAIL_DRAFT_IDS || [];
const added = IDS.EMAIL_DRAFT_ADDED || {};
const changed = IDS.EMAIL_DRAFT_CHANGED || null;
const render = (id) => { try { return byId[id]?.render?.(); } catch (e) { return { __error: e.message }; } };
const UPDATE = '2026-10-20';

// ── N. the six new entries, from the real builders ──────────────────────────────────────────
const H = D.SAMPLE_HUB || {};
const NEW = {
  'hub-request-update': () => HUB.hubTicketStatusEmail?.({ brandName: H.brandName, buildingName: H.buildingName, ticketTitle: H.ticketTitle, stageLabel: H.stageLabel, link: H.ticketLink }),
  'hub-request-reply': () => HUB.hubTicketReplyEmail?.({ brandName: H.brandName, buildingName: H.buildingName, ticketTitle: H.ticketTitle, author: H.author, replyBody: H.replyBody, link: H.ticketLink }),
  'hub-inspection-posted': () => HUB.hubInspectionEmail?.({ brandName: H.brandName, buildingName: H.buildingName, inspectionName: H.inspectionName, resultLabel: H.resultLabel, score: H.score, link: H.inspectionLink }),
  'hub-office-message': () => HUB.hubMessageReplyEmail?.({ brandName: H.brandName, buildingName: H.buildingName, author: H.author, replyBody: H.messageBody, link: H.messagesLink }),
  'account-setup': () => SIGNIN.setPasswordEmail?.(D.SAMPLE_SIGN_IN_LINK, 'invite'),
  'password-reset': () => SIGNIN.setPasswordEmail?.(D.SAMPLE_SIGN_IN_LINK, 'reset'),
};
for (const [id, build] of Object.entries(NEW)) {
  const want = build();
  const got = render(id);
  ok(`🔴 N1 ${id}: in the catalog, rendered by its real builder (the same subject and HTML the sender sends)`, !!byId[id] && !!want && got?.subject === want.subject && got?.html === want.html && !!want.html, { got: got?.subject, want: want?.subject });
  ok(`N2 ${id}: published in the freeze and dated ${UPDATE} (so it is New)`, draftIds.includes(id) && (manifest.drafts || []).includes(id) && added[id] === UPDATE);
}
ok('N3 the sign-in emails name the software ("Set up your … account", "Reset your … password")',
  render('account-setup')?.subject === `Set up your ${IDENTITY.product.name} account` && render('password-reset')?.subject === `Reset your ${IDENTITY.product.name} password`);
ok('N4 the hub emails link to the hub on the app\'s address', [H.ticketLink, H.inspectionLink, H.messagesLink].every((l) => typeof l === 'string' && l.startsWith(`${IDENTITY.appUrl}/hub/b/`)));
const users = read('api/_lib/users.js');
ok('🔴 N5 setPasswordEmail lives in ONE place, src/lib/signInEmail.js; the server imports it', typeof SIGNIN.setPasswordEmail === 'function'
  && /import \{ setPasswordEmail \} from '\.\.\/\.\.\/src\/lib\/signInEmail\.js';/.test(users) && !/function setPasswordEmailHtml|export function setPasswordEmail/.test(users));

// ── T. the team invitation → the real account-setup email, under a new id ───────────────────
ok('🔴 T1 "Team invitation" is RETIRED (off the catalog, its id kept in the freeze with a reason)', !byId['team-invite'] && !draftIds.includes('team-invite')
  && (manifest.drafts || []).includes('team-invite') && !!manifest.retiredDrafts?.['team-invite']?.reason);
ok('T2 the account-setup email takes its place (the Staff and sign-in group) under a NEW id, so no earlier answer attaches to it',
  byId['account-setup']?.category === byId['password-reset']?.category && !!byId['account-setup'] && byId['account-setup'].id !== 'team-invite');
if (typeof CR.reviewSummary === 'function') {
  const matt = { sections: {}, picks: {}, decisions: {}, drafts: { 'team-invite': { status: 'accepted', at: '2026-09-30T14:46:46.810Z' } } };
  const s = CR.reviewSummary(matt, [], draftIds, added, changed || {});
  ok('🔴 T3 Matt\'s acceptance of the old invite does not transfer: the account-setup email is New and pending', s.newDraftIds.includes('account-setup') && s.latestUpdate === UPDATE);
}

// ── Q. the quote email ─────────────────────────────────────────────────────────────────────
ok('🔴 Q1 "Quote email" is RETIRED (nothing sends it)', !byId['quote-email'] && !draftIds.includes('quote-email') && !!manifest.retiredDrafts?.['quote-email']?.reason);
const clientEmail = read('src/lib/email.js');
ok('Q2 its builder and the demo-only sign-request builder are deleted from src/lib/email.js', clientEmail.length > 0 && !/export function buildQuoteEmail|export function buildSignRequestEmail/.test(clientEmail));

// ── S. the e-signature emails, from the server's own builders ───────────────────────────────
// (S1/S2, the two drafts' renders, retired with the drafts on 2026-10-23: test-quotes-hidden.mjs.)
ok('S3 the builders live in ONE place: api/_lib/quotes/emails.js is gone and the routes import src/lib/quoteEmails.js', !existsSync(`${APP}api/_lib/quotes/emails.js`)
  && /from '\.\.\/\.\.\/src\/lib\/quoteEmails\.js'/.test(read('api/quotes/[...path].js')) && /from '\.\.\/\.\.\/\.\.\/src\/lib\/quoteEmails\.js'/.test(read('api/public/pay/[...path].js')));
ok('S4 the preview renders an HTML email inside the mail card', /rendered\.html/.test(read('src/pages/review/DraftPreview.jsx')) && /drafts-mailbody-html/.test(read('src/pages/review/DraftPreview.jsx')));

// ── P. the inspection report's sample photos ───────────────────────────────────────────────
const rep = render('inspection-report');
const html = String(rep?.html || '');
const sections = html.split('<section class="ir-sec').slice(1);
const areaSecs = sections.filter((s) => !/Additional photos|Before \/ After/.test(s));
ok('🔴 P1 every area of the sample report shows its photos', areaSecs.length >= 3 && areaSecs.every((s) => /class="ir-photo"/.test(s)), areaSecs.length);
ok('P2 …each marked Before or After', areaSecs.every((s) => /<figcaption class="ir-cap">Before/.test(s) && /<figcaption class="ir-cap">After/.test(s)));
ok('P3 …and the rest under "Additional photos"', sections.some((s) => /Additional photos/.test(s) && /class="ir-photo"/.test(s)));

// ── W. the welcome email: Matt's own wording ───────────────────────────────────────────────
const welcome = CM.MESSAGE_BY_KEY?.welcome_email;
ok('🔴 W1 the welcome email\'s words are Matt\'s (his Drafts note), the phone and name as tokens', welcome?.body === 'Hi {client_contact},\n\nWelcome aboard. We will contact you with the next steps.\n\nQuestions? Reply to this email or call us at {company_phone}.\n\nThe {company} team', welcome?.body);
ok('W2 …and it stays switched off with no trigger', welcome?.enabledByDefault === false && welcome?.built === false && byId['reminder-welcome']?.buildState === 'off');
const wr = render('reminder-welcome');
ok('W3 the preview reads as his note did, the brand\'s phone and name filled in', String(wr?.body || '').startsWith(`Hi ${D.SAMPLE_TOKENS?.client_contact},\n\nWelcome aboard. We will contact you with the next steps.\n\nQuestions? Reply to this email or call us at ${IDENTITY.company.phone}.\n\nThe ${IDENTITY.name} team`), wr?.body);

// ── B. sent by QuickBooks ──────────────────────────────────────────────────────────────────
ok('🔴 B1 the state reads "Sent by QuickBooks, not the app"', SHARED.DRAFT_STATE_LABEL?.quickbooks === 'Sent by QuickBooks, not the app');
ok('B2 Invoice sent, Payment receipt and Past-due notice carry it', ['invoice-sent', 'payment-receipt', 'past-due'].every((id) => byId[id]?.buildState === 'quickbooks'));
ok('B3 the tag has its style (tokens only)', /\.drafts-state\.quickbooks \{ background: var\(--[a-z-]+\); color: var\(--[a-z-]+\); \}/.test(read('src/index.css')));

// ── C. changed entries surface as New, answers kept ────────────────────────────────────────
const CHANGED = ['inspection-report', 'reminder-welcome', 'invoice-sent', 'payment-receipt', 'past-due'];
ok('🔴 C1 EMAIL_DRAFT_CHANGED dates every changed entry', !!changed && CHANGED.every((id) => changed[id] === UPDATE) && Object.keys(changed).every((id) => draftIds.includes(id)), changed);
if (typeof CR.reviewSummary === 'function' && changed) {
  const before = (id) => ({ status: 'changes', at: '2026-09-30T14:41:20.445Z', sitting: 's1', notes: [{ id: `n_${id}`, text: 'this is done in panda docs', at: '2026-09-30T14:41:21.000Z' }] });
  const review = { sections: {}, picks: {}, decisions: {}, drafts: Object.fromEntries(CHANGED.map((id) => [id, before(id)])) };
  review.drafts['lead-ack'] = { status: 'accepted', at: '2026-09-30T14:40:00.000Z' };
  const frozen = JSON.stringify(review);
  const s = CR.reviewSummary(review, [], draftIds, added, changed);
  ok('🔴 C2 an entry answered BEFORE its change is New again', CHANGED.every((id) => s.newDraftIds.includes(id)), s.newDraftIds);
  ok('C3 …and counts as pending again (it needs another look)', s.pendingDrafts === draftIds.length - 1, s.pendingDrafts);
  ok('C4 …its answer and notes stay attached, untouched', JSON.stringify(review) === frozen && typeof CR.isDraftCurrent === 'function' && !CR.isDraftCurrent(review.drafts['invoice-sent'], UPDATE) && CR.isDraftResolved(review.drafts['invoice-sent']));
  const after = { ...review, drafts: { ...review.drafts, 'invoice-sent': { ...review.drafts['invoice-sent'], status: 'accepted', at: '2026-10-21T10:00:00.000Z' } } };
  const s2 = CR.reviewSummary(after, [], draftIds, added, changed);
  ok('C5 answered AFTER the change, it is current again: not New, not pending', !s2.newDraftIds.includes('invoice-sent') && s2.pendingDrafts === s.pendingDrafts - 1);
  const noted = { ...review, drafts: { ...review.drafts, 'past-due': { ...review.drafts['past-due'], notes: [...review.drafts['past-due'].notes, { id: 'n2', text: 'ok', at: '2026-10-21T10:00:00.000Z' }] } } };
  ok('C6 a note added after the change counts as the fresh look too', !CR.reviewSummary(noted, [], draftIds, added, changed).newDraftIds.includes('past-due'));
  ok('C7 an unchanged entry answered long ago stays resolved (lead-ack)', !s.newDraftIds.includes('lead-ack'));
}
const provider = read('src/store/ClientReviewProvider.jsx');
ok('C8 the provider counts with EMAIL_DRAFT_CHANGED and the hub and the open list ask it (isDraftOpen), not isDraftResolved alone',
  /reviewSummary\(review, BUILD_DECISION_INDEX, EMAIL_DRAFT_IDS, EMAIL_DRAFT_ADDED, EMAIL_DRAFT_CHANGED\)/.test(provider) && /isDraftOpen/.test(provider)
  && !/isDraftResolved\(cr\.review\.drafts/.test(read('src/pages/Review.jsx')) && !/isDraftResolved\(cr\.review\.drafts/.test(read('src/pages/review/ReviewHub.jsx')));

// ── R. an updated draft can be answered again, and Finish says what's still open (task #126) ─
// Matt went through Review on 2026-10-21 and the hub still said 15: the updated drafts showed only
// his old locked verdict and a "Change" link (no Accept), and Finish said "Done" with all 15 open.
// The reducer half (recheck) is held by test-review-additive.mjs; this holds the wiring.
ok('🔴 R1 the hook sends a fresh verdict on an updated draft with confirm and the change date (recheck)',
  /confirm: opts\.confirm === true \|\| !!changedSince, recheck: changedSince/.test(provider) && /recheck: opts\.recheck \?\? null/.test(provider));
const card = read('src/pages/review/DraftCard.jsx');
ok('🔴 R2 the card shows Accept / Request changes on an updated draft (no Change link, no confirm box)',
  /const updated = !!rev\.changedSince;/.test(card) && /const editable = updated \|\| !rev\.locked \|\| confirmed;/.test(card));
ok('R3 …with the verdict before the update named above the buttons', /Before this update: \{verdictLabel\(shown\.status\)\}/.test(card));
// Held for the card's life, and the card is one draft's (ReviewFocus keys it by the draft, task #130).
ok('R3b …and the callout and that line HELD after a fresh verdict, for the visit (no jump under the pointer)',
  /const \[held, setHeld\] = useState\(null\);/.test(card) && /if \(updated && held\?\.since !== rev\.changedSince\)/.test(card)
  && /status: rev\.status, at: rev\.at \} : held;/.test(card) && /<DraftCard key=\{currentId\}/.test(read('src/pages/review/ReviewFocus.jsx')));
if (typeof SHARED.countOpen === 'function' && typeof CR.isDraftCurrent === 'function') {
  // The live shape on 2026-10-21: every question answered but two, every draft accepted on
  // 2026-09-30 except the changed ones (changes requested, with a note) and the new ones (no entry).
  const OLD = '2026-09-30T14:43:00.000Z';
  const drafts = {};
  for (const id of draftIds) {
    if (added[id]) continue;
    drafts[id] = changed?.[id]
      ? { status: 'changes', at: OLD, sitting: 's1', notes: [{ id: `n_${id}`, text: 'x', at: OLD }] }
      : { status: 'accepted', at: OLD, sitting: 's1' };
  }
  const review = { sections: {}, picks: {}, drafts, decisions: { 'HUB-1': { choice: 'a', at: OLD } } };
  const isOpen = (id) => !CR.isDraftCurrent(review.drafts[id], changed?.[id] || null);
  const list = ['HUB-1', 'MISC-7', 'MISC-8', ...draftIds];
  const want = 2 + Object.keys(changed || {}).length + Object.keys(added).length;
  ok('🔴 R4 countOpen counts the open questions and drafts in a walked list (15 on Matt\'s 2026-10-21 review)', SHARED.countOpen(list, review, isOpen) === want, SHARED.countOpen(list, review, isOpen));
  ok('R5 …and nothing once all are answered', SHARED.countOpen(['HUB-1', 'lead-ack'], review, isOpen) === 0);
} else ok('🔴 R4 reviewShared exports countOpen', false);
const page = read('src/pages/Review.jsx');
ok('🔴 R6 Finish counts what is still open and says so instead of "Done"',
  /countOpen\(ids, cr\.review, cr\.isDraftOpen\)/.test(page) && /still need an answer: Next and Skip move on without answering\./.test(page));

// ── F. the freeze ──────────────────────────────────────────────────────────────────────────
ok('F1 every retired draft names its date and reason; none is back in the catalog', ['quote-email', 'team-invite', 'review-request', 'review-request-sms'].every((id) => manifest.retiredDrafts?.[id]?.retired && manifest.retiredDrafts[id].reason && !draftIds.includes(id)));

console.log(`test-review-drafts-update: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
