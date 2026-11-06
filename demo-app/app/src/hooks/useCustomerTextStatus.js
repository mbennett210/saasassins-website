// Which of one customer's numbers have texts off — they replied STOP — and since when (Daniel,
// 2026-10-28: "Yes, add the Reply STOP functionality."). Read once per customer page from
// GET /api/client-messages/text-status (contacts.view), so the page can say "Texts off" beside the
// number. → (phone) => the opt-out's date (ISO) or null, for a number typed any way.
//
// Read-only and quiet: an unread status shows no note (the send step refuses the text either way;
// this is only the office being told).
import { useCallback, useEffect, useState } from 'react';
import { fetchCustomerTextStatus } from '../lib/clientMessagesApi';
import { toE164 } from '../lib/alertDelivery';

export function useCustomerTextStatus(clientId, enabled = true) {
  const [off, setOff] = useState(() => new Map());
  useEffect(() => {
    setOff(new Map());
    if (!clientId || !enabled) return undefined;
    let live = true;
    fetchCustomerTextStatus(clientId)
      .then((r) => {
        if (!live) return;
        setOff(new Map((r?.optOuts || []).filter((x) => x && x.phone).map((x) => [x.phone, x.optedOutAt || null])));
      })
      .catch(() => { /* no note; see the header */ });
    return () => { live = false; };
  }, [clientId, enabled]);
  return useCallback((phone) => {
    const e164 = toE164(typeof phone === 'string' ? phone : '');
    return (e164 && off.get(e164)) || null;
  }, [off]);
}
