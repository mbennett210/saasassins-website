// CS-193 — a person's LANGUAGE lives on their own roster row (Matt's LANG-3, LANG-11), and
// only a valid value from the person themselves ever lands there.
//
//   users[].language      — the switch in Settings → Account: 'auto' | 'en' | 'es' | 'ht'
//   users[].phoneLanguage — what their phone says (components/LanguageSync), for the server
//
// The server writes alerts in the language it finds on that row, so the row is trusted by
// every reader — which makes the two WRITE points the guard:
//   A. the crew save path (api/_lib/crewMerge.js §a): a cleaner's own row merges a VALID
//      language; anything else is dropped and reported, never repaired; another member's row
//      never merges at all; the merged state passes the protected-field guard;
//   B. the crew projection (api/_lib/crewView.js) serves the two fields on the SELF row only;
//   C. the reducer (SET_USER_LANGUAGE): a valid value lands, anything else is ignored, and
//      an unchanged value is a no-op (no needless save).
//
// Offline. Run: node scripts/test-i18n-crew-language.mjs
import { register } from 'node:module';
// reducer.js uses extensionless relative imports; resolve them as .js under plain node.
register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const { mergeCrewChanges } = await import('../api/_lib/crewMerge.js');
const { projectCrewView } = await import('../api/_lib/crewView.js');
const { protectedFieldViolations } = await import('../api/_lib/orgStateGuard.js');
const { reducer, ACTIONS } = await import('../src/store/reducer.js');

const ME = 'u_crew_me';
const MATE = 'u_crew_mate';
const BOSS = 'u_owner';
const baseState = () => ({
  version: 56,
  company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
  users: [
    { id: BOSS, name: 'Owner', role: 'owner', status: 'active', email: 'o@x.test' },
    { id: ME, name: 'Ana', role: 'crew', status: 'active', email: 'ana@x.test' },
    { id: MATE, name: 'Luis', role: 'crew', status: 'active', email: 'luis@x.test', language: 'ht', phoneLanguage: 'ht' },
  ],
  jobs: [], clients: [], sites: [], contacts: [], notifications: [], conversations: [], messages: [],
});
const scope = { clientIds: [] };

// A crew save: the view the cleaner was served, with `edit` applied to it.
function crewSave(edit, full = baseState()) {
  const served = projectCrewView(full, { userId: ME, crewJobs: [], scope });
  const posted = structuredClone(served);
  edit(posted);
  return { full, ...mergeCrewChanges({ full, posted, userId: ME, scope }) };
}
const self = (state, id = ME) => state.users.find((u) => u.id === id);
const setSelf = (patch) => (posted) => { posted.users = posted.users.map((u) => (u.id === ME ? { ...u, ...patch } : u)); };
const droppedFor = (dropped, reason, id = ME) => dropped.some((d) => d.slice === 'users' && d.id === id && d.reason === reason);

// ── A. the crew save path ─────────────────────────────────────────────────────────────────
{
  const { full, next, dropped } = crewSave(setSelf({ language: 'es' }));
  ok('A1: a cleaner\'s own language choice merges', self(next).language === 'es');
  ok('A2: …with nothing dropped', dropped.length === 0);
  ok('A3: …and the merged state passes the protected-field guard',
    protectedFieldViolations(full, next, 'crew', ME).length === 0);
}
for (const [bad, label] of [['fr', '"fr"'], ['ES', 'upper-case "ES"'], ['es-MX', 'a region "es-MX"'], [{ evil: true }, 'an object'], [42, 'a number']]) {
  const { next, dropped } = crewSave(setSelf({ language: bad }));
  ok(`A4: an invalid language (${label}) does NOT land`, self(next).language === undefined);
  ok(`A5: …and is reported (invalid-language) (${label})`, droppedFor(dropped, 'invalid-language'));
}
{
  const { next, dropped } = crewSave(setSelf({ language: 'auto' }));
  ok('A6: "auto" (follow my phone) is a valid choice', self(next).language === 'auto' && dropped.length === 0);
}
{
  const { next, dropped } = crewSave(setSelf({ phoneLanguage: 'ht' }));
  ok('A7: the phone\'s language (recorded by the app) merges', self(next).phoneLanguage === 'ht' && dropped.length === 0);
}
{
  const { next, dropped } = crewSave(setSelf({ phoneLanguage: 'es-MX' }));
  ok('A8: a raw phone code is refused (the app normalizes before it writes)',
    self(next).phoneLanguage === undefined && droppedFor(dropped, 'invalid-phone-language'));
}
{
  const full = baseState();
  full.users = full.users.map((u) => (u.id === ME ? { ...u, phoneLanguage: 'es' } : u));
  const { next, dropped } = crewSave(setSelf({ phoneLanguage: null }), full);
  ok('A9: the phone\'s language can be cleared (a phone switched to a language we do not speak)',
    self(next).phoneLanguage === null && dropped.length === 0);
}
{
  const { next, dropped } = crewSave((posted) => {
    posted.users = posted.users.map((u) => (u.id === MATE ? { ...u, language: 'en', phoneLanguage: 'en' } : u));
  });
  ok('A10: a cleaner can NOT set a teammate\'s language', self(next, MATE).language === 'ht' && self(next, MATE).phoneLanguage === 'ht');
  ok('A11: …and the attempt is reported', dropped.some((d) => d.slice === 'users' && d.id === MATE));
}
{
  const { next, dropped } = crewSave(setSelf({ language: 'es', role: 'owner' }));
  ok('A12: a language change riding with an authority change: the language lands, the role never does',
    self(next).language === 'es' && self(next).role === 'crew');
  ok('A13: …nothing else on the row was touched', self(next).name === 'Ana' && self(next).email === 'ana@x.test');
  ok('A14: the merged state still passes the guard', protectedFieldViolations(baseState(), next, 'crew', ME).length === 0);
  void dropped;
}
{
  const full = baseState();
  full.users = full.users.map((u) => (u.id === ME ? { ...u, language: 'es' } : u));
  const { next, dropped } = crewSave(() => {}, full);
  ok('A15: an untouched save leaves the saved language as it was', self(next).language === 'es' && dropped.length === 0);
}

