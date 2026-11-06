// QUOTES IS HIDDEN, AND ITS FOUR EMAILS LEFT REVIEW (2026-10-23). Matt does proposals and
// e-signatures in PandaDoc and answered Review's MISC-7 "Hide it — we use PandaDoc" (9:16 AM PT);
// Daniel, the same day: "Get rid of those quote emails though if they aren't relevant anymore."
//   F  the switch: lib/features.js QUOTES_ENABLED is false
//   N  the nav entry (Finances → Quotes) carries it, so the sidebar hides it from everyone
//   S  search: the Quotes page and the "New quote" action carry it, so neither is offered
//   R  the /quotes and /quotes/:id routes mount only behind it; the public signing page
//      (/quote/:token) stays, so a link already sent still opens
//   G  the QuickStart card and the Roles permission section are dropped behind it
//   D  quote-doc, sign-request, quote-signed-copy and quote-nudge are RETIRED: off the catalog and
//      its dates, kept in the frozen manifest with the day and a reason, never counted as pending
//   K  kept, so turning it back on is one line: the pages, the API route and the e-signature
//      emails' builders stay in the tree
// REGRESSION (THE LAW II.3): on 376f7c2b (the tree before it) 21 of the 28 checks fail; the 7 that
// pass there are the control, N3, S4, R2, K1 and D2 for the two drafts that were never dated.
//   node app/scripts/test-quotes-hidden.mjs
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

const FEAT = await soft('src/lib/features.js');
const NAV = await soft('src/lib/navData.js');
const REG = await soft('src/lib/masterSearch/registry.js');
const D = await soft('src/data/emailDrafts.js');
const IDS = await soft('src/data/emailDraftIds.js');
const CR = await soft('src/lib/clientReview.js');
let manifest = {};
try { manifest = JSON.parse(read('src/data/reviewManifest.json')); } catch { manifest = {}; }
ok('control: navData, the search registry and the Drafts catalog load', typeof NAV.visible === 'function' && Array.isArray(REG.NAV_ENTRIES) && Array.isArray(D.EMAIL_DRAFTS), NAV.__error || REG.__error || D.__error);
const all = () => true;

// ── F. the switch ──────────────────────────────────────────────────────────────────────────
ok('🔴 F1 lib/features.js exports QUOTES_ENABLED = false', FEAT.QUOTES_ENABLED === false, FEAT.QUOTES_ENABLED);

// ── N. the nav entry ───────────────────────────────────────────────────────────────────────
const leaf = typeof NAV.navLeaves === 'function' ? NAV.navLeaves().find((l) => l.to === '/quotes') : null;
ok('N1 the Finances → Quotes entry is still defined (reversible), carrying the switch', !!leaf && leaf.enabled === FEAT.QUOTES_ENABLED && leaf.enabled === false, leaf?.enabled);
ok('🔴 N2 …so it shows to nobody, even with every permission (desktop or phone)', !!leaf && typeof NAV.visible === 'function'
  && NAV.visible(leaf, all, false, false) === false && NAV.visible(leaf, all, true, false) === false);
ok('N3 the other Finances entries still show (Contracts, Invoices)', typeof NAV.navLeaves === 'function'
  && ['/contracts', '/invoices'].every((to) => { const l = NAV.navLeaves().find((x) => x.to === to); return l && NAV.visible(l, all, false, false); }));

// ── S. search ──────────────────────────────────────────────────────────────────────────────
const page = (REG.PAGE_ENTRIES || []).find((e) => e.to === '/quotes');
const action = (REG.ACTION_ENTRIES || []).find((e) => e.slug === 'new-quote');
ok('S1 the Quotes page entry carries the switch through', page?.enabled === false, page?.enabled);
ok('🔴 S2 the "New quote" action carries it too', action?.enabled === false, action?.enabled);
const shown = typeof REG.buildNavEntries === 'function' ? REG.buildNavEntries(all, false).map((e) => e.to) : [];
ok('🔴 S3 search offers neither, even with every permission', shown.length > 0 && !shown.some((to) => String(to).startsWith('/quotes')), shown.filter((to) => String(to).startsWith('/quotes')));
ok('S4 the other actions still show (New invoice)', shown.includes('/invoices?new=1'));

