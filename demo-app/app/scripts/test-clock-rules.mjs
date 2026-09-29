// Per-cleaner clock rules — `user.clockRules = { checklistBlockOff?, geofenceOff? }`
// (checklists plan step 4b, rules R6 + R7; acceptance criteria 13 and 14).
//
// WHY THIS SUITE. The field turns two enforcement gates OFF for one person, so it is
// AUTHORITY, not profile: whoever can write it can exempt themselves from the clock-out
// block and from the geofence that anchors attendance. Four things therefore have to hold
// at once, and three of them are invisible to any single-file reading:
//   1. The org_state guard refuses it from anyone without `time.clockRules` — on ANOTHER
//      member's row AND on your own (self-exemption is the whole risk).
//   2. The change moves `protectedFingerprint`. The write endpoint SKIPS the guard when a
//      save's digest equals the stored one, so a check without its fingerprint input
//      silently stops firing — the exact failure mode orgStateGuard's header warns about.
//   3. A crew save can never carry it: `mergeCrewChanges` merges name / phone / prefs only,
//      and the projection a crew session is served must still SHOW the cleaner their own
//      rules, or the client-side clock-out gate (step 4a) can't read them.
//   4. With the geofence off, a clock-in from anywhere is accepted and the punch records
//      WHY — `geofence_result:'override'` with `override_reason:'geofence_off_for_cleaner'`,
//      distinguishable from a site-level disable ('geofence_disabled').
//
// (4) is proven by driving the REAL `api/time/[...path].js` handler against the loopback
// fake GoTrue/PostgREST (fake-supabase.mjs), never a live project (BUILD_INTEGRITY §6b;
// no sandbox exists yet, CS-033).
//
// Every oracle is a source-of-truth constant — the permission key and the reason string
// come from `src/lib/clockRules.js`, the verdict shape from `src/lib/geo.js` — never a
// literal restated here (THE LAW II.3).
//
//   node scripts/test-clock-rules.mjs
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

const ORG = '00000000-0000-0000-0000-000000000001';
// Set BEFORE anything under api/ loads (constants.js / orgState.js read env at import).
// The URL is a closed local port and fetch is stubbed: nothing here can reach a network.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

installFakeSupabase();

const { PERMISSIONS, seedPermissions } = await import('../src/lib/roles.js');
const { CLOCK_RULE_KEYS, CLOCK_RULES_PERM, GEOFENCE_OFF_REASON, clockRulesOff, nextClockRules }
  = await import('../src/lib/clockRules.js');
const { protectedFieldViolations, protectedFingerprint } = await import('../api/_lib/orgStateGuard.js');
const { mergeCrewChanges } = await import('../api/_lib/crewMerge.js');
const { projectCrewView } = await import('../api/_lib/crewView.js');
const time = (await import('../api/time/[...path].js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

// ── the roster ──────────────────────────────────────────────────────────────
// A cleaner whose geofence is off, one whose rules are normal, and the office tiers.
// `mgr` is claim-less, as every live manager is (claims.js knew no manager role until S80).
const OFF = { [CLOCK_RULE_KEYS.geofence]: true };
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true },
  admin: { id: 'u_admin', role: 'admin', claim: true },
  mgr: { id: 'u_mgr', role: 'manager', claim: false },
  mgrNoKey: { id: 'u_mgr_nokey', role: 'manager', claim: false },  // time.clockRules revoked
  crew: { id: 'u_crew', role: 'crew', claim: true },
  crewKey: { id: 'u_crew_key', role: 'crew', claim: true },        // time.clockRules GRANTED
  crewTeam: { id: 'u_crew_team', role: 'crew', claim: true },      // settings.team.edit GRANTED (may add a member)
  crewOff: { id: 'u_crew_off', role: 'crew', claim: true, clockRules: OFF },
};
const emailOf = (k) => `${k.toLowerCase()}@example.test`;
const roster = Object.entries(PEOPLE).map(([k, p]) => ({
  id: p.id, email: emailOf(k), role: p.role, status: 'active', name: k,
  ...(p.clockRules ? { clockRules: p.clockRules } : {}),
}));
const OVERRIDES = [
  { userId: 'u_mgr_nokey', grants: [], revokes: [CLOCK_RULES_PERM] },
  { userId: 'u_crew_key', grants: [CLOCK_RULES_PERM], revokes: [] },
  { userId: 'u_crew_team', grants: ['settings.team.edit', 'staff.assignRoles'], revokes: [] },
];
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, {
  id: `auth-${k}`,
  email: emailOf(k),
  app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {},
}]));

