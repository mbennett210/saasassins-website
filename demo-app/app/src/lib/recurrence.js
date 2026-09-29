// Explicit .js extension (not the extensionless style used elsewhere in lib/): this
// module is loaded by scripts/test-recurrence-tz.mjs under raw Node ESM, which does
// not do Vite's extension resolution. Dropping it builds fine and breaks the test.
import { dayKey, dayOfWeekIso, dayOfWeekKey, splitIso, composeIso, addDaysKey } from './dates.js';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_INSTANCES = 52;     // hard cap for count-based series ("after N times")
const MAX_GENERATED = 1000;   // safety ceiling for date/never (rolling) series
// How far ahead never-ending series materialize BY DEFAULT. Was 365 — which put
// 19,325 rows in public.jobs (145 series × ~133 occurrences), 74% of them beyond
// 90 days and never painted: a 36 MB boot, a 120 MB table, and a ~133-row blast
// radius on every whole-series edit. 90 keeps a full quarter materialized;
// browsing the calendar past it materializes further ON DEMAND — Schedule
// dispatches TOP_UP_RECURRING_SERIES with `untilMs` covering the viewed range
// (see expandRecurrence's `until`), so nothing the user can navigate to is ever
// missing, it just isn't pre-built a year out for nobody.
export const HORIZON_DAYS = 90;

export const RECURRENCE_DEFAULTS = {
  daily:    { endCount: 30 },
  weekly:   { endCount: 12 },
  biweekly: { endCount: 6 },
  monthly:  { endCount: 3 },
};

// ── Per-day variation (schedule blocks) ─────────────────────────────────────
// A weekly recurrence may carry `dayOverrides`: a sparse map keyed by day-of-week
// whose entries override the series defaults for that day:
//   dayOverrides: { 6: { startTime: '08:00', endTime: '11:00', crewIds: ['u-…'] } }
// Days WITHOUT an entry inherit the master job's times + crew (the "default
// block"). The New Job schedule-blocks editor writes a FULL entry (times + crew)
// for every day living outside the master's block, so resolution never has to
// merge partial fields — but readers stay defensive about partial entries anyway.
// `timeOverride: { startTime, endTime }` is the series-level analog for
// non-weekly frequencies: set when a series' times are edited after creation
// (the master job is history and keeps its original times, so expansion can't
// keep deriving times from master.startAt). `crewOverride: [userId…]` is its crew
// twin (2026-09-23): set when a series' regular crew is edited after creation, and
// pinned when the master's OWN visit gets a one-off crew, so one visit's crew never
// decides who every future visit gets. All three keys are additive + optional —
// pre-existing series simply don't have them.

const pad2 = (n) => String(n).padStart(2, '0');

