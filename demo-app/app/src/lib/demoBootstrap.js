// Client sandbox first-load bootstrap. This portal runs the localStorage STUB
// backends (no Supabase configured): the time-clock ledger + Variance read from
// timeApi.js STUB_KEY, the Sites-tab photo gallery reads the account-media stub
// (data/demoSiteMedia.js), and Forms / Quotes / Quality read their own stub keys.
// `ensureDemoData()` seeds all of them ONCE on the very first load so those
// surfaces open populated instead of blank.
//
// This is a persistent client sandbox, NOT a resetting demo: once seeded, the
// data (and anything the client changes while experimenting) PERSISTS across
// days and across deploys. It is never auto-wiped. A full reset back to the
// fresh seed is available on demand via ?demo=reset.
//
// Called from main.jsx BEFORE React renders and ONLY when Supabase auth is not
// configured (isAuthConfigured() false), so touching localStorage + new Date()
// here is fine and can never clobber a real, authenticated deployment's data.
//
// THE MANAGER'S DAY (data/demoManagerDay.js) is placed here too, around `now`: today's visits go
// into the store's own saved blob (before the store reads it), their punches into the ledger and
// their checklist saves, the customer's requests and the supply rows into their stubs. It is
// placed on the first load and on ?demo=reset, and again on a later load once the day it placed
// is over two hours old or from yesterday (lib/demoSandbox managerDayStale) — so the board reads
// true at whatever hour the demo is opened. Only the rows the plan owns (by id) are replaced.
import { clearState, loadState, saveState } from '../store/persist';
import { INITIAL_STATE } from '../data/seed';
import { STUB_KEY, OT_STUB_KEY, RUNS_STUB_KEY } from './timeApi';
import { GATE_MEMO_KEY } from './checklistGateMemo';
import { buildDemoLedgerEntries } from '../data/demoTimeLedger';
import { MEDIA_STUB_KEY, buildDemoSiteMedia, HUB_DEMO_CORAL_BAY_VISIT, HUB_DEMO_FLAGLER_VISIT } from '../data/demoSiteMedia';
import { buildDemoStubs, buildManagerDayStubs, seededClosedTickets, DEMO_STUB_KEYS } from '../data/demoStubs';
import {
  RETIRED_STUB_KEYS, QC_TEMPLATES_STUB_KEY, QC_CHECKLISTS_STUB_KEY, QC_PROBLEMS_STUB_KEY, SUPPLIES_STUB_KEY,
  CLIENT_MESSAGES_STUB_KEY,
} from '../data/stubKeys';
import {
  buildManagerDay, MANAGER_DAY_JOB_IDS, MANAGER_DAY_TIME_OFF_IDS, MANAGER_DAY_PREFIX, ownsId, MANAGER_DAY_DAILY_SUPPLY_IDS,
} from '../data/demoManagerDay';
import {
  refreshLedgerEntries, missingStubKeys, managerDayStale, replaceOwned, addMissing, placeManagerDayInState,
  moveOwnedRows, replaceClosedRows, placeManagerDaySupplies, rekeyRefs,
} from './demoSandbox';
import { dayKey, DEFAULT_ORG_TIMEZONE } from './dates';
import { RECENTS_KEY_PREFIX } from './masterSearch/recents';

// One-time seed marker: present once the sandbox has been seeded. Its value is
// informational (the seed build that first populated this browser); the seed
// runs on the marker's ABSENCE, not on a date or version, so a returning viewer
// is never re-wiped. Bumping this no longer forces a reseed, by design: the
// client's data persists. Use ?demo=reset for a deliberate full refresh.
const SEED_VERSION = '2026-09-13b';
const MARKER_KEY = 'cs.demo.seededOn';
// When the manager's day was last placed: { at: ms, day: org day key }.
const MANAGER_DAY_KEY = 'cs.demo.managerDay';
// The visit ids the client hub's demo photos were filed under before those visits joined the
// manager's day (data/demoSiteMedia.js) — re-filed in a browser seeded before.
const LEGACY_VISIT_REFS = Object.freeze({ j_demo_22: HUB_DEMO_CORAL_BAY_VISIT, j_hubdemo_flagler: HUB_DEMO_FLAGLER_VISIT });
const isDayEntry = ownsId(MANAGER_DAY_PREFIX.entry);