// ── 0. the vocabulary ───────────────────────────────────────────────────────
ok('the permission key is defined in PERMISSIONS', !!PERMISSIONS[CLOCK_RULES_PERM],
  `PERMISSIONS has no \`${CLOCK_RULES_PERM}\``);
ok('its default roles are owner + admin + manager, never crew',
  JSON.stringify((PERMISSIONS[CLOCK_RULES_PERM]?.defaultRoles || []).slice().sort())
  === JSON.stringify(['admin', 'manager', 'owner']),
  JSON.stringify(PERMISSIONS[CLOCK_RULES_PERM]?.defaultRoles));

// ── 1. the org_state guard ──────────────────────────────────────────────────
// The blob the guard judges: the roster + the committed matrix and overrides it reads
// permissions from (matrixAuthority reads `prev`, never the proposed save).
const baseState = () => ({
  users: structuredClone(roster),
  permissions: seedPermissions(),
  userPermissionOverrides: structuredClone(OVERRIDES),
  clients: [], sites: [],
});
// A proposed save that sets `patch` on one member's row.
const withRules = (state, id, rules) => ({
  ...state,
  users: state.users.map((u) => (u.id === id ? { ...u, clockRules: rules } : u)),
});

{
  const prev = baseState();
  const cases = [
    // [label, actor, target, expected: true = refused]
    ['crew on their OWN row', 'crew', 'u_crew', true],
    ['crew on another cleaner', 'crew', 'u_crew_off', true],
    ['a manager pared off the key, on a cleaner', 'mgrNoKey', 'u_crew', true],
    ['a manager pared off the key, on their OWN row', 'mgrNoKey', 'u_mgr_nokey', true],
    ['a manager holding the key, on a cleaner', 'mgr', 'u_crew', false],
    ['an admin on a cleaner', 'admin', 'u_crew', false],
    ['the owner on a cleaner', 'owner', 'u_crew', false],
    // R5 — "the cleaner has no way around the block" (Daniel, 2026-09-27), and the call's
    // "Super Admin and Manager level". EVERY row takes an OFFICE role BY ROLE as well as the
    // key (coordinator's G2 ruling after the L3 review), so a per-user GRANT of
    // time.clockRules to a crew member does nothing for this field at all: two granted
    // cleaners could otherwise exempt each other, and one could turn an office member's
    // geofence off. A grant reaches any key (can() puts none out of its reach), so the floor
    // cannot be a key — the same reasoning as canEndAccess's admin+ floor.
    ['a cleaner GRANTED the key, on their OWN row', 'crewKey', 'u_crew_key', true],
    ['a cleaner GRANTED the key, on ANOTHER cleaner', 'crewKey', 'u_crew', true],
    ['a cleaner GRANTED the key, on a MANAGER', 'crewKey', 'u_mgr', true],
    ['a manager on their OWN row (office tier + the key)', 'mgr', 'u_mgr', false],
    ['an admin on their OWN row', 'admin', 'u_admin', false],
  ];
  for (const [label, actor, target, refused] of cases) {
    const { id, role } = PEOPLE[actor];
    const next = withRules(prev, target, { [CLOCK_RULE_KEYS.checklist]: true });
    const v = protectedFieldViolations(prev, next, role, id);
    ok(`guard: ${label} → ${refused ? 'refused' : 'allowed'}`, (v.length > 0) === refused,
      `violations: ${JSON.stringify(v)}`);
  }
  // Turning a rule back ON (clearing the field) is the same authority as turning it off:
  // an unguarded clear would let a cleaner re-arm someone else's gates, and more to the
  // point it is the same field, so the same key decides.
  const prevOff = baseState();
  const cleared = withRules(prevOff, 'u_crew_off', null);
  ok('guard: crew clearing another cleaner\'s rules → refused',
    protectedFieldViolations(prevOff, cleared, 'crew', 'u_crew').length > 0);
  ok('guard: a key holder clearing them → allowed',
    protectedFieldViolations(prevOff, cleared, 'manager', 'u_mgr').length === 0);
  // ── a NEW row carries clock rules too (G1, the L3 review's Medium) ──────────
  // The new-member branch checked the role, the email, pay and hr, then `continue`d, so a
  // row could be ADDED already exempt — every new hire pre-exempted, and a removed id
  // re-added with the block off. A new row is judged by the same rule as a changed one.
  const hire = (state, extra) => ({
    ...state,
    users: [...state.users, { id: 'u_new', email: 'new@example.test', role: 'crew', status: 'active', name: 'new', ...extra }],
  });
  const newCases = [
    // [label, actor, the new row's extra fields, expected: true = refused]
    ['a manager pared off the key hires someone pre-exempted', 'mgrNoKey', { clockRules: OFF }, true],
    ['a cleaner granted settings.team.edit hires someone pre-exempted', 'crewTeam', { clockRules: OFF }, true],
    ['a cleaner granted the clock key hires someone pre-exempted', 'crewKey', { clockRules: OFF }, true],
    ['a manager holding the key hires someone pre-exempted', 'mgr', { clockRules: OFF }, false],
    ['a manager pared off the key hires someone with NORMAL rules', 'mgrNoKey', {}, false],
    ['…or with an explicit empty rules field', 'mgrNoKey', { clockRules: null }, false],
  ];
  for (const [label, actor, extra, refused] of newCases) {
    const { id, role } = PEOPLE[actor];
    const v = protectedFieldViolations(prev, hire(prev, extra), role, id);
    ok(`guard (new row): ${label} → ${refused ? 'refused' : 'allowed'}`, (v.length > 0) === refused,
      `violations: ${JSON.stringify(v)}`);
  }
  // Re-adding an id the roster no longer carries is a NEW row, not a change, so it takes
  // the same rule — otherwise removing and re-adding someone is the way around it.
  {
    const without = { ...prev, users: prev.users.filter((u) => u.id !== 'u_crew_off') };
    const readded = { ...without, users: [...without.users, { ...roster.find((u) => u.id === 'u_crew_off') }] };
    ok('guard (new row): re-adding a removed id WITH the block off → refused',
      protectedFieldViolations(without, readded, 'manager', 'u_mgr_nokey').length > 0,
      JSON.stringify(protectedFieldViolations(without, readded, 'manager', 'u_mgr_nokey')));
    ok('guard (new row): a key holder re-adding them → allowed',
      protectedFieldViolations(without, readded, 'manager', 'u_mgr').length === 0,
      JSON.stringify(protectedFieldViolations(without, readded, 'manager', 'u_mgr')));
  }
  // The words name the field, so a refusal is actionable in the 403 body.
  const vOwn = protectedFieldViolations(prevOff, withRules(prevOff, 'u_crew', OFF), 'crew', 'u_crew');
  ok('guard: the refusal names the clock rules', vOwn.some((s) => /clock rule|checklist block|geofence/i.test(s)),
    JSON.stringify(vOwn));
  // A save that changes nothing about the field is never refused (an ordinary crew save
  // re-sends the whole roster).
  ok('guard: an unchanged roster is allowed for crew',
    protectedFieldViolations(prevOff, baseState(), 'crew', 'u_crew').length === 0);
}

