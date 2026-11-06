// The QuickBooks "Link a property" flow (offline). Two guards the demo drive of 2026-09-28
// turned up:
//
//   1. The demo STUB mirrors the server's rule (api/quickbooks PUT links → 409
//      entity_already_linked): one QuickBooks entity belongs to ONE property, or the dashboard
//      shows the same money under two properties and doubles it in the book total. Driven for
//      real: lib/qboApi.js is loaded under a DEMO build env (the same import.meta.env define
//      Vite inlines, as test-prod-stubs.mjs does) over an in-memory localStorage.
//   2. The Link-a-property modal stays MOUNTED between opens (QuickBooksSection renders it with
//      open={linkOpen}), and a successful save never cleared `saving`. So the second open
//      showed a disabled "Saving…" button and the owner could not link another property
//      without reloading the page. The modal's reset-on-open effect must clear `saving` too.
//      (No component-render harness exists here; this is a source contract on that effect.)
//
//   node scripts/test-qbo-link-form.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformWithOxc } from 'vite';

const APP = fileURLToPath(new URL('..', import.meta.url));
const LIB = join(APP, 'src', 'lib');
const tmpRoot = mkdtempSync(join(tmpdir(), 'cs-qbo-link-form-'));

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

// Load a src/lib adapter with import.meta.env replaced by `env` (what Vite inlines at build
// time); its relative imports are rewritten to absolute file URLs so they load untransformed.
async function loadUnder(file, env) {
  const src = readFileSync(join(LIB, file), 'utf8');
  const { code } = await transformWithOxc(src, file, { define: { 'import.meta.env': JSON.stringify(env) } });
  const rewritten = code.replace(/(from\s*['"])(\.\.?\/[^'"]+)(['"])/g, (_, a, spec, b) => {
    let abs = fileURLToPath(new URL(spec, pathToFileURL(join(LIB, file))));
    if (!extname(abs)) abs += '.js';
    return a + pathToFileURL(abs).href + b;
  });
  const tmp = join(tmpRoot, `${file.replace(/\.js$/, '')}.demo.mjs`);
  writeFileSync(tmp, rewritten);
  return import(pathToFileURL(tmp).href);
}

// ── 1. the demo stub refuses a second property on the same entity ─────────────
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const api = await loadUnder('qboApi.js', { PROD: false, MODE: 'demo' });
ok('the adapter loaded in DEMO mode (stub active)', api.QBO_STUB_ACTIVE === true);

const attempt = async (args) => {
  try { return { ok: true, value: await api.linkQboProperty(args) }; } catch (e) { return { ok: false, status: e.status, message: e.message }; }
};
const first = await attempt({ clientId: 'cl_a', entityType: 'customer', entityId: '1001', entityName: 'Ball Harbor Village' });
ok('the first property links', first.ok, JSON.stringify(first));
const dup = await attempt({ clientId: 'cl_b', entityType: 'customer', entityId: '1001', entityName: 'Ball Harbor Village' });
ok('🔴 a second property on the same customer is refused (409, like the server)', !dup.ok && dup.status === 409, JSON.stringify(dup));
ok('  the refusal says what to do', /already linked to another property/i.test(dup.message || ''), dup.message);
const links = (await api.listQboLinks()).links;
ok('🔴 the refused link was not stored', links.length === 1 && links[0].clientId === 'cl_a', JSON.stringify(links));
ok('a property re-saving its OWN link is fine', (await attempt({ clientId: 'cl_a', entityType: 'customer', entityId: '1001', entityName: 'Ball Harbor Village' })).ok);
{
  // The same id in another dimension is a DIFFERENT entity (never "already linked"); the company's
  // one-dimension rule (CS-565) is what refuses it here, since cl_a is linked to a customer.
  const other = await attempt({ clientId: 'cl_b', entityType: 'class', entityId: '1001', entityName: 'Class 1001' });
  ok('the same id in another dimension is not "already linked" — the one-dimension rule refuses it', !other.ok && other.status === 409 && !/already linked/i.test(other.message || ''), JSON.stringify(other));
}

// ── 2. the modal's reset-on-open clears `saving` ─────────────────────────────
const section = readFileSync(join(APP, 'src', 'components', 'QuickBooksSection.jsx'), 'utf8');
const modalSrc = section.slice(section.indexOf('function LinkPropertyModal('), section.indexOf('export default function QuickBooksSection('));
ok('found the LinkPropertyModal source', modalSrc.length > 200, `${modalSrc.length} chars`);
const reset = /useEffect\(\(\)\s*=>\s*\{\s*if\s*\(open\)\s*\{([^}]*)\}/.exec(modalSrc);
ok('found the reset-on-open effect', !!reset);
ok('🔴 reopening the modal clears `saving` (a prior successful link left it true)', /setSaving\(false\)/.test(reset ? reset[1] : ''), reset ? reset[1].trim() : 'no effect');
ok('reopening the modal clears the previous error', /setErr\(null\)/.test(reset ? reset[1] : ''), reset ? reset[1].trim() : 'no effect');

rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\nqbo-link-form: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
}
