// My Hours, read once and shared (the Cleaner Hub, brief C §3): the page (pages/crew/CrewHours)
// and Home's tile (useMyHoursSummary) ask the same question and share ONE read in flight and one
// answer (hooks/useSharedRead), reused for a minute. The person is the one on screen
// (hooks/useCrewPreview): a cleaner reads themselves (the server reads the login's claim); the
// owner's View-as names the person, which the server honours only with time.view.
//
// OFFLINE (THE LAW II.7, cache-first): a cleaner's own answer for each period is kept on the phone
// (lib/crewReadCache) and painted at once — online too, until the fresh read lands — and with no
// signal it is what the screen shows, said as such (`savedAt`). An office preview is never kept.
import { useMemo } from 'react';
import { useSharedRead } from './useSharedRead';
import { useCrewPreview } from './useCrewPreview';
import { useOnlineStatus } from './useOnlineStatus';
import * as timeApi from '../lib/timeApi';
import { makeReadCache } from '../lib/crewReadCache';
import { hoursOneDecimal, myHoursOffset } from '../lib/myHours';
import { useT } from '../i18n/react';
import { LANGUAGE_INFO, intlLocale } from '../i18n/languages';

const kept = makeReadCache('cleanspace_my_hours_v1', { max: 12 });

export function useMyHours(rawOffset = 0, { enabled = true } = {}) {
  const { previewing, userId } = useCrewPreview();
  const online = useOnlineStatus();
  const offset = myHoursOffset(rawOffset);
  const slot = `${userId || ''}|${offset}`;
  const key = `myHours|${previewing ? 'preview' : 'self'}|${slot}`;
  const r = useSharedRead(key, async () => {
    const answer = await timeApi.myHours({ userId, previewUserId: previewing ? userId : null, offset });
    if (!previewing) kept.put(slot, answer);
    return answer;
  }, { enabled: enabled && !!userId, paused: !online, maxAgeMs: 60000 });
  // The phone's copy, read again whenever a fresh answer lands (it was just written).
  const phone = useMemo(() => (previewing || !userId ? null : kept.get(slot)), [previewing, userId, slot, r.at]); // eslint-disable-line react-hooks/exhaustive-deps
  const fresh = r.data !== undefined && r.data !== null;
  return {
    offset,
    data: fresh ? r.data : (phone?.answer || null),
    // When the answer on screen is the phone's copy (no signal, or the read failed), when it was read.
    savedAt: fresh ? null : (phone?.savedAt || null),
    loading: !fresh && !phone && !r.error && online,
    error: fresh ? null : r.error,
    offline: !online,
    refresh: r.refresh,
  };
}

// Home's "My Hours" tile: this period's hours so far, "{hours} hrs this period", in the reader's
// language — the same answer the page shows (null until it is known).
export function useMyHoursSummary({ enabled = true } = {}) {
  const t = useT();
  const { data, loading } = useMyHours(0, { enabled });
  const hours = data ? hoursOneDecimal(data.totalMinutes) : null;
  return {
    hours,
    minutes: data ? data.totalMinutes : null,
    loading,
    label: hours == null ? '' : t('myHours.tile', { hours: formatHours(hours, t.lang) }),
  };
}

// One decimal always ("8.0"), in the reader's number format ("7,5" in Spanish) — the language's
// own locale (i18n/languages LANGUAGE_INFO), as the catalog's dates and numbers use.
export function formatHours(hours, lang) {
  const locale = LANGUAGE_INFO[lang]?.dateLocale || undefined;
  try {
    return new Intl.NumberFormat(intlLocale(locale), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Number(hours) || 0);
  } catch {
    return (Number(hours) || 0).toFixed(1);
  }
}