// ── 2. the protected fingerprint ────────────────────────────────────────────
// Without this the endpoint's digest shortcut skips the guard entirely and the check
// above never runs on a save that touches only this field.
{
  const a = baseState();
  const b = withRules(a, 'u_crew', { [CLOCK_RULE_KEYS.checklist]: true });
  ok('fingerprint: turning the checklist block off moves the digest',
    protectedFingerprint(a) !== protectedFingerprint(b),
    `${protectedFingerprint(a)} === ${protectedFingerprint(b)}`);
  const c = withRules(a, 'u_crew_off', null);
  ok('fingerprint: clearing a cleaner\'s rules moves the digest',
    protectedFingerprint(a) !== protectedFingerprint(c));
  // Key order is jsonb's business, not a change.
  const d = withRules(a, 'u_crew', { [CLOCK_RULE_KEYS.checklist]: true, [CLOCK_RULE_KEYS.geofence]: true });
  const e = withRules(a, 'u_crew', { [CLOCK_RULE_KEYS.geofence]: true, [CLOCK_RULE_KEYS.checklist]: true });
  ok('fingerprint: key order alone is not a change', protectedFingerprint(d) === protectedFingerprint(e));
}

// ── 3. the crew write merge + the crew projection ────────────────────────────
{
  const full = baseState();
  const served = projectCrewView(full, { userId: 'u_crew_off', crewJobs: [] });
  const servedSelf = served.users.find((u) => u.id === 'u_crew_off');
  ok('crew view: a cleaner is served their OWN clock rules (the client gate reads them)',
    JSON.stringify(servedSelf?.clockRules ?? null) === JSON.stringify(OFF),
    JSON.stringify(servedSelf));
  ok('crew view: another member\'s clock rules are not served',
    served.users.filter((u) => u.id !== 'u_crew_off').every((u) => u.clockRules === undefined),
    JSON.stringify(served.users));

  // A crafted crew save: their own rules flipped, and a teammate's too.
  const posted = structuredClone(served);
  posted.users = posted.users.map((u) => (u.id === 'u_crew_off'
    ? { ...u, clockRules: { [CLOCK_RULE_KEYS.checklist]: true, [CLOCK_RULE_KEYS.geofence]: true }, name: 'renamed' }
    : u.id === 'u_crew' ? { ...u, clockRules: OFF } : u));
  const { next, dropped } = mergeCrewChanges({ full, posted, userId: 'u_crew_off', scope: { clientIds: [] } });
  const mergedSelf = next.users.find((u) => u.id === 'u_crew_off');
  ok('crew merge: a crew-posted change to their OWN clockRules is dropped',
    JSON.stringify(mergedSelf.clockRules) === JSON.stringify(OFF),
    JSON.stringify(mergedSelf.clockRules));
  ok('crew merge: the allowlisted name change still lands', mergedSelf.name === 'renamed');
  ok('crew merge: a teammate\'s clockRules are untouched',
    next.users.find((u) => u.id === 'u_crew').clockRules === undefined);
  ok('crew merge: the foreign edit is reported', dropped.some((d) => d.slice === 'users' && d.id === 'u_crew'),
    JSON.stringify(dropped));
  // Defence in depth: the merge's own output must pass the guard (org-state.js refuses 500
  // if it ever doesn't).
  ok('crew merge: the merged state passes the guard',
    protectedFieldViolations(full, next, 'crew', 'u_crew_off').length === 0,
    JSON.stringify(protectedFieldViolations(full, next, 'crew', 'u_crew_off')));
}

