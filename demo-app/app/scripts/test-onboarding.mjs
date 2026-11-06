// New-customer onboarding (task 471 from Clean Corner's queue; UI_RULES §190). Offline.
//
// Matt's list ("clean corner", 2026-11-03): company name, customer number, the address, the primary
// contact's first name, last name, title, email and phone, the cleaning schedule, the assigned
// cleaners, supplies, and documents and contracts. Daniel's picks (2026-11-03): an onboarding bar on
// the customer's page; a step skipped with a note STAYS OPEN until it is filled in; every step but
// Company can be skipped; Documents & contracts is done once a signed contract is on file; the
// status reads "Onboarding" until every step is green, and the Customers list's Status filter has it.
//
//   §1  the rule (lib/onboarding): each step's done rule read from the real records (a partial
//       contact, an address on the location, a contract with no file, an ended contract), unknown
//       while a read is out; done wins over a skip; Company refuses a skip; a skip needs a note,
//       trimmed and capped; undo; the finish stamps once, only when all seven are green (task #507
//       added Special services as the seventh, UI_RULES §192; its own suite is
//       test-special-services.mjs)
//   §2  the store: Add customer's ADD_CLIENT keeps the onboarding; the badge reads Onboarding, with
//       Archived, Vendor and a hand-set Inactive over it; the finish hands it back to Lead / Active;
//       the derived status the reminders read is untouched; the assigned cleaners are one selector
//   §3  the screens: Add customer has no Customer / Vendor switch, requires the address and starts
//       the onboarding; the Customers list filters by it and opens the new customer; the customer
//       page draws the bar; every word the bar shows is a catalog line
//
// REGRESSION (THE LAW II.3): on bd4572d0 (before the change) lib/onboarding.js does not exist and
// the badge has no Onboarding, so §1, §2 and §3 fail there.
//
//   node app/scripts/test-onboarding.mjs
//
// ok(label, cond, detail) — the CONDITION is second in this file.
import { readFileSync } from 'node:fs';
import { loadStore } from './deletion-core.mjs';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const read = (rel) => { try { return readFileSync(new URL(rel, import.meta.url), 'utf8'); } catch { return ''; } };

let ob = {};
try { ob = await import('../src/lib/onboarding.js'); } catch (e) { fails.push(`lib/onboarding.js loads (${e.message.split('\n')[0]})`); }
const has = typeof ob.onboardingSteps === 'function';
ok('the onboarding rule loads', has);

const { reducer, ACTIONS, INITIAL_STATE } = await loadStore();
let sel = {};
try { sel = await import('../src/store/selectors.js'); } catch (e) { fails.push(`selectors load (${e.message.split('\n')[0]})`); }

const AT = '2026-11-03T20:00:00.000Z';
const fullClient = { id: 'cl_new', name: 'Bayshore Senior Living', type: 'customer', customerNumber: '0901', street: '1 Bay St', city: 'Fort Lauderdale', state: 'FL', zip: '33301' };
const fullContact = { id: 'ct_new', firstName: 'Ana', lastName: 'Ruiz', title: 'Office Manager', email: 'ana@bayshore.example', phone: '(754) 555-0100' };
const signed = { id: 'k1', status: 'active', document: { name: 'signed.pdf', storagePath: 'contracts/k1/signed.pdf' } };
const onb = (extra = {}) => ({ ...fullClient, onboarding: { startedAt: AT, startedBy: 'u1', skipped: {}, doneAt: null, ...extra } });
const allTrue = { company: true, contact: true, schedule: true, cleaners: true, supplies: true, documents: true, special: true };

