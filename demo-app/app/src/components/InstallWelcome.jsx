import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import { useT, richText } from '../i18n/react';
import { english } from '../i18n/core';
import { IDENTITY } from '../brand/identity.generated.js';
import { LIGHT_LOGO_URL } from '../brand/logo.js';
import { INSTALL_STEPS, INSTALL_NOTE } from '../lib/installWelcome';
import {
  useInstallWelcome, markWelcomeShown, continueInBrowser, stopWelcomeForGood, promptInstall,
} from '../lib/installApp';

// The first-visit welcome that puts the app on the Home Screen (task #127, UI_RULES §178): full screen,
// on a phone's browser only, with the steps for THIS phone and browser (lib/installWelcome decides,
// lib/installApp holds Android's install offer and the answers). Mounted on the sign-in page, in the
// office shell (App AuthedShell) and in the customer hub (HubRoot, `englishOnly`: what a customer
// reads stays English, LANG-8) — never on the public pages (/quote, /inspect, /scan, /survey).
//
//   • "Continue in the browser" hides it for this visit; it comes back next visit until the app is added.
//   • "I already have the app" / "Don't show again" stop it for good in this browser (an iPhone's
//     Safari can't see the Home Screen app, so this is how someone who has it says so, once).
//   • Android with the install offer: an Install button that opens the phone's own install box.
//   • Opacity only: in over 220ms, out over 160ms; a close mid-fade turns the fade round.

const IN = { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'both' };
const OUT = { duration: 160, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'both' };
const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

// The numbered steps, as the welcome draws them; also the customer hub's phone alerts on an iPhone
// outside its Home Screen app (pages/hub/HubAlertsSteps.jsx), so both show one set of steps one way.
// `rich` renders a catalog key with its params (the welcome's own, or English for the hub).
export function InstallSteps({ steps, rich, params }) {
  return (
    <ol className="install-welcome-steps">
      {steps.map((step, i) => (
        <li key={step.key} className="install-welcome-step">
          <span className="install-welcome-num" aria-hidden="true">{i + 1}</span>
          <span className="install-welcome-text">{rich(step.key, params)}</span>
          <Icon name={step.icon} size={24} strokeWidth={1.75} className="install-welcome-glyph" />
        </li>
      ))}
    </ol>
  );
}

export default function InstallWelcome({ englishOnly = false }) {
  const welcome = useInstallWelcome();
  const [done, setDone] = useState(false);
  if (!welcome || done) return null;
  return createPortal(
    <WelcomeScreen welcome={welcome} englishOnly={englishOnly} onDone={() => setDone(true)} />,
    document.body,
  );
}

