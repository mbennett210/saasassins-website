// CS-674 — the first letter typed in global search no longer freezes the app, and a clean
// changing (a realtime patch, a clock-out marking it done) no longer starts the freeze over.
//
// At Matt's size (49,883 visits) the first key built a candidate for EVERY visit — two date
// formats each through a per-call formatter, three linear finds — one 7.3 s task on a desktop,
// and the cache was keyed on the jobs array's identity, which every realtime patch and every
// clock-out replaces, so it came back all evening (S128 full-app pass, F11-05).
//
//   A. THE ENGINE (lib/masterSearch/collect.js, fake adapters):
//      a changed list rebuilds only the records that changed (a source's `signature`);
//      the slices a source reads (`reads`) and its display context (`context`) refresh it;
//      a source can bound what it offers (`keep`); a recent resolves by building ONE record;
//      a 150,000-record source collects without blowing the call stack.
//   B. THE REAL VISIT SOURCE (lib/masterSearch/jobRecords.js) at 49,883 visits: the build, a
//      clean changing, a shared-record adoption and a customer rename, against budgets; its
//      words against fmtDate and the status vocabulary (never a restated literal); the window.
//   C. LOCKSTEP: sources.js wires the visit source with the page's own crew scoping.
//
// Offline. Run: node scripts/test-master-search-speed.mjs
import { readFileSync } from 'node:fs';
import { collectCandidates, resolveFromSources, candidatesFor } from '../src/lib/masterSearch/collect.js';
import { rankEntries } from '../src/lib/masterSearch/rank.js';
import { fmtDate, setOrgTimezone, setUiLocale, DEFAULT_ORG_TIMEZONE } from '../src/lib/dates.js';
import { JOB_STATUS_LABELS } from '../src/lib/jobStatus.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const allowAll = () => true;
const user = { id: 'u_owner', role: 'owner' };
const DAY = 86400000;
const NOW = Date.parse('2026-10-12T16:00:00.000Z');

// ── A. the engine ────────────────────────────────────────────────────────────────────
function countingSource(extra = {}) {
  const calls = { primary: 0 };
  const src = {
    type: 'rec', typeLabel: 'Rec', groupLabel: 'Recs', groupIcon: 'x', perm: 'p',
    select: (s) => s.recs,
    primary: (r, s) => { calls.primary += 1; return `${(s.names && s.names[r.nameId]) || r.name} ${r.n}`; },
    sublabel: () => '',
    keywords: (r) => [r.note || ''],
    to: (r) => `/r/${r.id}`,
    ...extra,
  };
  return { src, calls };
}
const recs = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `Rec`, n: i, nameId: `k${i % 7}` }));

{ // A1/A2 — a changed list rebuilds only what changed
  const { src, calls } = countingSource({ reads: ['names'], signature: (r, s) => (s.names && s.names[r.nameId]) || '' });
  const list = recs(1000);
  const s1 = { recs: list };
  const first = candidatesFor(src, list, s1, 0, NOW);
  ok('A1 the first build builds every record', calls.primary === 1000 && first.length === 1000);
  calls.primary = 0;
  const changed = list.slice(); changed[500] = { ...list[500], n: 99999 };
  const second = candidatesFor(src, changed, { recs: changed }, 0, NOW);
  ok(`A1 one record changed → one record rebuilt (rebuilt ${calls.primary})`, calls.primary === 1);
  ok('A1 the unchanged records keep their candidate objects', second[0] === first[0] && second[999] === first[999]);
  ok('A1 the changed record reads its new value', second[500].label === 'Rec 99999');
  calls.primary = 0;
  const third = candidatesFor(src, changed, { recs: changed, names: { k3: 'Renamed' } }, 0, NOW);
  const k3 = changed.filter((r) => r.nameId === 'k3').length;
  ok(`A2 a signature change rebuilds just those records (${calls.primary} of ${k3})`, calls.primary === k3);
  ok('A2 …and they read the new value', third.find((c) => c.refId === 'r3').label === 'Renamed 3');
}

