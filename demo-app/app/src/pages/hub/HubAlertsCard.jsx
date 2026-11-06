import { useEffect, useState } from 'react';
import Toggle from '../../components/Toggle';
import { useToast } from '../../components/Toast';
import { HUB_ALERT_DEVICE, HUB_ALERT_MEMORY } from '../../lib/crewOnTheWay';
import {
  hubAlertsDeviceNow, hubAlertsMemory, rememberHubAlerts, hubAlertsStatus, turnOnHubAlerts, turnOffHubAlerts,
} from '../../lib/hubAlerts';
import { HUB_PREVIEW_NOTE } from '../../lib/hubPreview';
import { hubDeviceWord } from './HubAlertsRow';
import HubAlertsSteps from './HubAlertsSteps';

// PHONE ALERTS on the Account page (Daniel's pick 2026-11-03, "A · Row on Home + Account"), under
// Emails: one switch, Crew on the way, for THIS phone or computer (alerts are per device: each one
// a customer uses is turned on there). The switch shows what the server has for this browser's
// push address (GET /api/hub/push); it saves the moment it changes and says so.
//
//   · iPhone or iPad outside the Home Screen app: the switch is off and can't be moved; "Show me
//     how" opens the Home Screen steps (./HubAlertsSteps.jsx).
//   · Alerts blocked in the browser, or a browser with none: the switch is off, with why.
//   · The office's preview: shown off and disabled. A preview signs no phone up.
const WORDS = Object.freeze({
  label: 'Crew on the way',
  help: 'An alert when your cleaner taps On my way for one of your buildings.',
});

export default function HubAlertsCard({ preview = false, readOnly = false, viewerKey = '' }) {
  const toast = useToast();
  const [device] = useState(() => hubAlertsDeviceNow());
  const word = hubDeviceWord();
  const ready = device === HUB_ALERT_DEVICE.ready && !preview;
  // Until the server answers, the switch shows what this browser remembers.
  const [on, setOn] = useState(() => ready && hubAlertsMemory(viewerKey) === HUB_ALERT_MEMORY.on);
  const [known, setKnown] = useState(!ready);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [steps, setSteps] = useState(false);

  useEffect(() => {
    if (!ready) return undefined;
    let live = true;
    hubAlertsStatus().then((r) => {
      if (!live) return;
      setOn(r.on);
      setKnown(true);
      // Keep this browser's memory with the server: a sign-up the push service dropped brings Home's
      // row back; one found on puts it away.
      const mem = hubAlertsMemory(viewerKey);
      if (r.on && mem !== HUB_ALERT_MEMORY.on) rememberHubAlerts(viewerKey, HUB_ALERT_MEMORY.on);
      if (!r.on && mem === HUB_ALERT_MEMORY.on) rememberHubAlerts(viewerKey, null);
    }).catch(() => { if (live) setKnown(true); });
    return () => { live = false; };
  }, [ready, viewerKey]);

  const flip = async (next) => {
    if (!ready || busy) return;
    const before = on;
    setProblem('');
    setOn(next);
    setBusy(true);
    try {
      if (next) await turnOnHubAlerts(viewerKey);
      else await turnOffHubAlerts(viewerKey);
      toast.success(next ? `Alerts are on for this ${word}.` : `Alerts are off for this ${word}.`);
    } catch (e) {
      setOn(before);
      setProblem(e?.message || 'That change wasn’t saved. Try again in a moment.');
      toast.error('That change wasn’t saved.');
    } finally {
      setBusy(false);
    }
  };

  let note = null;
  if (preview) note = <p className="text-xs text-muted">{readOnly ? HUB_PREVIEW_NOTE : 'Preview: a customer turns alerts on from their own phone.'}</p>;
  else if (device === HUB_ALERT_DEVICE.install) {
    note = (
      <div className="hub-alerts-note">
        <p className="text-sm">{`On an ${word === 'iPad' ? 'iPad' : 'iPhone'}, alerts come to the app on your Home Screen.`}</p>
        <div className="hub-actions"><button type="button" className="btn btn-outline" onClick={() => setSteps(true)}>Show me how</button></div>
      </div>
    );
  } else if (device === HUB_ALERT_DEVICE.blocked) {
    note = <p className="text-sm">Alerts are blocked for this site in your browser’s settings. Allow them there, then come back here.</p>;
  } else if (device === HUB_ALERT_DEVICE.unsupported) {
    note = <p className="text-sm">This browser can’t show alerts. Open the hub in Safari on an iPhone, or in Chrome.</p>;
  }

  return (
    <section className="card hub-card">
      <h2 className="hub-card-title">Phone alerts</h2>
      <p className="text-sm text-muted">{`Alerts come to this ${word}. Turn them on on each phone or computer you use.`}</p>
      <ul className="hub-prefs">
        <li className="hub-pref">
          <label className="hub-pref-main">
            <span className="hub-pref-label">{WORDS.label}</span>
            <Toggle on={on} onChange={flip} disabled={!ready || busy || !known} />
          </label>
          <span className="hub-pref-help text-xs">{WORDS.help}</span>
        </li>
      </ul>
      {note}
      {problem && <div className="form-error" role="alert">{problem}</div>}
      {device === HUB_ALERT_DEVICE.install && (
        <HubAlertsSteps open={steps} onClose={() => setSteps(false)} device={word === 'iPad' ? 'iPad' : 'iPhone'} />
      )}
    </section>
  );
}
