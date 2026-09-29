import { useEffect, useState } from 'react';
import Icon from './Icon';
import { useAuth } from '../hooks/useAuth';
import { legacyStubEntryCount, recoverStubHistory } from '../lib/timeApi';

// Sept 1 recovery: this phone ran the stale demo-clock build and holds real
// punch history in localStorage that the server never received. One tap uploads
// it (server-side: pending-approval 'stub_recovery' rows; idempotent). Fully
// self-contained so MyDay mounts it with one line; renders nothing when there
// is nothing to recover (which is every phone after its first upload).
export default function StubRecoveryBanner() {
  // Identity-scoped (shared devices): only the signed-in member's own demo
  // entries are counted and sent; coworkers' history stays parked for them.
  const { currentUser } = useAuth();
  const currentUserId = currentUser?.id || null;
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { setCount(legacyStubEntryCount({ currentUserId })); }, [currentUserId]);

  if (!count && !result) return null;

  const send = async () => {
    setBusy(true); setError('');
    try {
      const r = await recoverStubHistory({ currentUserId });
      setResult(r);
      setCount(0);
    } catch (e) {
      setError(e?.message || 'Upload failed — try again on better signal.');
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
            {result.inserted} clock record{result.inserted === 1 ? '' : 's'} sent to the office
          </div>
          <div className="clock-banner-time">
            They&rsquo;ll be reviewed and added to your hours. Nothing was deleted from this phone.
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
          {count} clock record{count === 1 ? '' : 's'} on this phone never reached the office
        </div>
        <div className="clock-banner-time">
          This phone was on an old app version that saved your clock-ins locally. Send them in so your hours can be counted.
        </div>
        {error && <div className="text-xs" style={{ color: 'var(--danger)', marginTop: 4 }}>{error}</div>}
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={send}>
        {busy ? 'Sending…' : 'Send to office'}
      </button>
    </div>
  );
}
