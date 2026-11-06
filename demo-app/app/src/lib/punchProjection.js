// The phone's copy of the cleaner's OWN punches, as the server last answered (CS-666).
//
// `timeApi.mine()` reads the cleaner's punches from the server. With no signal it used to
// merge the phone's buffered punches into an EMPTY list — so a punch made online vanished
// offline: the card offered "Clock in" again, "On the clock" disappeared, and a buffered
// clock-out had no row to close (`timeMerge` patches only rows that are present). Now every
// full online read is kept here, and an offline read starts from it: an open punch stays
// open, a buffered clock-out folds into it and reads "clocked out · will sync".
//
// What is kept, and for how long:
//   · ONE cleaner at a time (the one signed in on this phone); a read for anyone else gets
//     nothing, and sign-out clears it (AuthProvider), as it clears the clock-out gate memo;
//   · the raw GPS point is NEVER kept (PAY-20, `clockRules.GPS_POINT_COLUMNS`): the server
//     keeps it 90 days and nothing on a phone may outlive that; the verdict and the distance
//     the card reads are kept;
//   · bounded at the write point: every open punch, then the newest closed ones up to
//     PUNCH_PROJECTION_MAX_ROWS in all (the card needs today's and any still open);
//   · every read and write storage- and parse-guarded: unreadable reads as none.
import { GPS_POINT_COLUMNS } from './clockRules.js';

export const PUNCH_PROJECTION_KEY = 'cleanspace_my_punches_v1';
export const PUNCH_PROJECTION_MAX_ROWS = 60;

const deviceStorage = () => (typeof localStorage === 'undefined' ? null : localStorage);

function withoutPoint(entry) {
  const row = { ...entry };
  for (const col of GPS_POINT_COLUMNS) delete row[col];
  return row;
}

// The rows worth keeping from a server answer: real rows only (never a synthesized offline
// one), every open punch, then the newest closed ones.
export function devicePunchRows(entries) {
  const rows = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e === 'object' && e.id && !e.pending_sync);
  const open = rows.filter((e) => !e.clock_out_at);
  const closed = rows.filter((e) => e.clock_out_at)
    .sort((a, b) => String(b.clock_in_at || '').localeCompare(String(a.clock_in_at || '')))
    .slice(0, Math.max(0, PUNCH_PROJECTION_MAX_ROWS - open.length));
  return [...open, ...closed].map(withoutPoint);
}

export function savePunchProjection({ userId, entries } = {}, storage = deviceStorage()) {
  if (!userId || !storage) return false;
  try {
    storage.setItem(PUNCH_PROJECTION_KEY, JSON.stringify({ v: 1, userId, savedAt: new Date().toISOString(), entries: devicePunchRows(entries) }));
    return true;
  } catch {
    return false;
  }
}

// → the cleaner's last saved punches, or null (none saved, another cleaner's, unreadable).
export function readPunchProjection({ userId } = {}, storage = deviceStorage()) {
  if (!userId || !storage) return null;
  try {
    const raw = storage.getItem(PUNCH_PROJECTION_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || saved.v !== 1 || saved.userId !== userId || !Array.isArray(saved.entries)) return null;
    return saved.entries.filter((e) => e && typeof e === 'object' && e.id);
  } catch {
    return null;
  }
}

export function clearPunchProjection(storage = deviceStorage()) {
  try { storage?.removeItem(PUNCH_PROJECTION_KEY); } catch { /* best effort */ }
}