// ── R. the routes ──────────────────────────────────────────────────────────────────────────
const app = read('src/App.jsx');
const gate = app.indexOf('{QUOTES_ENABLED && (');
const routeAt = (p) => app.indexOf(`<Route path="${p}"`);
const closeAt = gate >= 0 ? app.indexOf('\n                  )}', gate) : -1;
ok('🔴 R1 /quotes and /quotes/:id mount only behind QUOTES_ENABLED', /import \{[^}]*\bQUOTES_ENABLED\b[^}]*\} from '\.\/lib\/features'/.test(app)
  && gate > 0 && routeAt('quotes') > gate && routeAt('quotes/:id') > gate && closeAt > routeAt('quotes/:id'));
ok('R2 the public signing page /quote/:token stays mounted, outside the gate', routeAt('/quote/:token') > 0 && (gate < 0 || routeAt('/quote/:token') < gate));

// ── G. the guide and the Roles editor ──────────────────────────────────────────────────────
ok('🔴 G1 the QuickStart Quotes card is dropped behind the switch', /\(QUOTES_ENABLED \|\| m\.id !== 'quotes'\)/.test(read('src/pages/settings/QuickStart.jsx')));
ok('🔴 G2 the Roles Quotes section is dropped behind the switch (its keys stay in roles.js)', /\(QUOTES_ENABLED \|\| g\.id !== 'quotes'\)/.test(read('src/pages/settings/Roles.jsx'))
  && /'quotes\.view':/.test(read('src/lib/roles.js')));

// ── D. the four drafts, retired ────────────────────────────────────────────────────────────
const QUOTE_DRAFTS = ['quote-doc', 'sign-request', 'quote-signed-copy', 'quote-nudge'];
const ids = IDS.EMAIL_DRAFT_IDS || [];
const byId = Object.fromEntries((D.EMAIL_DRAFTS || []).map((d) => [d.id, d]));
for (const id of QUOTE_DRAFTS) {
  ok(`🔴 D1 ${id}: off the catalog (no id, no descriptor)`, !ids.includes(id) && !byId[id]);
  ok(`D2 ${id}: off the dates (EMAIL_DRAFT_ADDED, EMAIL_DRAFT_CHANGED)`, !(id in (IDS.EMAIL_DRAFT_ADDED || {})) && !(id in (IDS.EMAIL_DRAFT_CHANGED || {})));
  const r = manifest.retiredDrafts?.[id];
  ok(`🔴 D3 ${id}: kept in the frozen manifest, retired 2026-10-23 with a reason`, (manifest.drafts || []).includes(id) && r?.retired === '2026-10-23' && /PandaDoc/.test(r?.reason || ''), r);
}
ok('D4 no Sales & quotes draft is left that speaks of a quote', !(D.EMAIL_DRAFTS || []).some((d) => d.category === 'Sales & quotes' && /quote/i.test(`${d.name} ${d.trigger}`)));
if (typeof CR.reviewSummary === 'function') {
  // Matt's two September notes on quote-doc and quote-nudge ("this is done in panda docs") stay
  // in the record; with the drafts retired they are no longer counted or listed anywhere.
  const review = { sections: {}, picks: {}, decisions: {}, drafts: {
    'quote-doc': { status: 'changes', at: '2026-09-30T14:41:20.445Z', notes: [{ id: 'n1', text: 'this is done in panda docs', at: '2026-09-30T14:41:21.000Z' }] },
    'sign-request': { status: 'accepted', at: '2026-09-30T14:40:00.000Z' },
  } };
  const s = CR.reviewSummary(review, [], ids, IDS.EMAIL_DRAFT_ADDED || {}, IDS.EMAIL_DRAFT_CHANGED || {});
  ok('🔴 D5 the pending count is the live catalog alone, none of the four in it or in New', s.pendingDrafts === ids.length && !QUOTE_DRAFTS.some((id) => s.newDraftIds.includes(id)), { pending: s.pendingDrafts, ids: ids.length });
}

// ── K. kept, so it is one line to turn back on ─────────────────────────────────────────────
ok('K1 the pages, the API route and the e-signature builders stay in the tree', ['src/pages/Quotes.jsx', 'src/pages/QuoteEditor.jsx', 'src/pages/PublicQuote.jsx', 'api/quotes/[...path].js', 'src/lib/quoteEmails.js'].every((f) => existsSync(`${APP}${f}`)));

if (fails.length) {
  console.log(`test-quotes-hidden: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`test-quotes-hidden: ${pass} passed, 0 failed`);
}
