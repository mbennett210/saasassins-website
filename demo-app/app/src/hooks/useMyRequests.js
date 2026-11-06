// A cleaner's Client Requests, read once and shared (the Cleaner Hub, brief C §2): the list, the
// request page and Home's tile (useMyRequestsCount) ask the same question and share ONE read in
// flight and one answer (hooks/useSharedRead), reused for half a minute. The person is the one on
// screen (hooks/useCrewPreview): a cleaner reads themselves (the server reads the login's claim);
// the owner's View-as names the person, which the server honours only with problems.manage.
//
// OFFLINE (THE LAW II.7, cache-first): a cleaner's own lists are kept on the phone
// (lib/crewReadCache) and painted at once — online too, until the fresh read lands — and with no
// signal they are what the screens show, said as such (`savedAt`). Completing a request still
// needs a signal (the request page says so). An office preview is never kept.
import { useMemo } from 'react';
import { useSharedRead } from './useSharedRead';
import { useCrewPreview } from './useCrewPreview';
import { useOnlineStatus } from './useOnlineStatus';
import * as qcApi from '../lib/qcApi';
import { makeReadCache } from '../lib/crewReadCache';

const kept = makeReadCache('cleanspace_crew_requests_v1', { max: 4 });

export function useMyRequests({ enabled = true } = {}) {
  const { previewing, userId } = useCrewPreview();
  const online = useOnlineStatus();
  const slot = userId || '';
  const key = `crewRequests|${previewing ? 'preview' : 'self'}|${slot}`;
  const r = useSharedRead(key, async () => {
    const answer = await qcApi.listMyRequests({ userId, previewUserId: previewing ? userId : null });
    if (!previewing) kept.put(slot, answer);
    return answer;
  }, { enabled: enabled && !!userId, paused: !online, maxAgeMs: 30000 });
  const phone = useMemo(() => (previewing || !userId ? null : kept.get(slot)), [previewing, userId, slot, r.at]); // eslint-disable-line react-hooks/exhaustive-deps
  const fresh = r.data !== undefined && r.data !== null;
  return {
    data: fresh ? r.data : (phone?.answer || null),
    savedAt: fresh ? null : (phone?.savedAt || null),
    loading: !fresh && !phone && !r.error && online,
    error: fresh ? null : r.error,
    offline: !online,
    refresh: r.refresh,
  };
}

// Home's "Client Requests" tile: how many open requests are on this cleaner's list (null until known).
export function useMyRequestsCount({ enabled = true } = {}) {
  const { data, loading } = useMyRequests({ enabled });
  return { count: data ? data.open.length : null, loading };
}
