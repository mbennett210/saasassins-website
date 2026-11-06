// A SENT QUOTE IS A RECORD: only a draft is ever deleted (CS-028; S128 full-app pass F2-26).
//
// The Quotes list offered Delete on every quote — on a signed one its dialog said it
// "permanently deletes the signed document and its PDF" — and POST /api/quotes/<id>/delete
// hard-deleted the row and its signature and PDF objects with no status check. An executed
// customer agreement could be destroyed with no record.
//
// Held here (lib/quoteRules is the one rule):
//   A. the rule: a draft is deletable; sent, signed and void are not (void instead);
//   B. the REAL api/quotes handler over the loopback fake (never production): delete on a
//      signed, a sent and a void quote answers 409 and keeps the row AND its files; a draft is
//      deleted with its files; the status predicate rides ON the delete, so a send that lands
//      after the read still wins;
//   C. the demo stub refuses the same;
//   D. the list offers Delete on a draft only, and Void (confirmed) on a sent or signed quote.
//
// REGRESSION (THE LAW II.3): on the tree before the fix (`186fffb0`) there is no lib/quoteRules,
// the route deletes a signed quote (200, row gone) and the list offers Delete on every row.
//
//   node app/scripts/test-quote-delete.mjs
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { installResolveShim } from './deletion-core.mjs';

const ORG = '00000000-0000-0000-0000-000000000011';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
for (const k of ['SYSTEM_SENDER_EMAIL', 'APP_PUBLIC_URL', 'APP_BASE_URL']) delete process.env[k];
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();
installResolveShim();

const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch { return {}; } };
const R = await tryImport('../src/lib/quoteRules.js');
const { seedPermissions } = await import('../src/lib/roles.js');
const quotes = (await import('../api/quotes/[...path].js')).default;

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). This suite is label-first.
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const fn = (name) => (typeof R[name] === 'function' ? R[name] : () => { throw new Error(`lib/quoteRules.${name} is missing`); });

// ── A. the rule ──────────────────────────────────────────────────────────────
ok('A1 a draft may be deleted', () => fn('isQuoteDeletable')({ status: 'draft' }) === true);
ok('A2 🔴 a SIGNED quote may not be deleted', () => fn('isQuoteDeletable')({ status: 'signed' }) === false);
ok('A3 a sent quote may not be deleted (the customer holds its link)', () => fn('isQuoteDeletable')({ status: 'sent' }) === false);
ok('A4 a void quote may not be deleted (it is the record of what went out)', () => fn('isQuoteDeletable')({ status: 'void' }) === false);
ok('A5 a sent or signed quote is voided instead; a draft or a void one is not', () => fn('isQuoteVoidable')({ status: 'sent' }) && fn('isQuoteVoidable')({ status: 'signed' })
  && !fn('isQuoteVoidable')({ status: 'draft' }) && !fn('isQuoteVoidable')({ status: 'void' }));

// ── B. the real route ────────────────────────────────────────────────────────
const Q = (n) => `c0000000-0000-4000-8000-00000000000${n}`;
const IDS = { draft: Q(1), sent: Q(2), signed: Q(3), void: Q(4), race: Q(5) };
const row = (id, status) => ({
  id, organization_id: ORG, public_token: `tok${id.slice(-4)}`, contact_id: 'ct1', contact_name: 'Ann Lee', contact_email: 'ann@example.test',
  title: 'Quote — Coral Bay', template_key: 'cleanspace_quote_v1', fields: {}, status, doc_version: 1,
  admin_signed_at: status === 'draft' ? null : '2026-10-01T15:00:00Z',
  admin_signature_path: status === 'draft' ? null : `${ORG}/${id}/sig-admin.png`,
  signed_pdf_path: status === 'signed' ? `${ORG}/${id}/signed-1.pdf` : null,
  created_at: '2026-10-01T14:00:00Z', updated_at: '2026-10-01T15:00:00Z',
});
const LOGINS = { 'tok-owner': { id: 'auth-u_o', email: 'owner@example.test', app_metadata: { role: 'owner', org_user_id: 'u_o', org_id: ORG } } };
function seed() {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 2,
        state: { version: 58, company: { id: 'co', name: 'Co', timezone: 'America/New_York' }, users: [{ id: 'u_o', role: 'owner', status: 'active', name: 'Owner', email: 'owner@example.test' }], clients: [], contacts: [], permissions: seedPermissions(), userPermissionOverrides: [] },
      }],
      quotes: Object.entries(IDS).map(([status, id]) => row(id, status === 'race' ? 'draft' : status)),
    },
    logins: LOGINS,
  });
}
async function call(method, subpath, { token = 'tok-owner', body = null } = {}) {
  const raw = body ? JSON.stringify(body) : '';
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { subpath };
  req.body = body || {};
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
      Promise.resolve(quotes(req, res)).catch((e) => done('threw', String(e?.message || e)));
    });
  } finally { Object.assign(console, quiet); }
}
const rowOf = (id) => (world.tables.quotes || []).find((q) => q.id === id) || null;
const removedFor = (id) => world.storage.filter((s) => s.op === 'remove' && String(s.path).includes(id));
const show = (r) => `${r?.status} ${JSON.stringify(r?.body)?.slice(0, 200)}`;

