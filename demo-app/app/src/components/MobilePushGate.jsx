import { useEffect, useState, useCallback } from 'react';
import { useStore } from '../store';
import { selectCurrentUser } from '../store/selectors';
import Modal from './Modal';
import { useToast } from './Toast';
import {
  isPushSupported, isCurrentDeviceSubscribed, isIOS, isStandalonePWA, enableMobilePush,
} from '../lib/push';

// Strong-but-skippable mobile push enrollment prompt. On a phone / installed PWA,
// it nudges an un-subscribed user to turn on notifications so they don't miss
// late/missed-shift and job alerts. Dismissible for the session (re-appears next
// session until a device is actually subscribed). It CANNOT force the OS grant, so
// the iOS-needs-install and OS-denied cases show instructions instead of a button.
// Mounted authed-only (App AuthedShell), so currentUser is available.

const DISMISS_KEY = 'cs.pushGate.dismissed'; // per-session skip flag

function isMobileContext() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (isStandalonePWA()) return true;
  if (isIOS()) return true;
  if (/Android|Mobile/i.test(navigator.userAgent || '')) return true;
  try {
    return window.matchMedia('(max-width: 768px)').matches && (navigator.maxTouchPoints || 0) > 0;
  } catch { return false; }
}
function dismissedThisSession() {
  try { return sessionStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}
function currentPermission() {
  try { return typeof Notification !== 'undefined' ? Notification.permission : 'default'; } catch { return 'default'; }
}

export default function MobilePushGate() {
  const state = useStore();
  const currentUser = selectCurrentUser(state);
  const toast = useToast();
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [perm, setPerm] = useState(currentPermission());

  useEffect(() => {
    let alive = true;
    if (!currentUser?.id || !isPushSupported() || !isMobileContext() || dismissedThisSession()) {
      setShow(false);
      return () => { alive = false; };
    }
    // Only prompt when this device has no active subscription.
    isCurrentDeviceSubscribed()
      .then((sub) => { if (alive) setShow(!sub); })
      .catch(() => { if (alive) setShow(true); });
    return () => { alive = false; };
  }, [currentUser?.id]);

  const iosNeedsInstall = isIOS() && !isStandalonePWA();
  const denied = perm === 'denied';

  const enable = useCallback(async () => {
    if (!currentUser?.id) return;
    setBusy(true);
    try {
      await enableMobilePush({ userId: currentUser.id });
      setPerm(currentPermission());
      toast.success('Notifications are on for this device.');
      setShow(false);
    } catch (err) {
      setPerm(currentPermission());
      toast.error(err?.message || 'Could not enable notifications.');
    } finally {
      setBusy(false);
    }
  }, [currentUser?.id, toast]);

  const notNow = useCallback(() => {
    try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ }
    setShow(false);
  }, []);

  if (!show) return null;

  return (
    <Modal open onClose={notNow} title="Turn on notifications" size="sm">
      <div className="text-sm" style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
        {iosNeedsInstall ? (
          <>
            <p>To get alerts on this iPhone or iPad, add the app to your Home Screen first.</p>
            <p>Tap the Share button, choose <strong>Add to Home Screen</strong>, open the app from there, then come back to turn notifications on.</p>
          </>
        ) : denied ? (
          <>
            <p>Notifications are currently blocked for this app in your device settings.</p>
            <p>Turn them on in your browser or site settings, then reopen the app.</p>
          </>
        ) : (
          <p>Get alerted about late or missed shifts, new work orders, and job updates even when the app is closed. It takes one tap.</p>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={notNow} disabled={busy}>Not now</button>
        {!iosNeedsInstall && !denied && (
          <button type="button" className="btn btn-primary" onClick={enable} disabled={busy}>
            {busy ? 'Enabling…' : 'Enable notifications'}
          </button>
        )}
      </div>
    </Modal>
  );
}
