import { useEffect, useState } from 'react';
import Icon from './Icon';
import EmptyState from './EmptyState';
import { useT } from '../i18n/react';
import { IDENTITY } from '../brand/identity.generated';

// The screen a signed-in session shows until the company's data has loaded (CS-672, UI_RULES
// §160). The store (store/index.jsx) renders it while it is not ready, and nothing else: its
// placeholder state is the DEMO's book, which no one may ever be shown as their own.
//   loading      the spinner, "Loading your workspace…"
//   slow         the same, saying it is taking longer than usual (store/sync.js BOOT_SLOW_MS)
//   unreachable  "Can't reach <app>": check the connection. It keeps trying by itself and says
//                when it tries next; Try again tries now; Sign out is the way out of a login
//                that cannot load at all.
// It sits above the store and the router, so it reads only the language (the i18n runtime is
// module state) and its props, never a store hook.
//
// `boot` is the sync manager's report: { phase, retryAt?, retrying?, failed? } (store/sync.js).
export default function BootScreen({ boot, onRetry, onSignOut }) {
  const t = useT();
  const phase = (boot && boot.phase) || 'loading';
  if (phase === 'unreachable') return <Unreachable boot={boot} onRetry={onRetry} onSignOut={onSignOut} />;
  return (
    <div className="boot-screen" role="status" aria-live="polite">
      <span className="boot-spinner" aria-hidden="true" />
      <p className="boot-line">{t('boot.loading')}</p>
      {phase === 'slow' && <p className="boot-hint">{t('boot.slow')}</p>}
    </div>
  );
}

function Unreachable({ boot, onRetry, onSignOut }) {
  const t = useT();
  const retryAt = (boot && boot.retryAt) || null;
  const retrying = !!(boot && boot.retrying);
  // A one-second tick while a retry is scheduled, so "Trying again in 12 s" counts down.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!retryAt) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [retryAt]);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const seconds = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : null;
  const status = retrying || seconds === 0 ? t('boot.retrying')
    : seconds !== null ? t('boot.retryIn', { count: seconds }) : null;
  // On success the session ends and the sign-in screen replaces this one. A sign-out the server
  // could not take (no connection) leaves the person signed in, so it says so.
  const signOut = async () => {
    if (signingOut || !onSignOut) return;
    setSigningOut(true);
    setSignOutFailed(false);
    let res = null;
    try { res = await onSignOut(); } catch (e) { res = { error: e }; }
    if (res && (res.error || res.cancelled)) {
      setSigningOut(false);
      if (res.error) setSignOutFailed(true);
    }
  };
  return (
    <div className="boot-screen" role="alert">
      <EmptyState
        icon={<Icon name="warning" size={28} />}
        title={t('boot.unreachableTitle', { brand: IDENTITY.product.name })}
        message={t('boot.unreachableLead')}
        action={(
          <div className="boot-stack">
            <div className="boot-actions">
              <button type="button" className="btn btn-primary" onClick={onRetry} disabled={retrying}>{t('boot.retry')}</button>
              <button type="button" className="btn btn-link" onClick={signOut} disabled={signingOut}>{t('boot.signOut')}</button>
            </div>
            {status && <div className="boot-hint" aria-live="polite">{status}</div>}
            {signOutFailed && <div className="boot-hint is-error">{t('boot.signOutFailed')}</div>}
          </div>
        )}
      />
    </div>
  );
}