function fmtHm(hm) {
  const [h, m] = hm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ap}`;
}

// Crew for one occurrence of a series: the day's override crew if that day has
// one, else the series default (the master job's crewIds). Single source of
// truth for ADD_JOB_SERIES and TOP_UP_RECURRING_SERIES — if these two ever
// resolve differently, topped-up occurrences silently flip crews.
// The day-of-week is resolved in the ORG's zone. Reading it device-local meant a
// Friday series booked from Manila resolved to Thursday on a Seattle screen, missed
// dayOverrides[dow], and silently handed the occurrence the wrong crew.
export function crewForOccurrence(recurrence, startAt, defaultCrewIds) {
  const entry = recurrence?.dayOverrides?.[dayOfWeekIso(startAt)];
  return entry && Array.isArray(entry.crewIds) ? entry.crewIds : seriesDefaultCrew(recurrence, defaultCrewIds);
}

// The series' regular crew for a day with no override: the series-level crewOverride
// when one is set, else the master job's own crew.
export function seriesDefaultCrew(recurrence, masterCrewIds) {
  return Array.isArray(recurrence?.crewOverride) ? recurrence.crewOverride : (masterCrewIds || []);
}

// ONE weekday's regular values in a series: its day override, else the series-level
// overrides (timeOverride / crewOverride), else the master job's own values. The single
// resolution behind seriesBlocksOf, UPDATE_JOB_SERIES' dense freeze, and its one-off
// check, so none of them can disagree about what a day normally runs at, or with whom.
// Pass the MASTER JOB (or a master-shaped { startAt, endAt, crewIds, recurrence }).
export function dayPatternOf(master, dow) {
  const r = master?.recurrence || {};
  const o = r.dayOverrides?.[dow];
  return {
    startTime: o?.startTime || r.timeOverride?.startTime || splitIso(master.startAt).time,
    endTime: o?.endTime || r.timeOverride?.endTime || splitIso(master.endAt || master.startAt).time,
    crewIds: Array.isArray(o?.crewIds) ? o.crewIds : seriesDefaultCrew(r, master.crewIds),
  };
}

// The rolling cutoff for never-ending series: today + HORIZON_DAYS. Because it's
// computed from "now", each top-up pass (see the TOP_UP_RECURRING_SERIES reducer)
// extends the series another step into the future — so "Never" is effectively
// perpetual rather than a fixed batch.
export function recurrenceHorizon(now = Date.now()) {
  return new Date(now + HORIZON_DAYS * 86400000);
}

// Expand a recurrence into concrete occurrences AFTER the base start (the base
// occurrence itself is the master job). For endType:
//   'count' → exactly N (capped at 52)
//   'date'  → up to the end date (capped at MAX_GENERATED)
//   'never' → up to the rolling horizon (today + HORIZON_DAYS), capped at
//             MAX_GENERATED. `until` (ms) EXTENDS that cutoff when it is later —
//             the extend-on-navigate path, so browsing the calendar past the
//             default horizon materializes what the view needs. It can only ever
//             widen the window, never narrow it below the default.
export function expandRecurrence({ startAt, endAt, recurrence, now = Date.now(), until = null }) {
  if (!recurrence || !recurrence.frequency) return [];
  const { frequency, daysOfWeek, endType, endCount, endDate, dayOverrides, timeOverride } = recurrence;

  // The master's anchor, read in the ORG's zone: the calendar day it lands on and
  // the wall clock the site sees. Occurrences are REBUILT from that day + time
  // rather than stepped as instants, which is what keeps a 9:00 AM series at 9:00 AM
  // across a DST change — and makes the expansion identical whether the Manila VA or
  // the Seattle admin triggers it. (Stepping instants with setDate/setHours read the
  // device's calendar, so the same series expanded onto different days per user.)
  const baseKey = dayKey(startAt);
  let baseTime = splitIso(startAt).time;
  let baseMs = new Date(startAt).getTime();
  let duration = new Date(endAt).getTime() - baseMs;

  // Series-level time override (post-creation series time edit) — rebase the
  // default times off the master's original ones.
  if (timeOverride?.startTime) {
    baseTime = timeOverride.startTime;
    baseMs = new Date(composeIso(baseKey, baseTime)).getTime();
    if (timeOverride.endTime) {
      duration = new Date(composeIso(baseKey, timeOverride.endTime)).getTime() - baseMs;
    }
  }
  // Legacy masters written before the overnight-rollover fix carry an inverted
  // (endAt < startAt) pair; normalize the derived duration so expansions from
  // them come out positive instead of propagating the inversion.
  if (duration <= 0) duration += 86400000;

  const limit = endType === 'count'
    ? Math.min(Math.max(Number(endCount) || 12, 1), MAX_INSTANCES)
    : MAX_GENERATED;
  const cutoffMs = endType === 'date' && endDate ? new Date(endDate).getTime()
    : endType === 'never' ? Math.max(recurrenceHorizon(now).getTime(), Number(until) || 0)
    : null;

  const results = [];
  const msAt = (key, time) => new Date(composeIso(key, time)).getTime();
  const push = (key, time, endTime) => {
    const s = msAt(key, time);
    // Overnight rollover: an explicit end wall-clock at or before the start
    // means the shift crosses midnight — end lands on the NEXT day. Composing
    // both onto the same key stored endAt < startAt (inverted conflict math,
    // zero durations) for every overnight clean. The duration path is already
    // correct (duration is measured between real instants).
    let e = endTime ? msAt(key, endTime) : s + duration;
    if (endTime && e <= s) e = msAt(addDaysKey(key, 1), endTime);
    results.push({ startAt: new Date(s).toISOString(), endAt: new Date(e).toISOString() });
  };

  if (frequency === 'weekly' && daysOfWeek?.length) {
    const sorted = [...daysOfWeek].sort((a, b) => a - b);
    let weekStartKey = addDaysKey(baseKey, -dayOfWeekKey(baseKey)); // Sunday-anchored
    while (results.length < limit) {
      let anyThisWeek = false;
      for (const dow of sorted) {
        const ovr = dayOverrides ? dayOverrides[dow] : null;
        const key = addDaysKey(weekStartKey, dow);
        // Overridden days run at their own time; inherited days at the base time.
        const time = ovr?.startTime || baseTime;
        const ms = msAt(key, time);
        if (ms <= baseMs) continue;
        if (cutoffMs != null && ms > cutoffMs) return results;
        if (results.length >= limit) return results;
        push(key, time, ovr?.endTime);
        anyThisWeek = true;
      }
      weekStartKey = addDaysKey(weekStartKey, 7);
      // Stop once the whole week sits past the cutoff and produced nothing.
      if (cutoffMs != null && msAt(weekStartKey, baseTime) > cutoffMs && !anyThisWeek) break;
    }
    return results;
  }

  if (frequency === 'monthly') {
    const [baseYear, baseMonth, baseDay] = baseKey.split('-').map(Number);
    for (let i = 1; results.length < limit; i++) {
      // Step whole months on the calendar, then clamp into the target month. Date's
      // setMonth() overflows instead of clamping (Jan 31 + 1mo lands in March), so a
      // series anchored on the 31st used to skip February outright.
      const total = baseYear * 12 + (baseMonth - 1) + i;
      const y = Math.floor(total / 12);
      const m = (total % 12) + 1;
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const key = `${y}-${pad2(m)}-${pad2(Math.min(baseDay, lastDay))}`;
      if (cutoffMs != null && msAt(key, baseTime) > cutoffMs) break;
      push(key, baseTime);
    }
    return results;
  }

  // daily / weekly (no specific days) / biweekly — fixed stride from the base.
  const stride = frequency === 'daily' ? 1 : frequency === 'biweekly' ? 14 : 7;
  let cursorKey = baseKey;
  while (results.length < limit) {
    cursorKey = addDaysKey(cursorKey, stride);
    if (cutoffMs != null && msAt(cursorKey, baseTime) > cutoffMs) break;
    push(cursorKey, baseTime);
  }
  return results;
}

export function isOngoing(recurrence) {
  return !!recurrence && recurrence.endType === 'never';
}

// Short day list for a block, e.g. [1,5] → "Mon, Fri".
export function blockDayLabel(days) {
  return [...(days || [])].sort((a, z) => a - z).map((d) => DAY_NAMES[d]).join(', ');
}

// "1:00 AM–2:00 AM" for a block's own window.
export function blockTimeLabel(block) {
  if (!block?.startTime || !block?.endTime) return '';
  return `${fmtHm(block.startTime)}–${fmtHm(block.endTime)}`;
}

// ── The series' schedule blocks, reconstructed ───────────────────────────────
// The inverse of what the blocks editor wrote at creation: resolve every
// scheduled day's EFFECTIVE time + crew, then group days that share settings.
//
// 🔴 A DAY WITHOUT A dayOverrides ENTRY IS NOT "UNSET" — it is the DEFAULT block,
// and it runs on the master's times + crew. Readers that walk `dayOverrides` alone
// see only the days that differ FROM the default and never name the default block
// at all. That asymmetry is what shipped: a Wed 10:00 + Mon/Fri 1:00 series whose
// anchor landed on a Monday stored overrides for Wed ONLY, so every series-level
// surface read "Weekly on Mon, Wed, Fri · Wed 10:00 AM–11:30 AM" — the 1:00 AM
// block, which owns two of the three days, was invisible. Opening a Monday
// occurrence, the only time named anywhere on the page was the one it does NOT
// run at. Always reconstruct through here; never iterate dayOverrides directly.
//
// `timeOverride` (and `crewOverride`) are honored for the default block for the same
// reason expandRecurrence honors them: after a series-level edit the master job keeps
// its original values (it's history), so it no longer says what the default days
// actually run at, or with whom. Resolution is dayPatternOf's.
// Pass the MASTER JOB (it supplies the default times + crew). Crew is resolved
// BEFORE grouping, so a day whose override happens to name the same crew as the
// default merges into one block instead of showing as a spurious second one.
export function seriesBlocksOf(master) {
  const recurrence = master?.recurrence;
  if (!recurrence || recurrence.frequency !== 'weekly' || !master?.startAt) return null;
  const days = recurrence.daysOfWeek?.length ? recurrence.daysOfWeek : [dayOfWeekIso(master.startAt)];
  const blocks = [];
  for (const dow of [...days].map(Number).sort((a, z) => a - z)) {
    const { startTime, endTime, crewIds } = dayPatternOf(master, dow);
    const sig = `${startTime}|${endTime}|${[...crewIds].sort().join(',')}`;
    const hit = blocks.find((b) => b.sig === sig);
    if (hit) hit.days.push(dow);
    else blocks.push({ key: blocks.length + 1, sig, days: [dow], startTime, endTime, crewIds });
  }
  return blocks.map(({ sig, ...b }) => b);
}

// The block editor's save as the SPARSE change it is (2026-09-23): `days` is the complete
// new day set (UPDATE_JOB_SERIES adds and drops days from it), but `overrides` carries,
// per day, only what the user changed against the blocks the editor OPENED with: times
// when a day's times moved, crew when its crew changed, both for a day newly added. It
// used to send every day's crew and times on every save, which re-crewed and re-timed
// every future visit, so a notes-only edit wiped one-off covers and one-off times.
// `openingBlocks` must be the editor's mount-time snapshot, never the live series: a
// value that moved underneath a stale draft would otherwise read as the user's edit.
// `full` carries every day's values as the editor shows them; the reducer uses it only
// for a day the live series doesn't run on (e.g. another user removed it while this
// editor was open), so a re-added day gets what the editor showed, not the defaults.
export function dayPlanFromBlocks(blocks, openingBlocks) {
  const was = {};
  for (const b of openingBlocks || []) for (const dow of b.days) was[dow] = b;
  const sameCrew = (a, z) => [...(a || [])].sort().join(',') === [...(z || [])].sort().join(',');
  const days = [];
  const overrides = {};
  const full = {};
  for (const b of blocks || []) {
    for (const dow of b.days) {
      days.push(dow);
      full[dow] = { startTime: b.startTime, endTime: b.endTime, crewIds: [...(b.crewIds || [])] };
      const before = was[dow];
      const o = {};
      if (!before || b.startTime !== before.startTime || b.endTime !== before.endTime) {
        o.startTime = b.startTime;
        o.endTime = b.endTime;
      }
      if (!before || !sameCrew(b.crewIds, before.crewIds)) o.crewIds = [...(b.crewIds || [])];
      if (Object.keys(o).length) overrides[dow] = o;
    }
  }
  return { days, overrides, full };
}

// `describeRecurrence(recurrence)` still works for callers with no master in hand
// (they get the frequency + end rule and a best-effort per-day tail). Pass the
// master job as the 2nd arg to get the COMPLETE breakdown — every block named,
// the default one included. Crew is left to callers who can resolve user names.
export function describeRecurrence(recurrence, master = null) {
  if (!recurrence) return '';
  const { frequency, daysOfWeek, endType, endCount, endDate, dayOverrides } = recurrence;
  const freqLabel = frequency === 'biweekly' ? 'Every 2 weeks'
    : frequency.charAt(0).toUpperCase() + frequency.slice(1);

  let desc = freqLabel;
  if (frequency === 'weekly' && daysOfWeek?.length) {
    desc += ' on ' + daysOfWeek.map((d) => DAY_NAMES[d]).join(', ');
  }

  if (endType === 'count') desc += ` (${endCount} times)`;
  else if (endType === 'date' && endDate) {
    desc += ` until ${new Date(endDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  } else if (endType === 'never') desc += '. Ongoing';

  // With the master in hand, name EVERY block (see seriesBlocksOf) — but only
  // when the days genuinely differ, so a uniform series doesn't repeat itself.
  const blocks = master ? seriesBlocksOf({ ...master, recurrence }) : null;
  if (blocks && blocks.length > 1) {
    desc += ` · ${blocks.map((b) => `${blockDayLabel(b.days)} ${blockTimeLabel(b)}`).join(' · ')}`;
    return desc;
  }
  if (blocks) return desc; // single uniform block — the header already shows its time

  // No master available: fall back to the override-only tail. Incomplete by
  // nature (the default block can't be resolved without the master), so it is
  // the LAST resort, never the primary path.
  if (frequency === 'weekly' && dayOverrides && Object.keys(dayOverrides).length) {
    const parts = Object.keys(dayOverrides).map(Number).sort((a, b) => a - b).map((d) => {
      const o = dayOverrides[d] || {};
      return o.startTime && o.endTime ? `${DAY_NAMES[d]} ${fmtHm(o.startTime)}–${fmtHm(o.endTime)}` : DAY_NAMES[d];
    });
    desc += ` · ${parts.join(', ')}`;
  }
  return desc;
}

// Used by the create form for a human summary of what will be scheduled. For
// never-ending series there is no final date, so `ongoing` is true and `count`
// reflects only what's materialized through the current horizon.
export function previewEndDate({ startAt, recurrence }) {
  const instances = expandRecurrence({ startAt, endAt: startAt, recurrence });
  if (instances.length === 0) return null;
  return {
    count: instances.length + 1,
    lastDate: instances[instances.length - 1].startAt,
    ongoing: isOngoing(recurrence),
  };
}