// ── §1 the rule ─────────────────────────────────────────────────────────────────────────────
if (has) {
  ok('§1 the seven steps, in the order of Matt\'s list, then Special services', JSON.stringify(ob.ONBOARDING_STEPS) === JSON.stringify(['company', 'contact', 'schedule', 'cleaners', 'supplies', 'documents', 'special']));
  ok('§1 every step but Company may be skipped (Daniel\'s pick)', !ob.canSkipStep('company') && ['contact', 'schedule', 'cleaners', 'supplies', 'documents', 'special'].every(ob.canSkipStep));

  ok('§1 Company: every field in → nothing missing', ob.missingCompanyFields(fullClient).length === 0);
  ok('§1 Company: a blank ZIP and street are missing', JSON.stringify(ob.missingCompanyFields({ ...fullClient, zip: ' ', street: '' })) === JSON.stringify(['street', 'zip']));
  ok('§1 Company: the address is read from the location once it has one',
    JSON.stringify(ob.missingCompanyFields(fullClient, { street: '1 Bay St', city: '', state: 'FL', zip: '33301' })) === JSON.stringify(['city'])
    && ob.missingCompanyFields({ ...fullClient, street: '' }, { street: '2 New St', city: 'Miami', state: 'FL', zip: '33101' }).length === 0);
  ok('§1 Company: no customer number is missing', ob.missingCompanyFields({ ...fullClient, customerNumber: null }).includes('customerNumber'));

  ok('§1 Contact: none → all five missing', ob.missingContactFields(null).length === 5);
  ok('§1 Contact: a name with no title or phone is not done', JSON.stringify(ob.missingContactFields({ ...fullContact, title: '', phone: '' })) === JSON.stringify(['title', 'phone']));

  const facts = ob.onboardingFacts({ client: fullClient, primaryContact: fullContact });
  ok('§1 a read still out is unknown (null), never "to do"', facts.schedule === null && facts.cleaners === null && facts.supplies === null && facts.documents === null, JSON.stringify(facts));
  const loaded = ob.onboardingFacts({ client: fullClient, primaryContact: fullContact, upcomingCleans: 0, cleaners: 2, supplyItems: [], contracts: [] });
  ok('§1 loaded: no cleans, no items, no contract → false; two cleaners → true',
    loaded.schedule === false && loaded.cleaners === true && loaded.supplies === false && loaded.documents === false, JSON.stringify(loaded));
  ok('§1 Documents: an active contract with its signed copy → done', ob.hasSignedContractOnFile([signed]));
  ok('§1 Documents: an active contract with NO file → not done', !ob.hasSignedContractOnFile([{ id: 'k2', status: 'active', document: null }]));
  ok('§1 Documents: an ENDED contract with a file → not done', !ob.hasSignedContractOnFile([{ ...signed, status: 'ended' }]));

  const c = onb({ skipped: { schedule: { note: 'Customer hasn\'t chosen yet', at: AT, by: 'u1' }, company: { note: 'x', at: AT } } });
  const steps = ob.onboardingSteps(c, { ...allTrue, schedule: false, supplies: null, cleaners: true });
  const byStep = Object.fromEntries(steps.map((s) => [s.step, s]));
  ok('§1 a skipped step reads skipped, with its note', byStep.schedule.state === 'skipped' && byStep.schedule.skip?.note === 'Customer hasn\'t chosen yet');
  ok('§1 a note on Company is ignored (it can\'t be skipped)', byStep.company.state === 'done' && byStep.company.skip === null);
  ok('§1 a read still out reads unknown', byStep.supplies.state === 'unknown');
  const greenNow = ob.onboardingSteps(c, allTrue);
  ok('§1 DONE wins: a skipped step filled in is green and its note no longer shows', greenNow.find((s) => s.step === 'schedule').state === 'done' && greenNow.find((s) => s.step === 'schedule').skip === null);
  ok('§1 the progress: 5 of 7 with a skip and an unknown', JSON.stringify(ob.onboardingProgress(steps)) === JSON.stringify({ done: 5, total: 7, allDone: false }), JSON.stringify(ob.onboardingProgress(steps)));
  ok('§1 the bar opens on the first step not done', ob.firstOpenStep(steps) === 'schedule');

  ok('§1 Company refuses a skip', ob.skipStepPatch(onb(), 'company', { note: 'later', at: AT }) === null);
  ok('§1 a skip needs a note', ob.skipStepPatch(onb(), 'supplies', { note: '   ', at: AT }) === null);
  const long = 'x'.repeat(ob.ONBOARDING_NOTE_MAX + 50);
  const sk = ob.skipStepPatch(onb(), 'supplies', { note: `  ${long}  `, at: AT, by: 'u1' });
  ok('§1 a skip stores the note trimmed and capped, with when and who',
    sk?.onboarding?.skipped?.supplies?.note?.length === ob.ONBOARDING_NOTE_MAX && sk.onboarding.skipped.supplies.at === AT && sk.onboarding.skipped.supplies.by === 'u1'
    && sk.onboarding.startedAt === AT && sk.onboarding.doneAt === null);
  ok('§1 no skip on a customer that isn\'t onboarding, or a vendor', ob.skipStepPatch(fullClient, 'supplies', { note: 'n' }) === null && ob.skipStepPatch({ ...onb(), type: 'vendor' }, 'supplies', { note: 'n' }) === null);
  const un = ob.unskipStepPatch(onb({ skipped: { supplies: { note: 'n', at: AT } } }), 'supplies');
  ok('§1 Undo skip takes the note off', un && !('supplies' in un.onboarding.skipped));

  ok('§1 no finish while a step is skipped (it stays open)', ob.finishPatch(c, ob.onboardingSteps(c, { ...allTrue, schedule: false }), { at: AT }) === null);
  ok('§1 no finish while a read is out', ob.finishPatch(onb(), ob.onboardingSteps(onb(), { ...allTrue, documents: null }), { at: AT }) === null);
  const fin = ob.finishPatch(c, greenNow, { at: AT });
  ok('§1 all seven green → the finish stamp, its notes cleared', fin?.onboarding?.doneAt === AT && Object.keys(fin.onboarding.skipped).length === 0);
  ok('§1 … stamped once (a finished customer gets no second stamp)', ob.finishPatch({ ...c, ...fin }, greenNow, { at: AT }) === null);
  ok('§1 isOnboarding: no field, finished, or a vendor → no', !ob.isOnboarding(fullClient) && !ob.isOnboarding({ ...c, ...fin }) && !ob.isOnboarding({ ...onb(), type: 'vendor' }) && ob.isOnboarding(onb()));
}

