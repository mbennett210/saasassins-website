// "SENT FOR SIGNATURE" ONLY WHEN AN EMAIL WENT (CS-664; S128 full-app pass F2-04).
//
// The live app has no sending mailbox, so pressing Send on a quote emailed nothing — the route
// answered `emailed: false` — yet the client kept only `.quote` and the editor always toasted
// "Sent to <contact> for signature". The customer's signing page promised "A copy will be emailed
// to you", which never arrived either.
//
// Held here (lib/quoteRules is the one vocabulary):
//   A. the route, REAL handler over the loopback fake (never production): Send with no mailbox
//      answers `emailed: false, why: not-set-up`, still marks the quote sent (its link works);
//      a contact with no email address is `why: no-recipient` and nothing is attempted;
//   B. the public page's read carries `copy_by_email` — false with no mailbox, true with one;
//      the sign answer carries `emailed` (read mechanically: the sign renders a PDF in Chromium);
//   C. the client adapter hands `{ quote, emailed, why }` back (the stub: never emailed);
//   D. the editor toasts "Sent" only when it was emailed, and otherwise opens the hand-over with
//      the signing link to copy; the signing page promises an email only when one can go.
//
// REGRESSION (THE LAW II.3): on the tree before the fix (`2f962f38`, CS-028 in) the route gives no
// `why`, the public read no `copy_by_email`, the adapter drops `emailed`, and the editor always
// toasts "Sent to … for signature".
//
//   node app/scripts/test-quote-send-link.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { installResolveShim } from './deletion-core.mjs';

const ORG = '00000000-0000-0000-0000-000000000011';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
for (const k of ['SYSTEM_SENDER_EMAIL', 'APP_PUBLIC_URL', 'APP_BASE_URL', 'INBOX_TOKEN_ENCRYPTION_KEY']) delete process.env[k];
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();
installResolveShim();

const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch { return {}; } };
const R = await tryImport('../src/lib/quoteRules.js');
const { seedPermissions } = await import('../src/lib/roles.js');
const quotes = (await import('../api/quotes/[...path].js')).default;
const pay = (await import('../api/public/pay/[...path].js')).default;
const sender = await import('../api/_lib/systemSender.js');
const { english } = await import('../src/i18n/core.js');

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). This suite is label-first.
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const WHY = R.QUOTE_NOT_EMAILED || { notSetUp: 'not-set-up', noRecipient: 'no-recipient', failed: 'failed' };

const Q1 = 'd0000000-0000-4000-8000-000000000001';   // admin-signed draft, contact with an email
const Q2 = 'd0000000-0000-4000-8000-000000000002';   // admin-signed draft, contact with NO email
const quote = (id, email) => ({
  id, organization_id: ORG, public_token: `pt${id.slice(-6)}`, contact_id: 'ct1', contact_name: 'Ann Lee', contact_email: email,
  title: 'Quote — Coral Bay', template_key: 'cleanspace_quote_v1', fields: {}, status: 'draft', doc_version: 1,
  admin_signed_at: '2026-10-01T15:00:00Z', admin_signer_name: 'Dana', admin_signature_path: `${ORG}/${id}/sig-admin.png`,
  created_at: '2026-10-01T14:00:00Z', updated_at: '2026-10-01T15:00:00Z',
});
const LOGINS = { 'tok-owner': { id: 'auth-u_o', email: 'owner@example.test', app_metadata: { role: 'owner', org_user_id: 'u_o', org_id: ORG } } };
function seed({ mailbox = false } = {}) {
  sender.__resetSystemSenderCache?.();
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 2,
        state: {
          version: 58, company: { id: 'co', name: 'Co', timezone: 'America/New_York' },
          users: [{ id: 'u_o', role: 'owner', status: 'active', name: 'Owner', email: 'owner@example.test' }],
          clients: [], contacts: [{ id: 'ct1', firstName: 'Ann', lastName: 'Lee', email: 'ann@example.test' }],
          permissions: seedPermissions(), userPermissionOverrides: [],
        },
      }],
      quotes: [quote(Q1, 'ann@example.test'), quote(Q2, null)],
      // A connected sending mailbox, when asked for. Its token cannot be refreshed in this suite
      // (no encryption key, no network), so a send through it FAILS rather than being skipped.
      inbox_accounts: mailbox ? [{ id: 'ib1', organization_id: ORG, email: 'office@example.test', is_system_sender: true, status: 'active', provider: 'google' }] : [],
    },
    logins: LOGINS,
  });
}
async function call(handler, method, subpath, { token = 'tok-owner', body = null } = {}) {
  const raw = body ? JSON.stringify(body) : '';
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { subpath };
  req.body = body || {};
  req.url = `/api/x/${subpath}`;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'timeout', body: null }), 10000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => done('threw', String(e?.message || e)));
    });
  } finally { Object.assign(console, quiet); }
}
const show = (r) => `${r?.status} ${JSON.stringify(r?.body)?.slice(0, 220)}`;
const rowOf = (id) => (world.tables.quotes || []).find((q) => q.id === id) || null;