// ── 4. clock-in with the geofence off for that cleaner (the real handler) ────
const H = 3600e3;
const NOW = Date.now();
const iso = (ms) => new Date(NOW + ms).toISOString();
// A coord'd site with a tight ring, and a device 5 km away: normally an off-site block.
const SITE = { id: 'st_1', clientId: 'cl_1', name: 'Coral Bay', lat: 26.1, lng: -80.1, geofenceRadiusM: 100, geofenceEnabled: true };
const FAR = { lat: 26.145, lng: -80.1, accuracyM: 5 };     // ~5 km north
const jobRow = (id, crewIds) => ({
  organization_id: ORG, id, site_id: SITE.id, status: 'upcoming', start_at: iso(-H),
  data: { id, siteId: SITE.id, clientId: 'cl_1', crewIds, startAt: iso(-H), endAt: iso(H), status: 'upcoming' },
});

function buildWorld({ siteGeofenceEnabled = true } = {}) {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG,
        state: {
          ...baseState(),
          clients: [{ id: 'cl_1', name: 'Coral Bay HOA' }],
          sites: [{ ...SITE, geofenceEnabled: siteGeofenceEnabled }],
          opsSettings: { offlineReplayWindowHours: 12 },
        },
        version: 3,
      }],
      jobs: [jobRow('j_1', ['u_crew', 'u_crew_off'])],
      time_entries: [],
    },
    logins,
  });
}