// ── §2 the store ────────────────────────────────────────────────────────────────────────────
if (has && typeof sel.selectClientBadgeStatus === 'function') {
  let s = reducer(INITIAL_STATE, { type: ACTIONS.ADD_CLIENT, client: { ...fullClient, onboarding: ob.newOnboarding({ at: AT, by: 'u1' }) } });
  const added = s.clients.find((x) => x.id === 'cl_new');
  ok('§2 Add customer\'s ADD_CLIENT keeps the onboarding and makes the location', added?.onboarding?.startedAt === AT && added.onboarding.doneAt === null && (s.sites || []).some((x) => x.clientId === 'cl_new'));
  ok('§2 the badge reads Onboarding', sel.selectClientBadgeStatus(s, added) === 'onboarding');
  ok('§2 … while the status the reminders and counts read stays Lead', sel.selectClientStatus(s, added) === 'lead');
  ok('§2 Vendor wins over it', sel.selectClientBadgeStatus(s, { ...added, type: 'vendor' }) === 'vendor');
  ok('§2 a hand-set Inactive wins over it', sel.selectClientBadgeStatus(s, { ...added, statusOverride: 'inactive' }) === 'inactive');
  ok('§2 Archived wins over it', sel.selectClientBadgeStatus(s, { ...added, statusOverride: 'archived' }) === 'archived');
  const fin = ob.finishPatch(added, ob.onboardingSteps(added, allTrue), { at: AT });
  s = reducer(s, { type: ACTIONS.UPDATE_CLIENT, id: 'cl_new', patch: fin });
  ok('§2 finished, it moves on by itself to Lead (no work yet)', sel.selectClientBadgeStatus(s, s.clients.find((x) => x.id === 'cl_new')) === 'lead');
  const plain = (INITIAL_STATE.clients || []).find((x) => x.type !== 'vendor' && !x.statusOverride);
  ok('§2 an existing customer (no onboarding field) is untouched', !plain || sel.selectClientBadgeStatus(INITIAL_STATE, plain) === sel.selectClientStatus(INITIAL_STATE, plain));

  // The assigned cleaners: one selector for the Service setup card and the bar.
  const crew = (INITIAL_STATE.users || []).find((u) => u.role === 'crew' && u.status !== 'disabled');
  if (crew && typeof sel.selectAssignedCleanersForClient === 'function') {
    const linked = reducer(s, { type: ACTIONS.UPDATE_USER, id: crew.id, patch: { worksAt: ['cl_new'] } });
    const list = sel.selectAssignedCleanersForClient(linked, 'cl_new');
    ok('§2 a cleaner linked by Works at counts as assigned', list.length === 1 && list[0].user.id === crew.id && list[0].onClean === false, JSON.stringify(list.map((x) => x.user.id)));
    ok('§2 … and none before the link', sel.selectAssignedCleanersForClient(s, 'cl_new').length === 0);
  } else ok('§2 the assigned cleaners are one selector', false, 'selectAssignedCleanersForClient missing or no crew in the seed');
} else ok('§2 the badge reads the onboarding', false, 'selectors or the rule missing');

