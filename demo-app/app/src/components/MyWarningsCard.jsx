// "You have a warning to review" — the employee's side of Matt's ask: "The employee receives,
// reviews and acknowledges it in the system." A card on My Day while a warning of theirs is
// waiting for their signature; it opens the warning to read, Translate (into their language,
// on demand), comment and sign. The bell row deep-links here (`/my-day?warning=<id>`).
//
// 🔴 OWN WARNINGS ONLY. It asks /api/hr-warnings/mine, where the server takes the person from
// the LOGIN's claim — never from anything this screen sends. Signing confirms receipt, not
// agreement, and the sign step says so beside the box.
//
// Renders nothing when there is nothing to sign. Words: the catalog, in the cleaner's
// language (UI_RULES §140).
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSelector } from '../store';
import { useT } from '../i18n/react';
import { fmtDate } from '../lib/dates';
import { WARNING_STATUS } from '../lib/hrWarnings';
import * as hrWarningsApi from '../lib/hrWarningsApi';
import Icon from './Icon';
import Modal from './Modal';
import HrWarningDetail from './HrWarningDetail';

const day = (key) => (key ? fmtDate(`${key}T12:00:00`, { month: 'short', day: 'numeric' }) : '');

export default function MyWarningsCard({ userId }) {
  const t = useT();
  const users = useSelector(useCallback((s) => s.users || [], []));
  const [params, setParams] = useSearchParams();
  const [awaiting, setAwaiting] = useState([]);
  const linked = params.get('warning') || '';
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      const r = await hrWarningsApi.listMine({ currentUserId: userId });
      setAwaiting((r.warnings || []).filter((w) => w.status === WARNING_STATUS.awaiting));
    } catch { setAwaiting([]); /* the rest of My Day must never wait on this card */ }
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  // The bell's deep link opens the warning it is about (the server refuses anyone else's).
  useEffect(() => { if (linked) setOpenId(linked); }, [linked]);
  const close = () => {
    setOpenId(null);
    if (linked) setParams((prev) => { const next = new URLSearchParams(prev); next.delete('warning'); return next; }, { replace: true });
  };

  const first = awaiting[0];
  return (
    <>
      {first && (
        <div className="card hrw-mine" role="alert">
          <Icon name="warning" size={18} />
          <div className="hrw-mine-body">
            <div className="hrw-mine-title">{t('hrWarn.mine.title', { count: awaiting.length })}</div>
            <div className="text-sm text-muted">{t('hrWarn.mine.lead', { name: first.supervisorName || '—', date: day(first.issuedOn) })}</div>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setOpenId(first.id)}>{t('hrWarn.mine.open')}</button>
        </div>
      )}
      <Modal open={!!openId} onClose={close} title={t('hrWarn.detail.title')} size="lg">
        {openId && (
          <HrWarningDetail key={openId} warningId={openId} mode="employee" users={users} currentUserId={userId}
            onChanged={load} onClose={close} />
        )}
      </Modal>
    </>
  );
}
