// End-to-end backend check for the e-signature quote flow against LIVE Supabase.
// Loads the real env from .env.local.bak. Creates a throwaway quote, runs the
// full lifecycle through the real handlers, verifies the signed PDF is stored,
// then deletes everything. Run from app/:  DIAG_PW='...' node scripts/diag-quotes.mjs
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
for (const line of readFileSync(new URL('../.env.local.bak', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
}
const ORG = '00000000-0000-0000-0000-000000000001';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const anon = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { data: signin, error: sErr } = await anon.auth.signInWithPassword({ email: process.env.DIAG_EMAIL || 'steve@cleanspaceonline.com', password: process.env.DIAG_PW });
if (sErr) { console.log('sign-in failed:', sErr.message); process.exit(0); }
const auth = { authorization: `Bearer ${signin.session.access_token}` };

const { default: adminH } = await import('../api/quotes/[...path].js');
const { default: pubH } = await import('../api/public/pay/[...path].js');
const store = await import('../api/_lib/quotes/store.js');
const mockRes = () => { const r = { code: 0, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
let pass = 0, fail = 0; const ok = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); c ? pass++ : fail++; };

// create from template
let r = mockRes();
await adminH({ method: 'POST', query: { path: ['create'] }, headers: auth, body: { contact: { id: `ct_test_${Date.now()}`, name: 'Test Client', email: 'test@example.com', company: 'Test Co LLC' }, templateKey: 'cleanspace_quote_v1' } }, r);
ok('create → 200 + auto-mapped name/company', r.code === 200 && r.body?.quote?.fields?.clientName === 'Test Client' && r.body?.quote?.fields?.companyName === 'Test Co LLC');
const id = r.body?.quote?.id; const tok = r.body?.quote?.public_token;
if (!id) { console.log('no quote id — aborting'); process.exit(1); }

// save fields
r = mockRes();
await adminH({ method: 'POST', query: { path: [id, 'save'] }, headers: auth, body: { fields: { fee: '$1,500/month - weekly', frequency: 'twice weekly' } } }, r);
ok('save → 200 + merged', r.code === 200 && r.body?.quote?.fields?.fee === '$1,500/month - weekly');

// admin sign (renders + stores preview)
r = mockRes();
await adminH({ method: 'POST', query: { path: [id, 'admin-sign'] }, headers: auth, body: { signerName: 'Kyle Boyden', signatureDataUrl: PNG } }, r);
ok('admin-sign → 200 + admin_signed_at', r.code === 200 && !!r.body?.quote?.admin_signed_at);

// send
r = mockRes();
await adminH({ method: 'POST', query: { path: [id, 'send'] }, headers: auth }, r);
ok('send → 200 + status sent', r.code === 200 && r.body?.quote?.status === 'sent');

// public GET (no auth) → document_url present
r = mockRes();
await pubH({ method: 'GET', query: { path: [tok] }, headers: {} }, r);
ok('public GET → 200 + document_url (preview)', r.code === 200 && !!r.body?.quote?.document_url);

// public sign → finalize
r = mockRes();
await pubH({ method: 'POST', query: { path: [tok, 'sign'] }, headers: { 'x-forwarded-for': '203.0.113.5' }, body: { signerName: 'Test Client', signerEmail: 'test@example.com', signatureDataUrl: PNG } }, r);
ok('public sign → 200 + status signed', r.code === 200 && r.body?.status === 'signed');

// verify the signed PDF is stored + valid
const finalQ = await store.getQuoteById(id);
let pdfOk = false;
try { const bytes = await store.downloadObject(finalQ.signed_pdf_path); pdfOk = bytes.slice(0, 4).toString() === '%PDF' && bytes.length > 10000; } catch { /* */ }
ok('signed PDF stored + valid (%PDF, >10KB)', pdfOk);

// cleanup
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
await admin.from('quotes').delete().eq('id', id);
await admin.storage.from('quote-documents').remove([
  `${ORG}/${id}/sig-admin.png`, `${ORG}/${id}/sig-client.png`, `${ORG}/${id}/preview.pdf`, finalQ.signed_pdf_path,
].filter(Boolean));
console.log('\ncleaned up test quote +', `\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
