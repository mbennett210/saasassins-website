import { useLayoutEffect, useRef, useState } from 'react';
import Centred from '../../components/Centred';
import Icon from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { HUB_ALERT_DEVICE, HUB_ALERT_MEMORY, hubAlertsRowShows } from '../../lib/crewOnTheWay';
import { hubAlertsDeviceNow, hubAlertsMemory, rememberHubAlerts, turnOnHubAlerts } from '../../lib/hubAlerts';
import { phoneOf, isIPad } from '../../lib/installWelcome';
import HubAlertsSteps from './HubAlertsSteps';

// CREW ON THE WAY's row on Home (Daniel's pick 2026-11-03, "A · Row on Home + Account"), under the
// account manager and over the crew band: "Get an alert when your crew is on the way", Turn on and
// ×. On a phone Turn on sits under the words and × at the top right; on a computer it is one line.
//
//   · It shows on a phone or computer that can have alerts (or an iPhone that can once the app is on
//     its Home Screen: Turn on shows those steps, ./HubAlertsSteps.jsx), until alerts are turned on
//     here or the × is tapped (crewOnTheWay hubAlertsRowShows). Both are remembered in this browser
//     per login (lib/hubAlerts), so the row is in its place on the first paint and Home never jumps.
//   · Turned on or closed, it fades out, then its room closes over 220ms and what is under it moves
//     up with it (no jump; reduced motion: at once). The Account card's switch stays.
//   · The office's preview signs no phone up (the server refuses it): Turn on is off there.
const FADE = { duration: 160, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' };
const CLOSE = { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' };
const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

export function hubDeviceWord() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const touches = (typeof navigator !== 'undefined' && navigator.maxTouchPoints) || 0;
  if (isIPad(ua, touches)) return 'iPad';
  return phoneOf(ua, touches) ? 'phone' : 'computer';
}

export default function HubAlertsRow({ viewerKey, preview = false }) {
  const toast = useToast();
  const [device] = useState(() => hubAlertsDeviceNow());
  const [shown, setShown] = useState(() => hubAlertsRowShows({ device, memory: hubAlertsMemory(viewerKey) }));
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [steps, setSteps] = useState(false);
  const ref = useRef(null);
  const word = hubDeviceWord();

  // The way out: a fade, then the row's room glides shut (its height and the page's gap under it),
  // and only then is it taken off the page.
  useLayoutEffect(() => {
    if (!leaving) return undefined;
    const el = ref.current;
    if (!el || reducedMotion() || typeof el.animate !== 'function') { setShown(false); return undefined; }
    let cancelled = false;
    const gap = parseFloat(getComputedStyle(el.parentElement || el).rowGap) || 0;
    const h = el.getBoundingClientRect().height;
    const fade = el.animate([{ opacity: 1 }, { opacity: 0 }], FADE);
    fade.finished.then(() => {
      if (cancelled) return;
      el.style.overflow = 'hidden';
      // A border never draws under 1px, so its two lines are paid back in the margin with the gap.
      const cs = getComputedStyle(el);
      const lines = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      const shut = el.animate([
        { height: `${h}px`, marginBottom: '0px', paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, opacity: 0 },
        { height: '0px', marginBottom: `${-(gap + lines)}px`, paddingTop: '0px', paddingBottom: '0px', opacity: 0 },
      ], CLOSE);
      return shut.finished.then(() => { if (!cancelled) setShown(false); });
    }).catch(() => { if (!cancelled) setShown(false); });
    return () => { cancelled = true; };
  }, [leaving]);

  if (!shown) return null;

  const close = () => {
    if (leaving) return;
    rememberHubAlerts(viewerKey, HUB_ALERT_MEMORY.dismissed);
    setLeaving(true);
  };
  const turnOn = async () => {
    if (busy || leaving || preview) return;
    if (device === HUB_ALERT_DEVICE.install) { setSteps(true); return; }
    setProblem('');
    setBusy(true);
    try {
      await turnOnHubAlerts(viewerKey);
      toast.success(`Alerts are on for this ${word}.`);
      setLeaving(true);
    } catch (e) {
      setProblem(e?.message || 'Alerts couldn’t be turned on. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section ref={ref} className="hub-alerts-row" aria-label="Crew on the way alerts">
      <span className="hub-tile-icon" aria-hidden="true"><Icon name="bell" size={20} /></span>
      <div className="hub-alerts-text">
        <p className="hub-alerts-title">Get an alert when your crew is on the way</p>
        <p className="hub-alerts-sub text-xs">{`On this ${word}. Change it any time in Account.`}</p>
        {problem && <p className="form-error" role="alert">{problem}</p>}
      </div>
      <button type="button" className="btn btn-primary hub-alerts-on" onClick={turnOn} disabled={busy || preview}>
        <Centred kind="run">{busy ? 'Turning on…' : 'Turn on'}</Centred>
      </button>
      <button type="button" className="modal-close hub-alerts-close" onClick={close} aria-label="Close"><Centred kind="ink">×</Centred></button>
      {device === HUB_ALERT_DEVICE.install && (
        <HubAlertsSteps open={steps} onClose={() => setSteps(false)} device={word === 'iPad' ? 'iPad' : 'iPhone'} />
      )}
    </section>
  );
}
