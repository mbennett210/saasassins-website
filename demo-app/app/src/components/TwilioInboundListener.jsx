// Production: opens the SSE stream from the deployment backend so inbound SMS
// webhooks land as RECEIVE_SMS dispatches into the messaging store.
// Dev (stub mode, no VITE_TWILIO_BACKEND_URL): the subscription resolves to a
// no-op — inbound SMS is exercised manually via Settings → Integrations →
// "Simulate Inbound SMS".

import { useEffect } from 'react';
import { useDispatch } from '../store';
import { ACTIONS } from '../store/reducer';
import { subscribeToInbound } from '../lib/twilio';

export default function TwilioInboundListener() {
  const dispatch = useDispatch();

  useEffect(() => {
    const unsubscribe = subscribeToInbound((payload) => {
      dispatch({
        type: ACTIONS.RECEIVE_SMS,
        fromPhone: payload.fromPhone,
        toPhone: payload.toPhone,
        body: payload.body,
        messageSid: payload.messageSid,
      });
    });
    return unsubscribe;
  }, [dispatch]);

  return null;
}