{ // A3/A4 — the slices a source reads refresh it, even while its own list is unchanged
  const { src, calls } = countingSource({ reads: ['names'], signature: (r, s) => (s.names && s.names[r.nameId]) || '' });
  const list = recs(50);
  const a = candidatesFor(src, list, { recs: list, names: { k1: 'Acme' } }, 0, NOW);
  ok('A3 starts from the read slice', a.find((c) => c.refId === 'r1').label === 'Acme 1');
  const b = candidatesFor(src, list, { recs: list, names: { k1: 'Acme Renamed' } }, 0, NOW);
  ok('A3 a renamed record in a READ slice refreshes the candidates (same list)', b.find((c) => c.refId === 'r1').label === 'Acme Renamed 1');
  calls.primary = 0;
  const c = candidatesFor(src, list, { recs: list, names: { k1: 'Acme Renamed' } }, 0, NOW);
  ok('A4 a new read slice with the same values rebuilds nothing', calls.primary === 0 && c[1] === b[1]);
}

{ // A5 — a source bounds what it offers
  const { src } = countingSource({ keep: (r) => r.n % 2 === 0 });
  const list = recs(10);
  const out = candidatesFor(src, list, { recs: list }, 0, NOW);
  ok('A5 `keep` drops what the source does not offer', out.length === 5 && out.every((c) => Number(c.refId.slice(1)) % 2 === 0));
}

{ // A6 — a recent resolves by building one record, never the whole list
  const { src, calls } = countingSource({ signature: () => '' });
  const list = recs(2000);
  const hit = resolveFromSources([src], { recs: list }, user, allowAll, 'rec', 'r1234', { now: NOW });
  ok(`A6 resolving a recent builds one record (built ${calls.primary})`, calls.primary === 1 && hit && hit.refId === 'r1234');
  ok('A6 a missing record still resolves to null', resolveFromSources([src], { recs: list }, user, allowAll, 'rec', 'nope', { now: NOW }) === null);
}

{ // A7 — a big source never blows the call stack (`out.push(...150k)` threw RangeError)
  const { src } = countingSource();
  const list = recs(150000);
  let threw = null;
  let out = [];
  try { out = collectCandidates([src], { recs: list }, user, allowAll, { now: NOW }); } catch (e) { threw = e; }
  ok(`A7 150,000 records collect without throwing (${threw ? threw.message : 'ok'})`, !threw && out.length === 150000);
}

{ // A8 — the display context (locale, zone) refreshes the candidates
  let ctx = 'en';
  const { src } = countingSource({ context: () => ctx, primary: (r) => `${ctx}:${r.n}` });
  const list = recs(5);
  const a = candidatesFor(src, list, { recs: list }, 0, NOW);
  ctx = 'es';
  const b = candidatesFor(src, list, { recs: list }, 0, NOW);
  ok('A8 a context change rebuilds the candidates', a[0].label === 'en:0' && b[0].label === 'es:0');
}

{ // A9 — the day rolls (a clean's distance from today is date-relative)
  const { src, calls } = countingSource({ signature: () => '' });
  const list = recs(20);
  candidatesFor(src, list, { recs: list }, 0, NOW);
  calls.primary = 0;
  candidatesFor(src, list, { recs: list }, 0, NOW + DAY);
  ok('A9 a new day rebuilds every record', calls.primary === 20);
}

