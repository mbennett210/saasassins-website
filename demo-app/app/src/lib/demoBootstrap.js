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
import { clearState } from '../store/persist';
import { STUB_KEY } from './timeApi';
import { GATE_MEMO_KEY } from './checklistGateMemo';
import { buildDemoLedgerEntries } from '../data/demoTimeLedger';
import { MEDIA_STUB_KEY, buildDemoSiteMedia } from '../data/demoSiteMedia';
import { buildDemoStubs, DEMO_STUB_KEYS } from '../data/demoStubs';
import { RETIRED_STUB_KEYS } from '../data/stubKeys';
import { refreshLedgerEntries, missingStubKeys } from './demoSandbox';
import { RECENTS_KEY_PREFIX } from './masterSearch/recents';

// One-time seed marker: present once the sandbox has been seeded. Its value is
// informational (the seed build that first populated this browser); the seed
// runs on the marker's ABSENCE, not on a date or version, so a returning viewer
// is never re-wiped. Bumping this no longer forces a reseed, by design: the
// client's data persists. Use ?demo=reset for a deliberate full refresh.
const SEED_VERSION = '2026-09-13b';
const MARKER_KEY = 'cs.demo.seededOn';

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

  const writeLedger = () => {
    try {
      ls.setItem(STUB_KEY, JSON.stringify({ entries: buildDemoLedgerEntries(new Date()) }));
    } catch { /* quota / private mode, non-fatal: the report just opens empty */ }
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
  // ledger is treated as a full (re)seed.
  const refreshLedgerStory = () => {
    try {
      const raw = ls.getItem(STUB_KEY);
      if (raw == null) { writeLedger(); return; }
      const db = JSON.parse(raw) || {};
      const next = refreshLedgerEntries(db.entries, buildDemoLedgerEntries(new Date()));
      if (next.changed) ls.setItem(STUB_KEY, JSON.stringify({ ...db, entries: next.entries }));
    } catch { /* corrupt / quota — leave whatever is there, non-fatal */ }
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
  refreshLedgerStory();
  let hasMedia = false;
  try { hasMedia = ls.getItem(MEDIA_STUB_KEY) != null; } catch { /* ignore */ }
  if (!hasMedia) writeMedia();
  backfillMissingStubs();
}

export default ensureDemoData;
