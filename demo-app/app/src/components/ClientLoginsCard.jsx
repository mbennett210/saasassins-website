import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePermission } from '../hooks/usePermission';
import { useToast } from '../components/Toast';
import { useFromHere } from '../hooks/useFromHere';
import { useT } from '../i18n/react';
import Badge from './Badge';
import Icon from './Icon';
import ConfirmDialog from './ConfirmDialog';
import { SignInLinkModal } from './SignInLinkPanel';
import { whoCanSee, inviteClientUser, isClientHubStub } from '../lib/clientHubApi';

// "WHO CAN SEE THIS BUILDING?" — the customer page's client-logins panel (HUB-3/HUB-4).
//
// Two lists, deliberately separate: people granted this building DIRECTLY, and people who
// reach it THROUGH a group (a management company's portfolio, a city). The office has to
// see which, because removing someone from a building they hold through a city group does
// nothing — the edit they want is on the group.
//
// Everything here is server-only data (its own tables), so this fetches; the editing itself
// lives on Settings → Customer Logins rather than being duplicated into every customer page.
const STATUS_BADGE = { active: 'green', invited: 'amber', disabled: 'slate' };

export default function ClientLoginsCard({ clientId }) {
  const canView = usePermission('hub.users.view');
  const canManage = usePermission('hub.users.manage');
  const toast = useToast();
  const t = useT();
  const nav = useFromHere();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reinvite, setReinvite] = useState(null);   // the contact a re-invite is asked for
  // An invite nothing was emailed for (CS-709): { user, link, why, replaces } — the one-time link to
  // hand over, as Settings → Customer logins shows it. Component state only, never stored.
  const [handed, setHanded] = useState(null);

  useEffect(() => {
    if (!canView || isClientHubStub() || !clientId) return undefined;
    let alive = true;
    whoCanSee(clientId)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e?.message || 'Could not load customer logins.'); });
    return () => { alive = false; };
  }, [canView, clientId]);

  if (!canView || isClientHubStub()) return null;

  const direct = data?.direct || [];
  const viaGroup = data?.viaGroup || [];
  const none = data !== null && direct.length === 0 && viaGroup.length === 0;

  // The invite's answer, read whole (CS-709): it said "Invite sent" whatever happened, and the
  // one-time link was lost while no mailbox can send — the live app today.
  const resend = async (u) => {
    setBusy(true);
    try {
      const out = await inviteClientUser(u.id);
      if (out?.invited === false) {
        if (out.link) setHanded({ user: u, link: out.link, why: out.why, replaces: !!u.hasLogin });
        else toast.error(t('clientLogins.noLink'));
      } else {
        toast.success(t('clientLogins.inviteEmailed', { email: u.email }));
      }
    } catch (e) {
      toast.error(e?.message || 'Could not send the invite.');
    } finally {
      setBusy(false);
    }
  };

  const row = (u, note) => (
    <div key={`${u.id}-${note || ''}`} className="clh-row">
      <div className="clh-row-main">
        <span className="clh-row-name truncate" title={u.name}>{u.name}</span>
        <span className="text-xs text-muted truncate" title={u.email}>{u.email}</span>
        {note && <span className="text-xs text-muted">{note}</span>}
      </div>
      <div className="clh-row-side">
        <Badge variant={STATUS_BADGE[u.status] || 'slate'}>
          {u.status.charAt(0).toUpperCase() + u.status.slice(1)}
        </Badge>
        {canManage && u.status !== 'disabled' && (
          <button type="button" className="btn btn-outline" disabled={busy} onClick={() => (u.hasLogin ? setReinvite(u) : resend(u))}>
            {u.hasLogin ? 'Re-invite' : 'Invite'}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="card detail-card">
      <div className="overview-card-head">
        <h3>Customer logins</h3>
        {canManage && (
          <Link className="btn btn-outline" to="/settings/client-logins" state={nav}>Manage</Link>
        )}
      </div>
      {error && <p className="text-sm login-msg-error">{error}</p>}
      {data === null && !error && <p className="text-xs text-muted">Loading…</p>}
      {none && (
        <p className="text-xs text-muted">
          Nobody on the customer&rsquo;s side can sign in to see this building yet.
          {canManage && ' Add them under Settings → Customer Logins.'}
        </p>
      )}
      {direct.length > 0 && (
        <div className="clh-group">
          <div className="clh-group-head text-xs">Assigned directly</div>
          {direct.map((u) => row(u, null))}
        </div>
      )}
      {viaGroup.length > 0 && (
        <div className="clh-group">
          <div className="clh-group-head text-xs">Through a group</div>
          {viaGroup.map((u) => row(u, `via ${u.groupName}`))}
        </div>
      )}
      {viaGroup.length > 0 && (
        <p className="text-xs text-muted">
          <Icon name="lock" size={12} /> Remove someone from a group under Settings → Customer Logins —
          taking them off this building alone will not change what they see.
        </p>
      )}
      {/* A re-invite makes a NEW link, which voids the one sent before (one per login): said first. */}
      <ConfirmDialog
        open={!!reinvite}
        title={t('clientLogins.reinvite.title', { name: reinvite?.name || '' })}
        message={t('clientLogins.reinvite.message')}
        confirmLabel={t('clientLogins.reinvite.confirm')}
        onClose={() => setReinvite(null)}
        onConfirm={() => resend(reinvite)}
      />
      <SignInLinkModal
        open={!!handed}
        onClose={() => setHanded(null)}
        name={handed?.user?.name}
        link={handed?.link}
        why={handed?.why}
        replaces={!!handed?.replaces}
      />
    </div>
  );
}
