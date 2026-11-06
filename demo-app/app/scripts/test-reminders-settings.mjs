// Settings → Customer Reminders (Matt's approved messages, 2026-10-19), source pins plus the one
// rule it shares with the walkers:
//   1. the page lists the catalog (lib/customerMessages.js), never a hand-kept list: every message
//      with a trigger has a row with its switch, the words can be edited and put back to the
//      approved wording (the catalog's own text)
//   2. texts are no longer "locked off": a text has a switch like an email; the page says when
//      texting is not set up (the server's own answer, integrationsApi.smsStatus)
//   (3. the Google review link field left with the review requests when Google reviews were
//      removed, 2026-10-20 — test-google-reviews-retired.mjs M6 holds it gone)
// REGRESSION (THE LAW II.3): on 811e54eb the page lists five hand-kept rows with the texts locked
// off — every check fails.
//   node app/scripts/test-reminders-settings.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). Label first.
const ok = (label, cond, detail) => { if (cond) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${JSON.stringify(detail)})`); };
const page = (() => { try { return fs.readFileSync(`${APP}src/pages/settings/Reminders.jsx`, 'utf8'); } catch { return ''; } })();
const soft = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };

ok('1a the page lists the catalog (CUSTOMER_MESSAGES, grouped by MESSAGE_GROUPS), not a hand-kept list', /import \{[^}]*CUSTOMER_MESSAGES[^}]*MESSAGE_GROUPS[^}]*\} from '\.\.\/\.\.\/lib\/customerMessages'/.test(page) && !/const TEMPLATE_META = \{/.test(page) && !/const ORDER = \[/.test(page));
ok('1b every message with a trigger gets a row (SHOWN keeps every built one)', /const SHOWN = CUSTOMER_MESSAGES\.filter\(\(m\) => m\.built \|\|/.test(page));
ok('1c a row\'s switch writes the template through UPDATE_REMINDER_TEMPLATE', /UPDATE_REMINDER_TEMPLATE, id: tpl\.id, patch: \{ enabled: on \}/.test(page));
ok('1d the words can be edited and saved on the template', /UPDATE_REMINDER_TEMPLATE, id: tpl\.id, patch: \{ subject, body \}/.test(page));
ok('1e "Reset to approved wording" puts back the CATALOG\'s text (Matt\'s approved wording)', /Reset to approved wording/.test(page) && /onSave\(template, \{ subject: message\.subject, body: message\.body \}\)/.test(page));
ok('2a texts are not locked off any more', !/Not available yet/.test(page) && !/deliverable: false/.test(page));
ok('2b the page says when texting is not set up, from the server\'s own answer', /smsStatus\(\)/.test(page) && /Texting isn’t set up yet/.test(page));

console.log(`test-reminders-settings: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
