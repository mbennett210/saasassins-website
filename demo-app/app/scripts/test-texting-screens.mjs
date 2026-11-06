// THE OFFICE SEES THE TEXTS (Daniel, 2026-10-28: "Yes, add the Reply STOP functionality." and,
// for replies, "Customer thread, texted back"). The server half — the inbound route, the opt-out
// list, the text-back and GET /api/client-messages/text-status — is held by test-sms-inbound.mjs;
// this suite holds the SCREENS to it:
//   1. the customer thread (components/CustomerThread): a customer's line that came by text says
//      "Text from <number>"; every way an office line's text can go (lib/texting TEXT_BACK) has its
//      words under the line; the composer says where the reply is texted (or that the number has
//      texts off), in both layouts, and on a phone too (not hidden with the keyboard hint);
//   2. the customer page (pages/ClientDetail): a number that replied STOP says "Texts off: replied
//      STOP on <date>", read-only, under the primary contact's phone (view and edit), in the
//      Contacts table and in the contact's edit form — read from text-status, gated by
//      contacts.view, matched by the number in E.164 whatever way it was typed;
//   3. the client adapter and the demo answer the same shapes as the route.
// REGRESSION (THE LAW II.3): on e489af8f none of it exists — every check but the loads fails.
//   node app/scripts/test-texting-screens.mjs
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The browser modules import without a `.js` (Vite resolves it); so does this suite's loader.
register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
// The code with its comments taken out, so a comment never passes a check.
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). Label first.
const ok = (label, cond, detail) => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { detail = `threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`);
};
const soft = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };

// The demo store reads the browser's storage; an in-memory one stands in.
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const TX = await soft('../src/lib/texting.js');
const en = (await import('../src/i18n/catalog/en.js')).default;
const demo = await soft('../src/lib/clientMessagesDemo.js');
const { INITIAL_STATE } = await import('../src/data/seed.js');
ok('the texting rules load (src/lib/texting.js)', typeof TX.displayPhone === 'function' && !!TX.TEXT_BACK, TX.__error);

