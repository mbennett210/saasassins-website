import { useCallback, useEffect, useState } from 'react';
import { useSelector, shallowEqual } from '../store';
import { selectTodayCleansForUser, selectJobsForUser } from '../store/selectors';
import { useCrewPreview } from './useCrewPreview';
import { usePermission } from './usePermission';
import * as timeApi from '../lib/timeApi';
import { dayKey, addDaysKey, startOfDayKey } from '../lib/dates';

// The cleaner's day, shared by the Cleaner Hub's screens (Home, My Stops Today, the Clock screen):
// their punches, a 30-second clock, and today's and the next fortnight's cleans. Clock state is a
// screen-local projection (lib/timeApi), never the synced record (UI_RULES Rule 20).

// How far ahead "Coming up" looks.
export const UPCOMING_DAYS = 14;
// The preview's punch read reaches back far enough to hold an overnight clean.
const PREVIEW_PUNCH_WINDOW_MS = 36 * 60 * 60 * 1000;

// The cleaner's own punches (lib/timeApi mine: no day bound, so an OPEN punch from a clean that ran
// past midnight comes back — the cleaner must always be able to clock out; offline punches fold in).
// 🔴 In the owner's View-as a cleaner (plan D8) the server would answer the OWNER's punches to
// `mine`, so the viewed cleaner's are read through the office's time read instead (time.view):
// server truth only, which is what a preview should show.
export function useCrewPunches(userId) {
  const { previewing } = useCrewPreview();
  const canViewTime = usePermission('time.view');
  const [entries, setEntries] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [pending, setPending] = useState({ unsynced: 0, failed: 0 });
  const load = useCallback(async () => {
    if (!userId) return;
    setError(null);
    try {
      const read = previewing && canViewTime
        ? timeApi.entries({ userIds: [userId], fromIso: new Date(Date.now() - PREVIEW_PUNCH_WINDOW_MS).toISOString() })
        : timeApi.mine({ userId });
      const [list, total, unsynced] = await Promise.all([
        read,
        timeApi.pendingPunchCount({ includeFailed: true }),
        timeApi.pendingPunchCount(),
      ]);
      setEntries(list || []);
      setPending({ unsynced, failed: Math.max(0, total - unsynced) });
    } catch (e) {
      // The error itself, worded at render time in the cleaner's language.
      setError(e || new Error(''));
    }
  }, [userId, previewing, canViewTime]);
  useEffect(() => { load(); }, [load]);
  // Refresh when buffered offline punches sync (their synthesized ids are swapped for real server
  // rows) or when the network returns.
  useEffect(() => {
    const again = () => load();
    window.addEventListener('cleanspace:time-queue-flushed', again);
    window.addEventListener('online', again);
    return () => {
      window.removeEventListener('cleanspace:time-queue-flushed', again);
      window.removeEventListener('online', again);
    };
  }, [load]);
  return { entries, error, pending, load };
}

// A clock that ticks every 30 s (minute-resolution display: time elapsed, "tonight", a window).
export function useNowTick() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);
  return now;
}

// Today's cleans and the next fortnight's, split on the ORG's midnight. shallowEqual on both: each
// ends in .filter()/.sort(), a fresh array per call, and the jobs keep identity across dispatches
// that do not touch them (§8 0.4).
export function useCrewDay(userId, now) {
  const cleans = useSelector(
    useCallback((s) => selectTodayCleansForUser(s, userId, now), [userId, now]),
    shallowEqual,
  );
  const upcoming = useSelector(
    useCallback((s) => {
      const todayK = dayKey(now);
      const from = startOfDayKey(addDaysKey(todayK, 1)).getTime();
      const to = startOfDayKey(addDaysKey(todayK, 1 + UPCOMING_DAYS)).getTime();
      return selectJobsForUser(s, userId)
        .filter((j) => {
          const ts = new Date(j.startAt).getTime();
          return Number.isFinite(ts) && ts >= from && ts < to && j.status !== 'cancelled';
        })
        .sort((a, b) => a.startAt.localeCompare(b.startAt));
    }, [userId, now]),
    shallowEqual,
  );
  return { cleans, upcoming };
}