function WelcomeScreen({ welcome, englishOnly, onDone }) {
  const t = useT();
  const say = englishOnly ? english : t;
  const rich = englishOnly ? (key, params) => richText(english(key, params)) : t.rich;
  // After Chrome's own install box is dismissed its offer is spent: show the browser's menu steps instead.
  const [variant, setVariant] = useState(welcome.variant);
  const fromOffer = welcome.variant === 'android-prompt';
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(null); // null | 'ok' | 'fail'
  const rootRef = useRef(null);
  const fadeRef = useRef(null);
  const closingRef = useRef(false);

  // Before the first paint: the screen is in its place at opacity 0, the app behind it goes inert and
  // stops scrolling, and the screen itself takes focus (not its button, which would open wearing a focus
  // ring), so a sign-in page's email box lets its keyboard go. The fade starts on the frame after that
  // first paint: started at once, its clock ran while the page under it was still drawing, and its first
  // visible frame was already a fifth of the way in (measured in WebKit). It is held at 0 by a style, not
  // a paused animation: on the iOS 27 simulator's Safari a paused-then-played fade never ran, and the
  // screen sat there invisible.
  useLayoutEffect(() => {
    markWelcomeShown();
    const app = document.getElementById('root');
    const wasInert = app ? app.inert : false;
    if (app) app.inert = true;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const el = rootRef.current;
    let frame = 0;
    if (el && el.animate && !reducedMotion()) {
      el.style.opacity = '0';
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (closingRef.current) return;
          fadeRef.current = el.animate([{ opacity: 0 }, { opacity: 1 }], IN);
          el.style.opacity = '';
        });
      });
    }
    el?.focus({ preventScroll: true });
    return () => {
      cancelAnimationFrame(frame);
      if (el) el.style.opacity = '';
      if (app) app.inert = wasInert;
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  const close = useCallback((record) => {
    if (closingRef.current) return;
    closingRef.current = true;
    record?.();
    const el = rootRef.current;
    const fade = fadeRef.current;
    // No motion asked for, or never seen yet (its fade hadn't started): nothing to fade out.
    if (!el || !el.animate || reducedMotion() || !fade) { onDone(); return; }
    if (fade.playState === 'running') {
      // Still fading in: turn round from where it is, never jump or restart.
      fade.onfinish = onDone;
      fade.reverse();
      return;
    }
    const out = el.animate([{ opacity: 1 }, { opacity: 0 }], OUT);
    out.onfinish = onDone;
  }, [onDone]);

  const install = useCallback(async () => {
    setBusy(true);
    const outcome = await promptInstall();
    setBusy(false);
    if (outcome === 'accepted') close();
    else setVariant('android-chrome');
  }, [close]);

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  }, []);

  const browser = welcome.phone === 'ios' ? 'Safari' : 'Chrome'; // i18n-ok: a browser's own name
  const params = { product: IDENTITY.product.name, browser };
  const steps = INSTALL_STEPS[variant] || [];
  const note = INSTALL_NOTE[variant];
  const why = variant === 'android-prompt' ? 'installWelcome.whyPrompt'
    : variant === 'inapp' ? 'installWelcome.inappWhy' : 'installWelcome.why';

  let primary;
  let links;
  if (variant === 'android-prompt') {
    primary = { label: say('installWelcome.install'), onClick: install };
    links = ['continue', 'never'];
  } else if (variant === 'inapp') {
    primary = { label: copied === 'ok' ? say('installWelcome.copied') : say('installWelcome.copyLink'), onClick: copyLink };
    links = ['continue', 'never'];
  } else {
    primary = { label: say('installWelcome.continue'), onClick: () => close(continueInBrowser) };
    // Chrome just said the app isn't installed (its offer came), so "I already have it" would be wrong.
    links = fromOffer ? ['never'] : ['haveIt', 'never'];
  }
  const LINKS = {
    continue: { label: say('installWelcome.continue'), onClick: () => close(continueInBrowser) },
    haveIt: { label: say('installWelcome.haveIt'), onClick: () => close(() => stopWelcomeForGood('installed')) },
    never: { label: say('installWelcome.never'), onClick: () => close(() => stopWelcomeForGood('never')) },
  };

  return (
    <div ref={rootRef} className="install-welcome" role="dialog" aria-modal="true" aria-labelledby="install-welcome-title" tabIndex={-1}>
      <div className="install-welcome-scroll">
        <div className={`install-welcome-body${variant !== welcome.variant ? ' is-swapped' : ''}`} key={variant}>
          <img className="install-welcome-logo" src={LIGHT_LOGO_URL} alt={IDENTITY.product.name} />
          <h1 id="install-welcome-title" className="install-welcome-title">{say('installWelcome.title')}</h1>
          <p className="install-welcome-why">{say(why, params)}</p>
          {steps.length > 0 && <InstallSteps steps={steps} rich={rich} params={params} />}
          {note && <p className="install-welcome-note">{say(note)}</p>}
          {copied === 'fail' && <p className="install-welcome-note" role="status">{say('installWelcome.copyFailed')}</p>}
        </div>
      </div>
      <div className="install-welcome-foot">
        <button
          type="button" className="btn btn-primary install-welcome-primary"
          onClick={primary.onClick} disabled={busy}
        >
          {primary.label}
        </button>
        <div className="install-welcome-links">
          {links.map((id) => (
            <button key={id} type="button" className="btn btn-link install-welcome-link" onClick={LINKS[id].onClick}>
              {LINKS[id].label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