// ── A. the route ─────────────────────────────────────────────────────────────
seed();
const a1 = await call(quotes, 'POST', `${Q1}/send`);
ok('A1 Send with no mailbox still marks the quote sent (its signing link works)', a1.status === 200 && rowOf(Q1)?.status === 'sent', show(a1));
ok('A2 🔴 …and says nothing was emailed, and why: not-set-up', a1.body?.emailed === false && a1.body?.why === WHY.notSetUp, show(a1));
const a3 = await call(quotes, 'POST', `${Q2}/send`);
ok('A3 🔴 a contact with no email address: why no-recipient', a3.status === 200 && a3.body?.emailed === false && a3.body?.why === WHY.noRecipient, show(a3));
seed({ mailbox: true });
const a4 = await call(quotes, 'POST', `${Q1}/send`);
ok('A4 a mailbox that cannot send: why failed (not "not set up")', a4.status === 200 && a4.body?.emailed === false && a4.body?.why === WHY.failed, show(a4));

// ── B. the public page's read ────────────────────────────────────────────────
seed();
const tok = rowOf(Q1).public_token;
await call(quotes, 'POST', `${Q1}/send`);
const b1 = await call(pay, 'GET', tok, { token: null });
ok('B1 🔴 the signing page is told no copy can be emailed (no mailbox)', b1.status === 200 && b1.body?.quote?.copy_by_email === false, show(b1));
seed({ mailbox: true });
await call(quotes, 'POST', `${Q1}/send`);
const b2 = await call(pay, 'GET', rowOf(Q1).public_token, { token: null });
ok('B2 …and that it can, with a mailbox connected', b2.status === 200 && b2.body?.quote?.copy_by_email === true, show(b2));
const PAY_SRC = readFileSync(new URL('../api/public/pay/[...path].js', import.meta.url), 'utf8').replace(/\s+/g, ' ');
ok('B3 the sign answer says whether the signer\'s copy was emailed', /res\.status\(200\)\.json\(\{ ok: true, status: updated\.status, emailed: copyEmailed \}\)/.test(PAY_SRC));

