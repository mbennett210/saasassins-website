// "On my way" for today's stops (the Cleaner Hub; Crew on the way, lib/crewOnTheWay.js): ONE read
// for the whole list (EP-422) — which stops someone can be told on (`canTell`: a customer login on
// the building, or the text; the button shows only on those) and which already told them — and the
// send (EP-423). A failed read leaves the button hidden; the send's refusal comes back as the error
// it was. (A server from before Crew on the way answered only `available`: then every stop asked.)
import { useCallback, useEffect, useState } from 'react';
import { onMyWayStatus, sendOnMyWay } from '../lib/timeApi';

const NONE = { canTell: new Set(), sent: new Set() };

export function useOnMyWay(jobIds) {
  const key = [...new Set((jobIds || []).filter(Boolean))].sort().join(',');
  const [state, setState] = useState(NONE);
  useEffect(() => {
    if (!key) return undefined;
    let alive = true;
    const ids = key.split(',');
    onMyWayStatus(ids)
      .then((r) => {
        if (!alive) return;
        const canTell = Array.isArray(r?.canTell) ? r.canTell : (r?.available === true ? ids : []);
        setState({ canTell: new Set(canTell), sent: new Set(r?.sent || []) });
      })
      .catch(() => { if (alive) setState(NONE); });
    return () => { alive = false; };
  }, [key]);
  const send = useCallback(async (jobId, job = null) => {
    await sendOnMyWay(jobId, job);
    setState((s) => ({ ...s, sent: new Set([...s.sent, jobId]) }));
  }, []);
  return { ...state, send };
}