// ── §3 the screens ──────────────────────────────────────────────────────────────────────────
const add = read('../src/components/AddCompanyModal.jsx');
ok('§3 Add customer has no Customer / Vendor switch (Matt: "You can remove the Customer/Vendor selection")', add && !/>\s*Vendor\s*</.test(add) && !/set\(\{ type:/.test(add) && /type: 'customer'/.test(add));
ok('§3 … requires the whole address and refuses what is missing in words', /missingCompanyFields\(/.test(add) && /onboarding\.add\.missing/.test(add)
  && ['label="Street address"\n              required', 'label="City"\n              required', 'label="State"\n                required', 'label="ZIP"\n                required'].every((x) => add.includes(x)));
ok('§3 … and starts the onboarding on the new customer', /onboarding: newOnboarding\(/.test(add));
const list = read('../src/pages/Clients.jsx');
ok('§3 the Customers list\'s Status filter has Onboarding', /const STATUSES = \['onboarding',/.test(list) && /onboarding\.badge/.test(list));
ok('§3 … and a new customer opens on its own page', /onCreated=\{\(id\) => navigate\(`\/clients\/\$\{id\}`/.test(list));
const detail = read('../src/pages/ClientDetail.jsx');
ok('§3 the customer page draws the bar while onboarding, never on an archived customer', /<OnboardingBar/.test(detail) && /isOnboarding\(client\) && !isArchivedCustomer\(client\)/.test(detail));
// Found on the demo: once the finish was stamped the bar stayed drawn, but its contracts read
// followed "is onboarding" and stopped, so the finished bar read "5 of 6" with Documents "Checking…".
ok('§3 the bar\'s contracts read lasts as long as the bar is drawn, the finished bar included',
  /const onbShown = onboardingNow \|\| \(onbStayed/.test(detail) && /useOnboardingContracts\([^)]*onbShown && canViewContracts\)/.test(detail) && /\{onbShown && \(/.test(detail));
ok('§3 a contract saved on the Contract tab turns the step green at once', /onChanged=\{onbContracts\.reload\}/.test(detail) && /onChanged\?\.\(\)/.test(read('../src/components/ClientContracts.jsx')));
const bar = read('../src/components/OnboardingBar.jsx');
ok('§3 the bar writes through the rule (skip, undo, finish)', /skipStepPatch\(/.test(bar) && /unskipStepPatch\(/.test(bar) && /finishPatch\(/.test(bar));
ok('§3 its pop-ups are the kit\'s Modal (UI_RULES: one shared pop-up)', /import Modal from '.\/Modal'/.test(bar) && !/createPortal|position:\s*'fixed'/.test(bar));
// Forge's styling check measured the kit's button words 0.5px high and its × 1.46px low (2026-11-03),
// as on Add Team Member and Import team; this screen opts in to components/Centred as they do.
ok('§3 its buttons\' words and its pop-ups\' × sit in their middle by code (components/Centred)',
  /import Centred from '\.\/Centred'/.test(bar) && (bar.match(/<Modal [^>]*\bcentred>/g) || []).length === 2
  && (bar.match(/<Centred[ >]/g) || []).length >= 8);
const card = read('../src/components/ServiceSetupCard.jsx');
ok('§3 the Service setup card reads the same cleaners selector', /selectAssignedCleanersForClient\(/.test(card));

// Every word the bar and Add customer show is a catalog line (UI_RULES §140).
const en = read('../src/i18n/catalog/en.js');
const keys = new Set([...en.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));
const literal = [...`${bar}\n${add}\n${list}`.matchAll(/t\('(onboarding\.[^']+)'/g)].map((m) => m[1]);
const templated = has ? [
  ...ob.ONBOARDING_STEPS.flatMap((st) => [`onboarding.step.${st}`, `onboarding.seg.${st}`]),
  ...['done', 'skipped', 'todo', 'unknown'].map((st) => `onboarding.state.${st}`),
  ...[...ob.COMPANY_FIELDS, ...ob.CONTACT_FIELDS].map((f) => `onboarding.field.${f}`),
] : [];
const missing = [...new Set([...literal, ...templated])].filter((k) => !keys.has(k));
ok('§3 every onboarding word is in the English catalog', literal.length > 20 && missing.length === 0, missing.join(', '));
ok('§3 the button lint no longer excuses Add customer\'s small buttons', !/AddCompanyModal/.test(read('./button-size-lint.mjs')));

for (const f of fails) console.log(`  ✗ ${f}`);
console.log(`${fails.length === 0 ? 'PASS' : 'FAIL'} — test-onboarding: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