// ── B. the real visit source at Matt's size ─────────────────────────────────────────────
let jr = null;
try { jr = await import('../src/lib/masterSearch/jobRecords.js'); } catch (e) { fails.push(`B the visit source module loads (${e.code || e.message})`); }
if (jr) {
  setOrgTimezone(DEFAULT_ORG_TIMEZONE);
  setUiLocale(undefined);
  const effectiveStatus = (job, now = Date.now()) => (['done', 'in_progress', 'cancelled', 'missed'].includes(job.status) ? job.status
    : (new Date(job.startAt).getTime() < now ? 'missed' : 'upcoming'));
  const source = jr.makeJobSource({ select: (s) => s.jobs, effectiveStatus });

  // 768 customers, 767 locations, 10 services; 49,883 visits from 70 days back to 20 ahead,
  // weekdays, at the handful of start times a cleaning schedule has (the F11 flood's shape).
  const clients = Array.from({ length: 768 }, (_, i) => ({ id: `cl${i}`, name: `${['Harbor', 'Coral', 'Palm', 'Lakeside', 'Bay'][i % 5]} Towers ${i}` }));
  const sites = clients.map((c, i) => ({ id: `st${i}`, clientId: c.id, name: `${c.name} – Main` }));
  const services = Array.from({ length: 10 }, (_, i) => ({ id: `sv${i}`, name: `Service ${i}` }));
  const STARTS = ['22:00', '23:00', '23:30', '00:00', '13:00', '14:30', '17:00', '18:00'];
  const jobs = [];
  for (let d = -70; jobs.length < 49883; d++) {
    const day = new Date(NOW + d * DAY);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    for (let k = 0; k < 768 && jobs.length < 49883; k++) {
      const [h, m] = STARTS[k % STARTS.length].split(':').map(Number);
      const start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m);
      jobs.push({ id: `j${d}_${k}`, clientId: `cl${k}`, siteId: `st${k}`, serviceId: `sv${k % 10}`, crewIds: [`u${k}`],
        status: start < NOW ? 'done' : 'upcoming', startAt: new Date(start).toISOString(), endAt: new Date(start + 2 * 3600000).toISOString(), notes: k % 50 === 0 ? 'Floor buffer in the lobby' : '' });
    }
  }
  const state = { jobs, clients, sites, services };
  ok(`B the fixture is Matt's size (${jobs.length} visits)`, jobs.length === 49883);

  // B1 the first build (the first key's work), with its formatter calls counted
  let formats = 0;
  const desc = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, 'format');
  Object.defineProperty(Intl.DateTimeFormat.prototype, 'format', { configurable: true, get() { const f = desc.get.call(this); return (d) => { formats += 1; return f(d); }; } });
  let t = performance.now();
  const built = candidatesFor(source, state.jobs, state, 4, NOW);
  const buildMs = performance.now() - t;
  Object.defineProperty(Intl.DateTimeFormat.prototype, 'format', desc);
  const distinctStarts = new Set(jobs.map((j) => j.startAt)).size;
  console.log(`  B1 build: ${buildMs.toFixed(0)} ms for ${built.length} visit candidates · ${formats} date formats for ${distinctStarts} distinct starts`);
  ok(`B1 the first build fits the first-key budget (${buildMs.toFixed(0)} ms < 1500 ms in node)`, buildMs < 1500);
  ok(`B1 dates are formatted once per distinct start instant, not twice per visit (${formats} ≤ ${2 * distinctStarts})`, formats <= 2 * distinctStarts);

  // B2 the words: the visit's sublabel and date keyword ARE fmtDate's, the status label the vocabulary's
  const sample = built.find((c) => c.refId === jobs[12345].id);
  const j = jobs[12345];
  const wantSub = [fmtDate(j.startAt, { weekday: 'short', month: 'short', day: 'numeric' }), services.find((x) => x.id === j.serviceId).name, JOB_STATUS_LABELS[effectiveStatus(j, NOW)]].join(' · ');
  ok(`B2 the sublabel is fmtDate · service · status (${sample && sample.sublabel})`, sample && sample.sublabel === wantSub);
  ok('B2 the label is the customer', sample && sample.label === clients.find((c) => c.id === j.clientId).name);
  ok('B2 the keywords carry the location, the service and the short date', sample && sample.keywords.includes(sites.find((x) => x.id === j.siteId).name)
    && sample.keywords.includes(fmtDate(j.startAt, { month: 'short', day: 'numeric' })) && sample.keywords.includes(JOB_STATUS_LABELS[effectiveStatus(j, NOW)]));
  ok('B2 it lands on the clean', sample && sample.to === `/schedule/${j.id}`);

  // B3 a clean changes (PATCH_JOBS / a clock-out's done): a new array, one new row
  const patched = jobs.slice();
  patched[777] = { ...jobs[777], status: 'done' };
  t = performance.now();
  const after = candidatesFor(source, patched, { ...state, jobs: patched }, 4, NOW);
  const patchMs = performance.now() - t;
  console.log(`  B3 a clean changes: ${patchMs.toFixed(1)} ms`);
  ok(`B3 a clean changing re-uses the other visits (${patchMs.toFixed(0)} ms < 150 ms)`, patchMs < 150);
  ok('B3 untouched visits keep their candidate objects', after[0] === built[0] && after[after.length - 1] === built[built.length - 1]);
  ok('B3 the changed visit says its new status', after.find((c) => c.refId === jobs[777].id).sublabel.endsWith(JOB_STATUS_LABELS.done));

  // B4 the shared record is adopted (every customer, location and service is a NEW object, same values)
  const adopted = JSON.parse(JSON.stringify({ clients, sites, services }));
  t = performance.now();
  const adoptedOut = candidatesFor(source, patched, { jobs: patched, ...adopted }, 4, NOW);
  const adoptMs = performance.now() - t;
  console.log(`  B4 an adoption: ${adoptMs.toFixed(1)} ms`);
  ok(`B4 an adoption with the same names rebuilds nothing (${adoptMs.toFixed(0)} ms < 150 ms)`, adoptMs < 150 && adoptedOut[0] === after[0]);

  // B5 a customer is renamed: only that customer's visits change
  const renamed = { ...adopted, clients: adopted.clients.map((c) => (c.id === 'cl3' ? { ...c, name: 'Renamed Towers' } : c)) };
  const renamedOut = candidatesFor(source, patched, { jobs: patched, ...renamed }, 4, NOW);
  const cl3 = renamedOut.filter((c) => c.refId && patched.find((x) => x.id === c.refId)?.clientId === 'cl3');
  ok('B5 a renamed customer\'s visits read the new name', cl3.length > 0 && cl3.every((c) => c.label === 'Renamed Towers'));
  ok('B5 everyone else\'s visits are untouched objects', renamedOut[0] === adoptedOut[0]);

  // B6 a key at Matt's size stays well under the old 7 s freeze once built. 400 ms, not a frame:
  // the suite runs beside the responsive sweep in the ladder and on CI's slower runners, where a
  // 100 ms bound failed under load at 167 ms (S128 round 2) while the regression it guards is 7,300 ms.
  t = performance.now();
  const ranked = rankEntries(renamedOut, 'harbor towers 1');
  const keyMs = performance.now() - t;
  console.log(`  B6 a later key ranks ${renamedOut.length} candidates in ${keyMs.toFixed(0)} ms`);
  ok(`B6 a later key ranks in < 400 ms (${keyMs.toFixed(0)} ms)`, keyMs < 400 && ranked.length > 0);

  // B7 the window: past visits within SEARCH_PAST_DAYS, every future visit, an undated one
  const at = (days) => new Date(NOW + days * DAY).toISOString();
  const edge = [
    { id: 'old', clientId: 'cl1', siteId: 'st1', serviceId: 'sv1', status: 'done', startAt: at(-(jr.SEARCH_PAST_DAYS + 1)) },
    { id: 'recent', clientId: 'cl1', siteId: 'st1', serviceId: 'sv1', status: 'done', startAt: at(-(jr.SEARCH_PAST_DAYS - 1)) },
    { id: 'future', clientId: 'cl1', siteId: 'st1', serviceId: 'sv1', status: 'upcoming', startAt: at(400) },
    { id: 'undated', clientId: 'cl1', siteId: 'st1', serviceId: 'sv1', status: 'upcoming' },
  ];
  const win = candidatesFor(source, edge, { ...state, jobs: edge }, 4, NOW).map((c) => c.refId);
  ok(`B7 visits older than ${jr.SEARCH_PAST_DAYS} days are not searched; recent, future and undated ones are (${win.join(',')})`,
    !win.includes('old') && win.includes('recent') && win.includes('future') && win.includes('undated'));

  // B8 the display language moves the dates
  setUiLocale('es-US');
  const es = candidatesFor(source, edge, { ...state, jobs: edge }, 4, NOW).find((c) => c.refId === 'future');
  ok('B8 a Spanish reader gets Spanish dates', es && es.sublabel.startsWith(fmtDate(edge[2].startAt, { weekday: 'short', month: 'short', day: 'numeric' })) && /[a-záéíóú]/.test(es.sublabel));
  setUiLocale(undefined);
}

// ── C. lockstep: sources.js wires the real visit source, crew-scoped by the page's own selector ──
{
  const src = readFileSync(new URL('../src/lib/masterSearch/sources.js', import.meta.url), 'utf8');
  ok('C the cleans source is the visit source module', /makeJobSource\(\{/.test(src) && /from '\.\/jobRecords\.js'/.test(src));
  ok('C crew are scoped by the Schedule\'s own selector', /makeJobSource\(\{[\s\S]{0,300}crew[\s\S]{0,80}selectJobsForUser\(s, user\.id\)/.test(src));
  ok('C the effective status is the store\'s', /makeJobSource\(\{[\s\S]{0,400}effectiveStatus: selectEffectiveJobStatus/.test(src));
  const collect = readFileSync(new URL('../src/lib/masterSearch/collect.js', import.meta.url), 'utf8');
  ok('C no spread of a whole candidate list into push()', !/\.push\(\.\.\.candidatesFor/.test(collect));
}

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\nmaster-search speed: ${pass}/${pass} passed`);
}