// ── B. the crew projection ────────────────────────────────────────────────────────────────
{
  const full = baseState();
  full.users = full.users.map((u) => (u.id === ME ? { ...u, language: 'es', phoneLanguage: 'en' } : u));
  const served = projectCrewView(full, { userId: ME, crewJobs: [], scope });
  const me = served.users.find((u) => u.id === ME);
  const mate = served.users.find((u) => u.id === MATE);
  ok('B1: a cleaner is served their OWN language and phone language', me.language === 'es' && me.phoneLanguage === 'en');
  ok('B2: a teammate\'s language is not served to a cleaner', mate && mate.language === undefined && mate.phoneLanguage === undefined);
  ok('B3: an unset language is served as null (default-safe: reads as "auto")',
    projectCrewView(baseState(), { userId: ME, crewJobs: [], scope }).users.find((u) => u.id === ME).language === null);
}

// ── C. the reducer ────────────────────────────────────────────────────────────────────────
{
  const s0 = baseState();
  ok('C0: the action exists', typeof ACTIONS.SET_USER_LANGUAGE === 'string');
  const s1 = reducer(s0, { type: ACTIONS.SET_USER_LANGUAGE, userId: ME, language: 'es' });
  ok('C1: a valid choice lands on the person\'s row', self(s1).language === 'es');
  ok('C2: …and only on theirs', self(s1, MATE).language === 'ht' && self(s1, BOSS).language === undefined);
  const s2 = reducer(s1, { type: ACTIONS.SET_USER_LANGUAGE, userId: ME, language: 'fr' });
  ok('C3: an invalid choice is ignored (the state is unchanged)', s2 === s1);
  const s3 = reducer(s1, { type: ACTIONS.SET_USER_LANGUAGE, userId: ME, language: 'es' });
  ok('C4: the same choice again is a no-op (no needless save)', s3 === s1);
  const s4 = reducer(s1, { type: ACTIONS.SET_USER_LANGUAGE, userId: ME, phoneLanguage: 'ht' });
  ok('C5: the phone\'s language lands alone, leaving the choice', self(s4).phoneLanguage === 'ht' && self(s4).language === 'es');
  const s5 = reducer(s4, { type: ACTIONS.SET_USER_LANGUAGE, userId: ME, phoneLanguage: 'es-MX' });
  ok('C6: a raw phone code is ignored', s5 === s4);
  const s6 = reducer(s4, { type: ACTIONS.SET_USER_LANGUAGE, userId: ME, phoneLanguage: null });
  ok('C7: the phone\'s language can be cleared', self(s6).phoneLanguage === null);
  const s7 = reducer(s1, { type: ACTIONS.SET_USER_LANGUAGE, userId: 'nobody', language: 'en' });
  ok('C8: an unknown person changes nothing', s7 === s1);
  ok('C9: the reducer never writes the field for "follow my phone" as anything but "auto"',
    self(reducer(s1, { type: ACTIONS.SET_USER_LANGUAGE, userId: ME, language: 'auto' })).language === 'auto');
}

console.log(`\ntest-i18n-crew-language: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
