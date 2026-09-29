// lint:search core (scripts/search-lint.mjs) — driven with synthetic App.jsx + registry
// fixtures so each drift rule is pinned: missing entry fails, exclusion passes, stale
// exclusion fails, perm mismatch fails, param/redirect routes are exempt, sub-tab entries
// are not perm-reconciled, unknown perms fail. Then the REAL reconcile: this repo's
// App.jsx against the real registry. That last assertion is how CI enforces lint:search —
// CI `verify` runs run-tests, and a dedicated ci.yml step would need the GitHub `workflow`
// token scope, which the push credential doesn't carry.
//
//   node scripts/test-search-lint.mjs
import { readFileSync } from 'node:fs';
import { parseRoutes, lintSearch } from './search-lint.mjs';
import { NAV_ENTRIES, EXCLUDED_ROUTES, DETAIL_ROUTES } from '../src/lib/masterSearch/registry.js';
import { PERMISSIONS, ALWAYS_GRANTED } from '../src/lib/roles.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const APP = `
  <Route element={<AuthedShell />}>
    <Route element={<AppLayout />}>
      <Route index element={<HomeRoute />} />
      <Route path="schedule" element={<RequirePerm perm="schedule.view"><Schedule /></RequirePerm>} />
      <Route path="schedule/:jobId" element={<RequirePerm perm="schedule.view"><JobDetail /></RequirePerm>} />
      <Route path="reminders" element={<Navigate to="/" replace />} />
      <Route path="reviews" element={<RequirePerm perm="reviews.view"><Reviews /></RequirePerm>} />
      <Route path="settings" element={<SettingsLayout />}>
        <Route index element={<SettingsHub />} />
        <Route path="team" element={<RequirePerm perm="settings.team.view"><Team /></RequirePerm>} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Route>
  </Route>
`;
const permVocab = new Set(['schedule.view', 'schedule.edit', 'reviews.view', 'settings.team.view', 'settings.team.edit']);

// ── parseRoutes classification ─────────────────────────────────────────────────
{
  const { pageRoutes, paramRoutes } = parseRoutes(APP);
  ok('parses / index route', pageRoutes.has('/') && pageRoutes.get('/') === null);
  ok('parses /schedule with its perm', pageRoutes.get('/schedule') === 'schedule.view');
  ok('settings layout is an ungated page route', pageRoutes.get('/settings') === null);
  ok('absolutises settings child', pageRoutes.get('/settings/team') === 'settings.team.view');
  ok('param route captured separately', paramRoutes.has('/schedule/:jobId') && !pageRoutes.has('/schedule/:jobId'));
  ok('redirect route excluded', !pageRoutes.has('/reminders'));
  ok('catch-all excluded', !pageRoutes.has('*'));
}

// ── a clean, fully-covered registry passes ────────────────────────────────────
const goodEntries = [
  { id: 'page:/', kind: 'page', to: '/', perm: 'schedule.view' },       // index route has no perm → not reconciled
  { id: 'page:/schedule', kind: 'page', to: '/schedule', perm: 'schedule.view' },
  { id: 'page:/settings', kind: 'page', to: '/settings', perm: 'settings.team.view' }, // layout ungated → skipped
  { id: 'page:/settings/team', kind: 'page', to: '/settings/team', perm: 'settings.team.view' },
  { id: 'action:new-job', kind: 'action', to: '/schedule?new=1', perm: 'schedule.edit' }, // action: perm not reconciled
];
const goodExcluded = [{ path: '/reviews', reason: 'hidden until Google connection' }];
const goodDetail = ['/schedule/:jobId'];
const base = { appSrc: APP, excluded: goodExcluded, detailRoutes: goodDetail, permVocab };

ok('clean registry passes', lintSearch({ ...base, entries: goodEntries }).length === 0);

// ── (a) a route with no entry and no exclusion fails ───────────────────────────
{
  const missing = goodEntries.filter((e) => e.to !== '/schedule');
  const v = lintSearch({ ...base, entries: missing });
  ok('missing entry for /schedule fails', v.some((x) => x.includes('/schedule')));
}
// exclusion satisfies coverage (reviews has no entry but is excluded → clean)
ok('excluded route needs no entry', !lintSearch({ ...base, entries: goodEntries }).some((x) => x.includes('/reviews')));

// ── (b) stale exclusion fails ───────────────────────────────────────────────────
{
  const v = lintSearch({ ...base, entries: goodEntries, excluded: [{ path: '/ghost', reason: 'x' }] });
  ok('stale exclusion /ghost fails', v.some((x) => x.includes('/ghost')));
  ok('and the now-unexcluded /reviews also fails (a)', v.some((x) => x.includes('/reviews')));
}
// entry pointing at a nonexistent route fails
{
  const v = lintSearch({ ...base, entries: [...goodEntries, { id: 'page:/zzz', kind: 'page', to: '/zzz', perm: 'schedule.view' }] });
  ok('entry at nonexistent route fails', v.some((x) => x.includes('/zzz')));
}
// stale detail route fails
ok('stale detail route fails', lintSearch({ ...base, entries: goodEntries, detailRoutes: ['/nope/:id'] }).some((x) => x.includes('/nope/:id')));

// ── (c) perm mismatch on a canonical page entry fails; sub-tab + action exempt ──
{
  const bad = goodEntries.map((e) => (e.id === 'page:/schedule' ? { ...e, perm: 'schedule.edit' } : e));
  ok('perm mismatch fails', lintSearch({ ...base, entries: bad }).some((x) => x.includes('perm mismatch')));
}
{
  // a sub-tab entry (has ?query) tightening perm is NOT reconciled
  const withSubtab = [...goodEntries, { id: 'page:/schedule?view=x', kind: 'page', to: '/schedule?view=x', perm: 'schedule.edit' }];
  ok('sub-tab entry not perm-reconciled', !lintSearch({ ...base, entries: withSubtab }).some((x) => x.includes('/schedule?view=x')));
}

// ── (d) unknown perm fails ──────────────────────────────────────────────────────
ok('unknown perm fails', lintSearch({ ...base, entries: [...goodEntries, { id: 'page:/schedule2', kind: 'page', to: '/schedule', perm: 'made.up' }] }).some((x) => x.includes('made.up')));
ok('unknown permsAll key fails', lintSearch({ ...base, entries: [...goodEntries, { id: 'page:/schedule?tab=x', kind: 'page', to: '/schedule?tab=x', perm: 'schedule.view', permsAll: ['also.made.up'] }] }).some((x) => x.includes('also.made.up')));

// ── 🔴 THE REAL RECONCILE: this repo's App.jsx ⇔ the real registry (CI runs this) ───
{
  const appSrc = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const drift = lintSearch({
    appSrc,
    entries: NAV_ENTRIES,
    excluded: EXCLUDED_ROUTES,
    detailRoutes: DETAIL_ROUTES,
    permVocab: new Set([...Object.keys(PERMISSIONS), ...ALWAYS_GRANTED]),
  });
  ok(`App.jsx routes and the search registry reconcile${drift.length ? ` — ${drift.join(' | ')}` : ''}`, drift.length === 0);
  ok('parsed a realistic route table from App.jsx', parseRoutes(appSrc).pageRoutes.size >= 20);
}

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`\nsearch-lint core: ${pass}/${pass} passed`);
