// Inboxes tab — connected marketing rotation inboxes.
// Each row: email, displayName, status badge, rotation position, Enabled
// toggle, per-inbox daily send limit, ↑↓ reorder, Disconnect. A dashed
// "ghost" line below the list opens the connect modal — and is the sole
// element shown when nothing is connected yet. Connect is also driven by
// the parent page head (ConnectMarketingInboxModal). Mirrors the
// ConnectedInboxes settings page row layout but reads from
// state.marketingInboxes.

import { useState } from 'react';
import { useStore, useDispatch } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { selectMarketingInboxes } from '../../store/selectors';
import { usePermission } from '../../hooks/usePermission';
import { useToast } from '../../components/Toast';
import { disconnectInbox } from '../../lib/connectedInboxes';
import Badge from '../../components/Badge';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import Toggle from '../../components/Toggle';
import ConfirmDialog from '../../components/ConfirmDialog';
import ConnectMarketingInboxModal from '../../components/ConnectMarketingInboxModal';
import InboxSignatureModal from './InboxSignatureModal';

const STATUS_VARIANTS = { active: 'green', pending: 'amber', expired: 'amber', error: 'red' };

// Emails an inbox sends per day before the scheduler holds it back. Kept in
// sync with the reducer default on ADD_MARKETING_INBOX.
const DEFAULT_DAILY_LIMIT = 10;

export default function InboxesTab({ connectOpen, onOpenConnect, onCloseConnect }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const canConnect = usePermission('marketing.connectInbox');
  const inboxes = [...selectMarketingInboxes(state)].sort(
    (a, b) => (a.rotationOrder ?? 0) - (b.rotationOrder ?? 0)
  );
  const [confirmDisconnect, setConfirmDisconnect] = useState(null);
  const [signatureInbox, setSignatureInbox] = useState(null);

  function move(inbox, dir) {
    const ids = inboxes.map((i) => i.id);
    const idx = ids.indexOf(inbox.id);
    const swap = idx + dir;
    if (swap < 0 || swap >= ids.length) return;
    [ids[idx], ids[swap]] = [ids[swap], ids[idx]];
    dispatch({ type: ACTIONS.REORDER_MARKETING_INBOXES, ids });
  }

  function toggleEnabled(inbox) {
    dispatch({ type: ACTIONS.UPDATE_MARKETING_INBOX, id: inbox.id, patch: { enabled: !(inbox.enabled !== false) } });
  }

  function setDailyLimit(inbox, limit) {
    dispatch({ type: ACTIONS.UPDATE_MARKETING_INBOX, id: inbox.id, patch: { dailySendLimit: limit } });
  }

  async function doDisconnect(inbox) {
    try {
      await disconnectInbox(inbox.id);
    } catch {
      // Stub mode never throws; in hosted mode a failed backend call still
      // shouldn't strand the row — remove it locally regardless.
    }
    dispatch({ type: ACTIONS.REMOVE_MARKETING_INBOX, id: inbox.id });
    toast.success(`Disconnected ${inbox.email}`);
  }

  // The ghost line carries the "add" affordance — including as the sole
  // element when nothing is connected yet. Only when the user can't connect
  // AND there's nothing to show do we fall back to the informational empty
  // state (there's no action they could take).
  const showEmptyState = inboxes.length === 0 && !canConnect;

  return (
    <>
      <div className="info-banner">
        <Icon name="building" size={18} />
        <div>
          <strong>These are shared marketing accounts — not anyone's personal email.</strong>{' '}
          The Gmail inboxes connected here send for marketing sequences only and
          are shared by the whole team. They're separate from the per-user
          mailboxes each person connects under Settings → Connected Inboxes for
          1:1 Messaging.
        </div>
      </div>
      <p className="marketing-tab-intro">
        These mailboxes rotate for marketing sends. Each sequence sends through
        Position 1, then Position 2, and so on — wrapping back to the top;
        disabled inboxes are skipped. Each inbox sends up to its own daily
        limit — {DEFAULT_DAILY_LIMIT}/day by default. Raise it cautiously:
        sending too much too fast from a mailbox, especially a newly connected
        one, hurts your sender reputation and can land emails in spam.
      </p>

      {showEmptyState ? (
        <EmptyState
          icon={<Icon name="mail" size={32} />}
          title="No marketing inboxes connected"
          message="Connect at least one Gmail inbox before activating a sequence. Sends rotate across every connected inbox."
        />
      ) : (
        <div className="marketing-inbox-list">
          {inboxes.map((inbox, idx) => (
            <InboxRow
              key={inbox.id}
              inbox={inbox}
              idx={idx}
              total={inboxes.length}
              canConnect={canConnect}
              onMove={move}
              onToggleEnabled={toggleEnabled}
              onSetDailyLimit={setDailyLimit}
              onEditSignature={setSignatureInbox}
              onConfirmDisconnect={setConfirmDisconnect}
            />
          ))}
          {canConnect && (
            <button type="button" className="marketing-inbox-ghost" onClick={onOpenConnect}>
              <span className="marketing-inbox-ghost-icon"><Icon name="mail" size={18} /></span>
              <span>Add new inbox</span>
            </button>
          )}
        </div>
      )}

      <ConnectMarketingInboxModal open={connectOpen} onClose={onCloseConnect} />
      <InboxSignatureModal
        key={signatureInbox?.id || 'sig-closed'}
        open={Boolean(signatureInbox)}
        inbox={signatureInbox}
        onClose={() => setSignatureInbox(null)}
      />
      <ConfirmDialog
        open={Boolean(confirmDisconnect)}
        title="Disconnect inbox?"
        message={confirmDisconnect
          ? `${confirmDisconnect.email} will be removed from the rotation. Sequences will continue sending through the remaining inboxes.`
          : ''}
        confirmLabel="Disconnect"
        variant="danger"
        onConfirm={() => confirmDisconnect && doDisconnect(confirmDisconnect)}
        onClose={() => setConfirmDisconnect(null)}
      />
    </>
  );
}