// ── C. the client adapter ────────────────────────────────────────────────────
{
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  store.set('cleanspace_quotes_stub_v2', JSON.stringify({ quotes: [{ id: 'q1', status: 'draft', admin_signed_at: 'x', public_token: 't1', contact_name: 'Ann' }] }));
  let api = null;
  try {
    const src = readFileSync(new URL('../src/lib/quotesApi.js', import.meta.url), 'utf8')
      .replace(/import\.meta\.env\.MODE/g, "'demo'").replace(/import\.meta\.env\.PROD/g, 'false')
      .replace(/import\.meta\.env\.VITE_QUOTES_STUB/g, 'undefined')
      .replace(/typeof import\.meta !== 'undefined' && import\.meta\.env\?\.VITE_FORMS_BACKEND_URL/g, 'false');
    const dir = mkdtempSync(path.join(tmpdir(), 'cs-quotes-'));
    const appSrc = new URL('../src/lib/', import.meta.url);
    const file = path.join(dir, 'quotesApi.mjs');
    writeFileSync(file, src.replace(/from '\.\/([^']+)'/g, (_, m) => `from '${new URL(m.endsWith('.js') ? m : `${m}.js`, appSrc).href}'`));
    api = await import(pathToFileURL(file).href);
  } catch (e) { fails.push(`C the adapter loads (${String(e?.message || e).split('\n')[0]})`); }
  if (api) {
    const r = await api.sendQuote('q1');
    ok('C1 🔴 sendQuote hands back { quote, emailed, why } (the demo never emails)', r && r.quote?.status === 'sent' && r.emailed === false && r.why === WHY.notSetUp, JSON.stringify(r));
    const p = await api.getPublicQuote('t1');
    ok('C2 the demo\'s signing page is told no copy can be emailed', p && p.copy_by_email === false, JSON.stringify(p));
  }
  const ADAPTER = readFileSync(new URL('../src/lib/quotesApi.js', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  ok('C3 the real path keeps the route\'s emailed and why', /const r = await api\(`\/quotes\/\$\{id\}\/send`, \{ method: 'POST' \}\); return \{ quote: r\.quote, emailed: !!r\.emailed, why: r\.emailed \? null : \(r\.why \|\| null\) \};/.test(ADAPTER));
}

// ── D. the editor and the signing page ───────────────────────────────────────
{
  const ED = readFileSync(new URL('../src/pages/QuoteEditor.jsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  ok('D1 🔴 the editor no longer toasts "Sent to … for signature" whatever happened', !ED.includes('for signature`)'));
  ok('D2 the "sent" toast is a catalog line, shown only when it was emailed', /if \(res\.emailed\) toast\.success\(t\('quoteSend\.emailed'/.test(ED));
  ok('D3 otherwise the editor opens the hand-over with the signing link', /<QuoteLinkModal /.test(ED) && /setHandover\(\{ why: res\.why/.test(ED));
  let MODAL = '';
  try { MODAL = readFileSync(new URL('../src/components/QuoteLinkModal.jsx', import.meta.url), 'utf8').replace(/\s+/g, ' '); } catch { /* not built yet */ }
  ok('D4 the hand-over says why (one line per reason) and offers the link to copy', /quoteNotEmailedKey\(why\)/.test(MODAL) && /readOnly/.test(MODAL) && /navigator\.clipboard\.writeText\(link\)/.test(MODAL));
  const PQ = readFileSync(new URL('../src/pages/PublicQuote.jsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  ok('D5 🔴 the signing page no longer promises "A copy will be emailed" unconditionally', !PQ.includes("A copy {done ? 'will be' : 'was'} emailed to you"));
  ok('D6 its copy line comes from the one rule', /publicCopyLineKey\(/.test(PQ));
  ok('D7 the consent text promises an emailed copy only when one can go',
    /english\(copyByEmail \? 'publicQuote\.consent\.copyEmailed' : 'publicQuote\.consent\.copyKept'/.test(PQ) && /<ConsentDisclosure copyByEmail=\{!!quote\.copy_by_email\} \/>/.test(PQ));
  const key = (o) => (typeof R.publicCopyLineKey === 'function' ? R.publicCopyLineKey(o) : null);
  ok('D8 a signature whose copy was emailed says so', key({ justSigned: true, emailed: true }) === 'publicQuote.copyEmailed');
  ok('D9 🔴 one whose copy was not emailed points at the document instead', key({ justSigned: true, emailed: false }) === 'publicQuote.copyBelow');
  ok('D10 the English lines exist', ['publicQuote.copyEmailed', 'publicQuote.copyBelow', 'publicQuote.signedBelow', 'quoteSend.emailed', 'quoteSend.notSetUp', 'quoteSend.noRecipient', 'quoteSend.failed']
    .every((k) => { const s = english(k); return typeof s === 'string' && s.trim() !== '' && s !== k; }));
}

console.log(`\n${pass}/${pass + fails.length} quote send / link checks passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exitCode = fails.length ? 1 : 0;