// ── 1. the customer thread ──
const thread = code('src/components/CustomerThread.jsx');
ok('🔴 1a a customer\'s line that came by text says "Text from <number>" (only a customer line marked via TEXT_VIA)',
  /m\.via === TEXT_VIA/.test(thread) && /t\('custMsg\.text\.from', \{ phone: displayPhone\(/.test(thread) && !!en['custMsg.text.from']);
const outcomeMap = /TEXT_OUTCOME_KEY = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(thread)?.[1] || '';
const mapped = new Map([...outcomeMap.matchAll(/\[TEXT_BACK\.(\w+)\]:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
const statuses = Object.keys(TX.TEXT_BACK || {});
ok('🔴 1b every way an office line\'s text can go (TEXT_BACK) has its own words, a real catalog key',
  statuses.length > 0 && statuses.every((k) => mapped.has(k) && typeof en[mapped.get(k)] === 'string'),
  { statuses, mapped: [...mapped] });
ok('1b …and the words are drawn under the office\'s line (its `text`), never a customer\'s',
  /const outcome = !customer \? textOutcome\(t, m\.text\)/.test(thread) && /\{outcome && <> · \{outcome\}<\/>\}/.test(thread));
ok('1b …an opted-out reply names the STOP', /STOP/.test(en['custMsg.text.optedOut'] || ''));
ok('🔴 1c the thread keeps where the next reply is texted (the route\'s `textBack`) and says it in BOTH layouts',
  /textBack: r\.textBack \|\| null/.test(thread) && (thread.match(/<TextBackNote textBack=\{data\?\.textBack\}/g) || []).length === 2);
ok('1c …the number, or that it has texts off and since when',
  /t\('custMsg\.text\.nextOff', \{ phone, date: fmtDate\(textBack\.optedOutAt/.test(thread) && /t\('custMsg\.text\.next', \{ phone \}\)/.test(thread)
  && /\{date\}/.test(en['custMsg.text.nextOff'] || '') && /STOP/.test(en['custMsg.text.nextOff'] || ''));
const css = read('src/index.css');
ok('🔴 1d on a phone the note stays: the keyboard hint\'s "hidden ≤640px" rule is outranked for it',
  /class(Name)?="compose-hint compose-hint-text"/.test(thread)
  && /@media \(max-width: 640px\) \{ \.compose-bar \.compose-hint\.compose-hint-text \{ display: block; \} \}/.test(css));

// ── 2. the customer page ──
const page = code('src/pages/ClientDetail.jsx');
const modal = code('src/components/AddContactModal.jsx');
const note = code('src/components/TextsOffNote.jsx');
const hook = code('src/hooks/useCustomerTextStatus.js');
ok('🔴 2a the page reads its numbers\' text status, gated by contacts.view (the route\'s own key)',
  /const canViewContacts = usePermission\('contacts\.view'\);/.test(page) && /useCustomerTextStatus\(clientId, canViewContacts\)/.test(page)
  && /if \(!clientId \|\| !enabled\) return undefined;/.test(hook) && /fetchCustomerTextStatus\(clientId\)/.test(hook));
ok('🔴 2b "Texts off" under the primary contact\'s phone (view and edit) and each contact\'s phone in the table',
  (page.match(/<TextsOffNote optedOutAt=\{textsOffFor\(primaryContact\?\.phone\)\} \/>/g) || []).length === 2
  && /<td data-label="Phone">\{c\.phone \|\| '—'\}<TextsOffNote optedOutAt=\{textsOffFor\(c\.phone\)\} \/><\/td>/.test(page));
ok('🔴 2c …and in the contact\'s own edit form, for the number in the box',
  /textsOffFor=\{textsOffFor\}/.test(page) && /const phoneOffAt = textsOffFor \? textsOffFor\(form\.phone\) : null;/.test(modal)
  && /<FormField label="Phone" help=\{phoneOffAt \? <TextsOffNote optedOutAt=\{phoneOffAt\}/.test(modal));
ok('🔴 2d the words are the brief\'s: "Texts off: replied STOP on <date>", read-only (no control)',
  en['textsOff.note'] === 'Texts off: replied STOP on {date}' && /t\('textsOff\.note', \{ date: fmtDate\(optedOutAt/.test(note)
  && !/<button|onClick|<Toggle/.test(note));
ok('2e a number typed any way matches: the hook looks it up in E.164 (the one normalizer)',
  /import \{ toE164 \} from '\.\.\/lib\/alertDelivery';/.test(hook) && /const e164 = toE164\(/.test(hook) && /off\.get\(e164\)/.test(hook));

// ── 3. the adapter and the demo ──
const api = code('src/lib/clientMessagesApi.js');
ok('🔴 3a the adapter reads GET /client-messages/text-status?clientId',
  /export async function fetchCustomerTextStatus\(clientId, ctx = \{\}\)/.test(api) && /api\(`\/client-messages\/text-status\$\{qs\(\{ clientId \}\)\}`\)/.test(api)
  && /\(await loadDemo\(\)\)\.textStatus\(clientId, ctx\)/.test(api));
const book = (INITIAL_STATE.clients || []).find((c) => c && c.id && c.statusOverride !== 'archived');
let ts = null; let th = null;
try { ts = await demo.textStatus?.(book?.id); } catch (e) { ts = { __error: e?.message }; }
try { th = await demo.officeThread?.(book?.id); } catch (e) { th = { __error: e?.message }; }
ok('🔴 3b the demo answers text-status as the route does (no texts in the demo: none off)', JSON.stringify(ts) === '{"optOuts":[]}', ts);
ok('🔴 3c the demo\'s thread carries the route\'s keys, `textBack` (null) included',
  !!th && JSON.stringify(Object.keys(th).sort()) === JSON.stringify(['client', 'hasMore', 'manager', 'messages', 'readAt', 'textBack', 'waitingSince']) && th.textBack === null,
  th && Object.keys(th));
let bad = null;
try { await demo.textStatus?.('cl_not_in_the_book'); } catch (e) { bad = e; }
ok('3d …and refuses a building not in the book, as the route does (404)', bad?.status === 404 || /couldn|not found/i.test(String(bad?.message || '')), bad?.message || bad);

console.log(`test-texting-screens: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