seed();
for (const status of ['signed', 'sent', 'void']) {
  const r = await call('POST', `${IDS[status]}/delete`);
  ok(`B ${status === 'signed' ? '🔴 ' : ''}deleting a ${status.toUpperCase()} quote answers 409`, r.status === 409, show(r));
  ok(`B …and says so in words, with a code`, r.body?.code === (R.QUOTE_NOT_DELETABLE?.code ?? 'quote-not-deletable') && typeof r.body?.error === 'string', show(r));
  ok(`B …and the ${status} quote is still there`, rowOf(IDS[status])?.status === status);
  ok(`B …and none of its files were removed`, removedFor(IDS[status]).length === 0, JSON.stringify(removedFor(IDS[status])));
}
const d = await call('POST', `${IDS.draft}/delete`);
ok('B a DRAFT is deleted (200)', d.status === 200 && d.body?.ok === true, show(d));
ok('B …its row is gone', rowOf(IDS.draft) === null);
const missing = await call('POST', `${Q(9)}/delete`);
ok('B an unknown quote is a 404, not a 409', missing.status === 404, show(missing));

// The race: the read sees a draft, a send commits before the delete runs. The predicate ON the
// delete must refuse it (a check-then-delete would destroy a quote the customer just received).
seed();
world.beforeQuery = async (q) => {
  if (q.table === 'quotes' && q.op === 'delete') {
    const r = (world.tables.quotes || []).find((x) => x.id === IDS.race);
    if (r && r.status === 'draft') r.status = 'sent';   // the send lands in between
  }
};
const raced = await call('POST', `${IDS.race}/delete`);
world.beforeQuery = null;
ok('B 🔴 a send landing just before the delete wins: 409, the quote kept', raced.status === 409 && rowOf(IDS.race)?.status === 'sent', show(raced));
ok('B …and its files kept', removedFor(IDS.race).length === 0);

// ── C. the demo stub ─────────────────────────────────────────────────────────
// The stub is browser code (localStorage, import.meta.env.MODE): give it a localStorage and
// load it as the demo build would.
{
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  store.set('cleanspace_quotes_stub_v2', JSON.stringify({ quotes: [{ id: 'q_s', status: 'signed', public_token: 't' }, { id: 'q_d', status: 'draft', public_token: 'u' }] }));
  let api = null;
  try {
    const { pathToFileURL } = await import('node:url');
    const src = readFileSync(new URL('../src/lib/quotesApi.js', import.meta.url), 'utf8')
      .replace(/import\.meta\.env\.MODE/g, "'demo'").replace(/import\.meta\.env\.PROD/g, 'false')
      .replace(/import\.meta\.env\.VITE_QUOTES_STUB/g, 'undefined')
      .replace(/typeof import\.meta !== 'undefined' && import\.meta\.env\?\.VITE_FORMS_BACKEND_URL/g, 'false');
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'cs-quotes-'));
    const appSrc = new URL('../src/lib/', import.meta.url);
    const file = path.join(dir, 'quotesApi.mjs');
    writeFileSync(file, src.replace(/from '\.\/([^']+)'/g, (_, m) => `from '${new URL(m.endsWith('.js') ? m : `${m}.js`, appSrc).href}'`));
    api = await import(pathToFileURL(file).href);
  } catch (e) { fails.push(`C the stub loads (${String(e?.message || e).split('\n')[0]})`); }
  if (api) {
    let refused = null;
    try { await api.deleteQuote('q_s'); } catch (e) { refused = e; }
    ok('C 🔴 the demo stub refuses to delete a signed quote', !!refused);
    ok('C …and keeps it', JSON.parse(store.get('cleanspace_quotes_stub_v2')).quotes.some((q) => q.id === 'q_s'));
    await api.deleteQuote('q_d');
    ok('C the stub deletes a draft', !JSON.parse(store.get('cleanspace_quotes_stub_v2')).quotes.some((q) => q.id === 'q_d'));
  }
}

// ── D. the list (read mechanically; the drive is the screenshots) ─────────────
{
  const src = readFileSync(new URL('../src/pages/Quotes.jsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  ok('D1 the list imports the one rule', /from '\.\.\/lib\/quoteRules'/.test(src));
  ok('D2 🔴 Delete is offered only where isQuoteDeletable says so', /canDelete && isQuoteDeletable\(q\) && \(/.test(src));
  ok('D3 Void is offered on a sent or signed quote (isQuoteVoidable)', /canDelete && isQuoteVoidable\(q\) && \(/.test(src));
  ok('D4 the old "permanently deletes the signed document" dialog is gone', !src.includes('permanently deletes the signed document'));
  ok('D5 Void is confirmed through the kit dialog', /voidQuote\(/.test(src) && /ConfirmDialog/.test(src));
}

console.log(`\n${pass}/${pass + fails.length} quote-delete checks passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exitCode = fails.length ? 1 : 0;