// One connected inbox. Holds local draft state for the daily-limit field so
// the user can clear and retype freely; the edit commits to the store on blur
// (or Enter). An empty field on blur keeps the previous value.
function InboxRow({ inbox, idx, total, canConnect, onMove, onToggleEnabled, onSetDailyLimit, onEditSignature, onConfirmDisconnect }) {
  const storedLimit = Number.isFinite(Number(inbox.dailySendLimit))
    ? Number(inbox.dailySendLimit)
    : DEFAULT_DAILY_LIMIT;
  // null = not editing → mirror the stored value; a string while editing.
  const [limitDraft, setLimitDraft] = useState(null);
  const limitValue = limitDraft === null ? String(storedLimit) : limitDraft;

  function commitLimit() {
    const raw = (limitDraft ?? '').trim();
    setLimitDraft(null);
    if (raw === '') return; // empty → keep the stored value
    const n = Math.max(1, Math.round(Number(raw)));
    if (Number.isFinite(n) && n !== storedLimit) onSetDailyLimit(inbox, n);
  }

  return (
    <div className="card marketing-inbox-row">
      <div className="marketing-inbox-main">
        <div className="marketing-inbox-icon"><Icon name="mail" size={18} /></div>
        <div className="marketing-inbox-text">
          <div className="marketing-inbox-email">{inbox.email}</div>
          <div className="marketing-inbox-sub">
            {inbox.senderName ? <>{inbox.senderName} · </> : null}Position {idx + 1} of {total}
          </div>
        </div>
        <Badge variant={STATUS_VARIANTS[inbox.status] || 'slate'}>
          {inbox.status === 'active' ? 'Connected' : inbox.status}
        </Badge>
      </div>
      <div className="marketing-inbox-controls">
        <div className="marketing-inbox-enabled">
          <span className="marketing-inbox-enabled-label">
            {inbox.enabled !== false ? 'In rotation' : 'Paused'}
          </span>
          <Toggle on={inbox.enabled !== false} onChange={() => onToggleEnabled(inbox)} />
        </div>
        <div className="marketing-inbox-limit">
          <label className="marketing-inbox-limit-label" htmlFor={`inbox-limit-${inbox.id}`}>
            Daily limit
          </label>
          <input
            id={`inbox-limit-${inbox.id}`}
            type="number"
            min="1"
            className="marketing-inbox-limit-input"
            title="Max emails this inbox sends per day"
            value={limitValue}
            onChange={(e) => setLimitDraft(e.target.value)}
            onBlur={commitLimit}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          />
        </div>
        <button
          type="button"
          className="btn btn-outline"
          onClick={() => onEditSignature(inbox)}
        >
          {(inbox.senderName || inbox.signature) ? 'Edit profile' : 'Set up profile'}
        </button>
        <div className="marketing-inbox-reorder">
          <button
            type="button"
            className="btn-icon"
            aria-label="Move up"
            onClick={() => onMove(inbox, -1)}
            disabled={idx === 0}
          >
            <Icon name="chevronUp" size={16} />
          </button>
          <button
            type="button"
            className="btn-icon"
            aria-label="Move down"
            onClick={() => onMove(inbox, 1)}
            disabled={idx === total - 1}
          >
            <Icon name="chevronDown" size={16} />
          </button>
        </div>
        {canConnect && (
          <button className="btn btn-outline" onClick={() => onConfirmDisconnect(inbox)}>
            Disconnect
          </button>
        )}
      </div>
    </div>
  );
}
