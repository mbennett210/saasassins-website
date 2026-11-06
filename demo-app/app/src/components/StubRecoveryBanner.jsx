import { useEffect, useState } from 'react';
import Icon from './Icon';
import { useAuth } from '../hooks/useAuth';
import { legacyStubEntryCount, recoverStubHistory } from '../lib/timeApi';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';

// Sept 1 recovery: this phone ran the stale demo-clock build and holds real
// punch history in localStorage that the server never received. One tap uploads
// it (server-side: pending-approval 'stub_recovery' rows; idempotent). Fully
// self-contained so MyDay mounts it with one line; renders nothing when there
// is nothing to recover (which is every phone after its first upload).
// Every word is a catalog line in the cleaner's language (CS-193).
export default function StubRecoveryBanner() {
  const t = useT();
  // Identity-scoped (shared devices): only the signed-in member's own demo
  // entries are counted and sent; coworkers' history stays parked for them.
  const { currentUser } = useAuth();
  const currentUserId = currentUser?.id || null;
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => { setCount(legacyStubEntryCount({ currentUserId })); }, [currentUserId]);

  if (!count && !result) return null;

  const send = async () => {
    setBusy(true); setError(null);
    try {
      const r = await recoverStubHistory({ currentUserId });
      setResult(r);
      setCount(0);
    } catch (e) {
      setError(e || new Error(''));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="clock-banner" role="status" style={{ marginBottom: 12 }}>
        <Icon name="check" size={18} />
        <div className="clock-banner-body">
          <div className="clock-banner-title">
            {t('recovery.sent', { count: result.inserted })}
          </div>
          <div className="clock-banner-time">
            {t('recovery.sentNote')}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="clock-banner" role="alert" style={{ marginBottom: 12 }}>
      <Icon name="warning" size={18} />
      <div className="clock-banner-body">
        <div className="clock-banner-title">
          {t('recovery.stranded', { count })}
        </div>
        <div className="clock-banner-time">
          {t('recovery.strandedNote')}
        </div>
        {error && <div className="text-xs" style={{ color: 'var(--danger)', marginTop: 4 }}>{errorText(t, error, 'recovery.failed')}</div>}
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={send}>
        {busy ? t('recovery.sending') : t('recovery.send')}
      </button>
    </div>
  );
}