async function call(handler, { method = 'POST', path, token, body }) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { subpath: path };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} ${path}: no response`)), 5000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;
const punchOf = (userId) => world.tables.time_entries.find((e) => e.user_id === userId) || null;

{
  // The control: rules normal, device far away → the off-site block, as today.
  buildWorld();
  const blocked = await call(time, { path: 'clock-in', token: 'tok-crew', body: { jobId: 'j_1', ...FAR, clientPunchId: 'op_a' } });
  ok('clock-in: a cleaner with normal rules is blocked off-site', blocked.status === 403, show(blocked));

  // The rule: the geofence is off for this cleaner → accepted, from anywhere, and the
  // punch says why.
  buildWorld();
  const offRes = await call(time, { path: 'clock-in', token: 'tok-crewOff', body: { jobId: 'j_1', ...FAR, clientPunchId: 'op_b' } });
  ok('clock-in: with the geofence off there is no 403', offRes.status === 200, show(offRes));
  const punch = punchOf('u_crew_off');
  ok('clock-in: the punch records the override result', punch?.geofence_result === 'override',
    JSON.stringify(punch?.geofence_result));
  ok('clock-in: the punch records the per-cleaner reason', punch?.override_reason === GEOFENCE_OFF_REASON,
    JSON.stringify(punch?.override_reason));
  ok('clock-in: nobody is recorded as having overridden it', punch?.override_by_user_id == null,
    JSON.stringify(punch?.override_by_user_id));
  ok('clock-in: the distance is still measured', Number.isFinite(punch?.clock_in_distance_m),
    JSON.stringify(punch?.clock_in_distance_m));

  // A site-level disable keeps its own reason, so the two are distinguishable.
  buildWorld({ siteGeofenceEnabled: false });
  const siteOff = await call(time, { path: 'clock-in', token: 'tok-crew', body: { jobId: 'j_1', ...FAR, clientPunchId: 'op_c' } });
  ok('clock-in: a site-level disable still succeeds', siteOff.status === 200, show(siteOff));
  ok('clock-in: a site-level disable keeps its own reason',
    punchOf('u_crew')?.override_reason === 'geofence_disabled',
    JSON.stringify(punchOf('u_crew')?.override_reason));

  // A crafted override reason must not overwrite the server's own verdict reason.
  buildWorld();
  await call(time, { path: 'clock-in', token: 'tok-crewOff', body: { jobId: 'j_1', ...FAR, clientPunchId: 'op_d', override: true, overrideReason: 'crew_override_offsite' } });
  ok('clock-in: a client-claimed reason never replaces the config reason',
    punchOf('u_crew_off')?.override_reason === GEOFENCE_OFF_REASON,
    JSON.stringify(punchOf('u_crew_off')?.override_reason));

  // The offline replay re-runs the geofence too, so it must carry the same reason.
  buildWorld();
  const replay = await call(time, {
    path: 'replay',
    token: 'tok-crewOff',
    body: { clientPunchId: 'op_r', jobId: 'j_1', assertedInAt: iso(-10 * 60e3), inLat: FAR.lat, inLng: FAR.lng, inAccuracyM: FAR.accuracyM },
  });
  ok('replay: a buffered punch is accepted', replay.status === 200, show(replay));
  ok('replay: it records the override result', punchOf('u_crew_off')?.geofence_result === 'override',
    JSON.stringify(punchOf('u_crew_off')?.geofence_result));
  ok('replay: it records the per-cleaner reason', punchOf('u_crew_off')?.override_reason === GEOFENCE_OFF_REASON,
    JSON.stringify(punchOf('u_crew_off')?.override_reason));
}

// ── 5. the sparse-field helpers the UI writes through ───────────────────────
{
  ok('helpers: nothing off reads as no rules', clockRulesOff({ id: 'x' }).length === 0);
  ok('helpers: both off are both listed',
    clockRulesOff({ clockRules: { [CLOCK_RULE_KEYS.checklist]: true, [CLOCK_RULE_KEYS.geofence]: true } }).length === 2);
  ok('helpers: turning a rule off writes exactly that flag',
    JSON.stringify(nextClockRules(null, CLOCK_RULE_KEYS.geofence, true)) === JSON.stringify(OFF),
    JSON.stringify(nextClockRules(null, CLOCK_RULE_KEYS.geofence, true)));
  ok('helpers: turning the last rule back on clears the field, never leaves {}',
    nextClockRules(OFF, CLOCK_RULE_KEYS.geofence, false) === null,
    JSON.stringify(nextClockRules(OFF, CLOCK_RULE_KEYS.geofence, false)));
  ok('helpers: turning one of two back on keeps the other',
    JSON.stringify(nextClockRules({ [CLOCK_RULE_KEYS.checklist]: true, [CLOCK_RULE_KEYS.geofence]: true }, CLOCK_RULE_KEYS.checklist, false))
    === JSON.stringify(OFF));
  ok('helpers: a non-true stored value is not "off" (only `true` turns a gate off)',
    clockRulesOff({ clockRules: { [CLOCK_RULE_KEYS.geofence]: 'yes' } }).length === 0);
  // Two switches, ONE object. TeamDetail must fold each flip into the value the PREVIOUS
  // flip produced, not into the member as stored — computing both from the stored row (as
  // the first cut did) makes two flips in one React batch each read `null`, and the second
  // silently undoes the first. Caught driving the demo: turning both off saved one.
  const afterFirst = nextClockRules(null, CLOCK_RULE_KEYS.checklist, true);
  const afterSecond = nextClockRules(afterFirst, CLOCK_RULE_KEYS.geofence, true);
  ok('helpers: folding one flip into the next keeps both off',
    clockRulesOff({ clockRules: afterSecond }).length === 2, JSON.stringify(afterSecond));
}

// ── report ──────────────────────────────────────────────────────────────────
if (fails.length) {
  console.error(`\n✖ clock rules: ${fails.length} failed, ${pass} passed\n`);
  for (const f of fails) console.error(`    ✗ ${f}`);
  console.error('');
  process.exitCode = 1;
} else {
  console.log(`✓ clock rules: ${pass} checks passed (guard, fingerprint, crew merge + view, clock-in + replay, helpers)`);
}