// Idempotent: safe to call on every boot. Writes the fresh ledger under STUB_KEY
// as `{ entries: [...] }`, the exact envelope timeApi.loadStub() reads.
export function ensureDemoData() {
  let ls;
  try {
    if (typeof window === 'undefined') return;
    ls = window.localStorage;
    if (!ls) return;
  } catch {
    return; // localStorage unavailable (private mode / disabled): nothing to seed.
  }

  // A stub whose ROW SHAPE changed moves to a new key (data/stubKeys.js), so the
  // write-if-absent backfill below reseeds it. Clear the retired key on every load or the
  // old rows sit in the browser for ever — harmless but confusing in a support read.
  RETIRED_STUB_KEYS.forEach((key) => { try { ls.removeItem(key); } catch { /* ignore */ } });

  const search = (typeof window !== 'undefined' && window.location && window.location.search) || '';
  const forceReset = search.includes('demo=reset');
  let marker = null;
  try { marker = ls.getItem(MARKER_KEY); } catch { /* ignore */ }

  // The org's zone and pay week, as the store holds them (the seed's on a first load).
  const now = new Date();
  let saved = null;
  try { saved = loadState(); } catch { saved = null; }
  const org = (saved && saved.company) ? saved : INITIAL_STATE;
  const tz = org.company?.timezone || DEFAULT_ORG_TIMEZONE;
  const weekStartDay = Number.isInteger(org.opsSettings?.payWeekStartDay) ? org.opsSettings.payWeekStartDay : 0;
  const day = buildManagerDay(now, { tz, weekStartDay });
  let anchor = null;
  try { anchor = JSON.parse(ls.getItem(MANAGER_DAY_KEY)); } catch { anchor = null; }

  const writeLedger = () => {
    try {
      ls.setItem(STUB_KEY, JSON.stringify({ entries: buildDemoLedgerEntries(now, day) }));
    } catch { /* quota / private mode, non-fatal: the report just opens empty */ }
  };
  // Rewrite one stub through `fn`; an absent or unreadable stub is left alone.
  const patchStub = (key, fn) => {
    try {
      const raw = ls.getItem(key);
      if (raw == null) return;
      const next = fn(JSON.parse(raw) || {});
      if (next) ls.setItem(key, JSON.stringify(next));
    } catch { /* corrupt / quota — non-fatal */ }
  };
  // Place the manager's day everywhere but the ledger (which the callers write): the store's saved
  // blob — written BEFORE the store reads it — and the four stubs. `prev` is the last placing, so a
  // customer's request moves by the time since then and keeps the replies the viewer added.
  const placeManagerDay = (prev) => {
    try {
      saveState(placeManagerDayInState(loadState() || INITIAL_STATE, day, {
        jobIds: MANAGER_DAY_JOB_IDS, timeOffIds: MANAGER_DAY_TIME_OFF_IDS,
      }));
    } catch { /* quota / private mode, non-fatal: the board shows the seed's own jobs */ }
    const md = buildManagerDayStubs(day);
    const delta = prev && Number.isFinite(prev.at) ? day.nowMs - prev.at : 0;
    patchStub(QC_TEMPLATES_STUB_KEY, (db) => ({ ...db, templates: addMissing(db.templates, md.templates) }));
    patchStub(QC_CHECKLISTS_STUB_KEY, (db) => ({ ...db, checklists: replaceOwned(db.checklists, md.checklists, ownsId(MANAGER_DAY_PREFIX.checklist)) }));
    // The day's requests move by the time since the last placing; the seeded book's closed tickets
    // are re-placed relative to now, so the hub's time to resolve and Reports never age them out.
    patchStub(QC_PROBLEMS_STUB_KEY, (db) => ({
      ...db,
      problems: moveOwnedRows(replaceClosedRows(db.problems, seededClosedTickets(day.nowMs)), md.problems, delta),
    }));
    patchStub(CLIENT_MESSAGES_STUB_KEY, (db) => ({ ...db, messages: moveOwnedRows(db.messages, md.messages, delta) }));
    // The delivery step's "on the way" and "delivered today" are re-placed with the day.
    patchStub(SUPPLIES_STUB_KEY, (db) => placeManagerDaySupplies(db, md, day.monthStartMs, { replaceIds: MANAGER_DAY_DAILY_SUPPLY_IDS }));
    patchStub(MEDIA_STUB_KEY, (db) => {
      const media = rekeyRefs(db.media, LEGACY_VISIT_REFS);
      return media === db.media ? null : { ...db, media };
    });
    try { ls.setItem(MANAGER_DAY_KEY, JSON.stringify({ at: day.nowMs, day: day.dayKey })); } catch { /* ignore */ }
  };
  const writeMedia = () => {
    try {
      ls.setItem(MEDIA_STUB_KEY, JSON.stringify(buildDemoSiteMedia()));
    } catch { /* quota / private mode, non-fatal: sites just show 0 photos */ }
  };
  // Rebuild the demo TIME-LEDGER story relative to now when it has aged out of the
  // current pay period, so Payroll stops reading $0.00 / 0 hours and Variance's
  // rolling windows repopulate. Only the synthetic te_demo_* rows are replaced; a
  // punch the client made while exploring is preserved (lib/demoSandbox). A missing
  // ledger is treated as a full (re)seed. TODAY's rows (the manager's day) are re-placed
  // on their own clock (`placeDay`), and always with the story. → whether the day moved.
  const refreshLedgerStory = (placeDay) => {
    try {
      const raw = ls.getItem(STUB_KEY);
      if (raw == null) { writeLedger(); return true; }
      const db = JSON.parse(raw) || {};
      const fresh = buildDemoLedgerEntries(now, day);
      const next = refreshLedgerEntries(db.entries, fresh, now.getTime(), undefined, isDayEntry);
      if (next.changed) { ls.setItem(STUB_KEY, JSON.stringify({ ...db, entries: next.entries })); return true; }
      if (!placeDay) return false;
      ls.setItem(STUB_KEY, JSON.stringify({ ...db, entries: replaceOwned(db.entries, fresh.filter(isDayEntry), isDayEntry) }));
      return true;
    } catch { return false; /* corrupt / quota — leave whatever is there, non-fatal */ }
  };
  // Write any Forms / Quotes / Quality stub that is ABSENT — a browser first seeded
  // before those stubs shipped opens Inspections/Checklists empty. Write-if-absent
  // only, so a present stub (which may hold the client's own QC edits) is untouched.
  const backfillMissingStubs = () => {
    try {
      const stubs = buildDemoStubs();
      for (const key of missingStubKeys(Object.keys(stubs), (k) => ls.getItem(k) != null)) {
        ls.setItem(key, JSON.stringify(stubs[key]));
      }
    } catch { /* quota / private mode, non-fatal */ }
  };

  // First load ever (no marker) OR an explicit ?demo=reset wipes + seeds fresh.
  // On every later load the marker is present and we fall through, leaving the
  // client's data exactly as they left it (no daily or versioned reset).
  if (forceReset || !marker) {
    // Wipe EVERY versioned store key, not just the current one. clearState() clears
    // only STORAGE_KEY; an older `pp.store.v*` blob left behind (e.g. pp.store.v50 from
    // a prior version) is otherwise resurrected by persist's previous-key fallback
    // readers, so the seed silently shows stale data instead of the fresh seed.
    try {
      Object.keys(ls).forEach((k) => { if (k.startsWith('pp.store.')) ls.removeItem(k); });
    } catch { try { clearState(); } catch { /* ignore */ } }
    try { ls.removeItem(STUB_KEY); } catch { /* ignore */ }
    try { ls.removeItem(OT_STUB_KEY); } catch { /* ignore */ } // manager-approved OT (W1-B)
    try { ls.removeItem(RUNS_STUB_KEY); } catch { /* ignore */ } // closed payroll runs (W2-L)
    try { ls.removeItem(MEDIA_STUB_KEY); } catch { /* ignore */ }
    // The clock-out gate's remembered verdicts (lib/checklistGateMemo) name cleans and
    // cleaners from the OLD seed — left behind, a reset phone would still read a checklist
    // as finished on a clean that no longer exists.
    try { ls.removeItem(GATE_MEMO_KEY); } catch { /* ignore */ }
    // Forms / Quotes / Quality run off their OWN stub keys (not the pp-store).
    DEMO_STUB_KEYS.forEach((key) => { try { ls.removeItem(key); } catch { /* ignore */ } });
    // Master-search recents are per-user localStorage (cs.msearch.recents.<userId>), not a
    // seeded stub — wipe them by prefix so a reset starts with no recent searches.
    try { Object.keys(ls).forEach((k) => { if (k.startsWith(RECENTS_KEY_PREFIX)) ls.removeItem(k); }); } catch { /* ignore */ }
    writeLedger();
    writeMedia();
    try {
      const stubs = buildDemoStubs();
      for (const [key, value] of Object.entries(stubs)) ls.setItem(key, JSON.stringify(value));
    } catch { /* quota / private mode, non-fatal */ }
    placeManagerDay(null);
    try { ls.setItem(MARKER_KEY, SEED_VERSION); } catch { /* ignore */ }
    return;
  }

  // Already seeded: never wipe the client's data. Because the seed runs on
  // marker-ABSENCE, a browser seeded under an older build otherwise never receives
  // anything added since its first load. Two backfills keep it current:
  //   1. Refresh the time-ledger story if it aged out of the current pay period
  //      (fixes Payroll $0.00 / 0 hours and empty Variance), preserving client punches.
  //   2. Write any QC / forms / quotes stub that is missing (fixes empty
  //      Inspections / Checklists), never overwriting a present one.
  //   3. Place the manager's day again once the last placing is two hours old or yesterday's
  //      (or the ledger story was rebuilt, which re-placed today's punches with it).
  const stale = managerDayStale(anchor, now.getTime(), dayKey(now, tz));
  const ledgerMoved = refreshLedgerStory(stale);
  let hasMedia = false;
  try { hasMedia = ls.getItem(MEDIA_STUB_KEY) != null; } catch { /* ignore */ }
  if (!hasMedia) writeMedia();
  backfillMissingStubs();
  if (stale || ledgerMoved) placeManagerDay(anchor);
}

export default ensureDemoData;
