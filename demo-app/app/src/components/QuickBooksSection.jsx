// Settings → Integrations · QuickBooks Online.
//
// Read-only QuickBooks Online feed for the property P&L dashboards (CS-066, slice 2). Connect
// / disconnect / refresh / link / unlink / list-entities are OWNER-ONLY (the server gates them
// requireRole(['owner']) — the whole company's books are an authority surface, not a matrix
// capability); this component mirrors that by rendering those controls only when the resolved
// current user is an owner. Other integrations.view holders see read-only status. The server
// re-checks every call, so this UI gate is a courtesy, never the boundary (decision 1).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { usePermission } from '../hooks/usePermission';
import { useDispatch, useSelector } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectClients, selectUsers } from '../store/selectors';
import { numberFromQuickBooks, quickBooksNumberPlan, customerLabel } from '../lib/customerNumber';
import { useToast } from './Toast';
import { usePagedRows } from '../hooks/usePagedRows';
import ListPager from './ListPager';
import Badge from './Badge';
import Icon from './Icon';
import Modal from './Modal';
import ConfirmDialog from './ConfirmDialog';
import FilterSelect from './FilterSelect';
import EmptyState from './EmptyState';
import { fmtDateLong, fmtTime } from '../lib/dates';
import {
  getQboStatus, connectQbo, disconnectQbo, refreshQbo,
  listQboLinks, linkQboProperty, unlinkQboProperty, listQboEntities,
} from '../lib/qboApi';
import { realmDimension } from '../lib/qboRules';
import { useT } from '../i18n/react';
import QboMatchingCard from './QboMatchingCard';

// QBO dimension ↔ UI label. "Location" is the API's `department` (decision 2 / the build spec).
const DIMENSIONS = [
  { value: 'customer', label: 'Customer' },
  { value: 'class', label: 'Class' },
  { value: 'department', label: 'Location' },
];
const dimLabel = (v) => (DIMENSIONS.find((d) => d.value === v) || {}).label || v;
const whenText = (iso) => (iso ? `${fmtDateLong(iso)}, ${fmtTime(iso)}` : '—');

// The words that say why the dimension is fixed (CS-565), one whole sentence per dimension.
const LOCKED_NOTE_KEY = { customer: 'qbo.link.lockedCustomer', class: 'qbo.link.lockedClass', department: 'qbo.link.lockedLocation' };

// The Link-a-property flow: pick a CRM customer, a QBO dimension, then the QBO entity. Typed
// selections survive a failed save (the modal only closes on success) — DEV_PLAYBOOK 3.8.
// `links` are the company's active links: once another property is linked, the dimension is
// fixed to theirs (CS-565: one dimension per company, or the same money counts twice).
// `preset` ({ clientId, entityType, entityId }) opens it filled in — the "needs matching" list's
// Link… (QB-12): its QuickBooks customer and the suggested customer here, or one of the two.
function LinkPropertyModal({ open, onClose, clients, links = [], preset = null, onSaved }) {
  const t = useT();
  const toast = useToast();
  const [clientId, setClientId] = useState('');
  const [dimension, setDimension] = useState('customer');
  const [entities, setEntities] = useState([]);
  const [entitiesLoading, setEntitiesLoading] = useState(false);
  const [entityId, setEntityId] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  // Reset when the modal (re)opens. It stays mounted between opens, and a successful save
  // leaves `saving` true, so it must be cleared here too, or the next open shows a stuck,
  // disabled "Saving…" button (test-qbo-link-form.mjs).
  useEffect(() => {
    if (open) { setClientId(preset?.clientId || ''); setDimension(preset?.entityType || 'customer'); setEntityId(preset?.entityId || ''); setErr(null); setSaving(false); }
  }, [open, preset]);

  // The other properties' dimension (this one's own link is being replaced, so it doesn't count).
  const lockedDimension = useMemo(
    () => realmDimension((links || []).filter((l) => l.active !== false && l.clientId !== clientId)),
    [links, clientId],
  );
  useEffect(() => {
    if (open && lockedDimension) setDimension(lockedDimension);
  }, [open, lockedDimension]);

  // Load the QBO entities for the chosen dimension (ignore a stale response — 3.8.14). The chosen
  // entity is cleared where the dimension is CHANGED (its button), not here, so a preset survives.
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setEntitiesLoading(true);
    listQboEntities(dimension)
      .then((r) => { if (alive) setEntities(r.entities || []); })
      .catch(() => { if (alive) setEntities([]); })
      .finally(() => { if (alive) setEntitiesLoading(false); });
    return () => { alive = false; };
  }, [open, dimension]);

  const clientOptions = useMemo(
    () => [{ value: '', label: 'Select a property…' }, ...(clients || []).map((c) => ({ value: c.id, label: customerLabel(c) }))],
    [clients],
  );
  const entityOptions = useMemo(() => {
    const head = { value: '', label: entitiesLoading ? 'Loading…' : `Select a QuickBooks ${dimLabel(dimension)}…` };
    return [head, ...entities.map((e) => ({ value: e.id, label: e.active === false ? `${e.name} (inactive)` : e.name }))];
  }, [entities, entitiesLoading, dimension]);

  const save = async () => {
    setErr(null);
    if (!clientId) { setErr('Choose a property.'); return; }
    if (!entityId) { setErr(`Choose a QuickBooks ${dimLabel(dimension)}.`); return; }
    const ent = entities.find((e) => e.id === entityId);
    setSaving(true);
    try {
      await linkQboProperty({ clientId, entityType: dimension, entityId, entityName: ent?.name || null });
      toast.success('Property linked.');
      onSaved({ clientId, entityType: dimension, entityName: ent?.name || null });
    } catch (e) {
      setErr(e.message || 'Could not save the link.'); // keep the modal + the typed values
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Link a property" size="sm">
      <div className="qbo-linkform">
        <div className="qbo-field">
          <span className="form-label">Property (customer)</span>
          <FilterSelect value={clientId} onChange={setClientId} options={clientOptions} ariaLabel="Property" />
        </div>
        <div className="qbo-field">
          <span className="form-label">QuickBooks dimension</span>
          <div className="segmented" role="group" aria-label="QuickBooks dimension">
            {DIMENSIONS.map((d) => (
              <button
                key={d.value}
                type="button"
                className={`segmented-btn ${dimension === d.value ? 'active' : ''}`}
                onClick={() => { if (d.value !== dimension) { setDimension(d.value); setEntityId(''); } }}
                disabled={!!lockedDimension && d.value !== lockedDimension}
              >
                {d.label}
              </button>
            ))}
          </div>
          {lockedDimension && <div className="form-help">{t(LOCKED_NOTE_KEY[lockedDimension])}</div>}
        </div>
        <div className="qbo-field">
          <span className="form-label">QuickBooks {dimLabel(dimension)}</span>
          <FilterSelect value={entityId} onChange={setEntityId} options={entityOptions} ariaLabel="QuickBooks entity" />
        </div>
        {err && <div className="form-error">{err}</div>}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Link property'}</button>
      </div>
    </Modal>
  );
}

export default function QuickBooksSection() {
  const t = useT();
  const { currentUser } = useAuth();
  const isOwner = currentUser?.role === 'owner';
  const clients = useSelector(selectClients);
  const users = useSelector(selectUsers);
  const toast = useToast();

  const [phase, setPhase] = useState('loading'); // loading | ready | error
  const [loadErr, setLoadErr] = useState(null);
  const [status, setStatus] = useState(null);
  const [links, setLinks] = useState([]);

  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(null); // clientId pending unlink
  const [unlinking, setUnlinking] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  // What the Link dialog opens filled in with (the needs-matching list's Link…), and a counter
  // that has that list read again after a link (QB-12).
  const [linkPreset, setLinkPreset] = useState(null);
  const [matchKey, setMatchKey] = useState(0);
  const openLink = (preset = null) => { setLinkPreset(preset); setLinkOpen(true); };

  const load = useCallback(async () => {
    setPhase('loading'); setLoadErr(null);
    try {
      const st = await getQboStatus();
      setStatus(st);
      if (isOwner && st.connected) {
        const l = await listQboLinks();
        setLinks(l.links || []);
      } else {
        setLinks([]);
      }
      setPhase('ready');
    } catch (e) {
      setLoadErr(e); setPhase('error');
    }
  }, [isOwner]);
  useEffect(() => { load(); }, [load]);

  const clientsById = useMemo(() => new Map((clients || []).map((c) => [c.id, c])), [clients]);
  const activeLinks = useMemo(() => links.filter((l) => l.active !== false), [links]);
  const pager = usePagedRows(activeLinks, { resetKey: `${activeLinks.length}` });

  // GO-2 / CS-068: a QuickBooks customer's own number ("0001 …") becomes the linked customer's —
  // QuickBooks is the record — through the one rule (lib/customerNumber.js). Never invented when
  // QuickBooks has none; refused, naming the holder, when another customer has it. A write to the
  // customer, so it follows clients.edit like any other edit of one.
  const dispatch = useDispatch();
  const canEditClients = usePermission('clients.edit');
  const applyQuickBooksNumber = ({ clientId, entityType, entityName }) => {
    if (entityType !== 'customer' || !canEditClients) return;
    const client = clientsById.get(clientId);
    const { number, conflict } = numberFromQuickBooks(clients, clientId, entityName);
    if (!client || !number || client.customerNumber === number) return;
    if (conflict) { toast.error(t('qbo.number.conflict', { number, customer: customerLabel(conflict) })); return; }
    dispatch({ type: ACTIONS.UPDATE_CLIENT, id: clientId, patch: { customerNumber: number } });
    toast.success(t('qbo.number.applied', { number, customer: client.name || number }));
  };
  // The links made before numbers existed: which customers take their QuickBooks number now.
  const numberPlan = useMemo(() => quickBooksNumberPlan(clients, activeLinks), [clients, activeLinks]);
  const applyAllNumbers = () => {
    for (const step of numberPlan.apply) dispatch({ type: ACTIONS.UPDATE_CLIENT, id: step.clientId, patch: { customerNumber: step.number } });
    toast.success(t('qbo.number.appliedMany', { count: numberPlan.apply.length }));
  };

  const handleConnect = async () => {
    setConnecting(true);
    try {
      await connectQbo();
      toast.success('QuickBooks connected.');
      // QB-10: pull the last twelve months (every window) right away, so the dashboards show
      // them now rather than after tonight's refresh. Best effort: a gap fills tonight.
      try { await refreshQbo(); } catch { /* the nightly refresh fills it */ }
      await load();
    } catch (e) { toast.error(e.message || 'Could not connect QuickBooks.'); }
    finally { setConnecting(false); }
  };
  const handleRefresh = async () => {
    setRefreshing(true);
    try { await refreshQbo(); toast.success(t('qbo.refresh.done')); await load(); }
    catch (e) { toast.error(e.message || 'Could not refresh.'); await load(); }
    finally { setRefreshing(false); }
  };
  const handleDisconnect = async () => {
    setConfirmDisconnect(false); setDisconnecting(true);
    try { await disconnectQbo(); toast.success('QuickBooks disconnected.'); await load(); }
    catch (e) { toast.error(e.message || 'Could not disconnect.'); }
    finally { setDisconnecting(false); }
  };
  const handleUnlink = async () => {
    const clientId = confirmUnlink; setConfirmUnlink(null); setUnlinking(true);
    try { await unlinkQboProperty(clientId); toast.success('Property unlinked.'); await load(); }
    catch (e) { toast.error(e.message || 'Could not unlink.'); }
    finally { setUnlinking(false); }
  };

  // ── loading / error ──
  if (phase === 'loading') {
    return (
      <div className="card detail-card qbo-card">
        <h3 className="dash-card-title"><Icon name="chart" size={16} /> QuickBooks Online</h3>
        <div className="text-sm text-muted">Loading…</div>
      </div>
    );
  }
  if (phase === 'error') {
    return (
      <div className="card detail-card qbo-card">
        <h3 className="dash-card-title"><Icon name="chart" size={16} /> QuickBooks Online</h3>
        <div className="form-error qbo-note">{loadErr?.message || 'Could not load the QuickBooks status.'}</div>
        <div className="qbo-actions qbo-actions-start">
          <button type="button" className="btn btn-outline" onClick={load}>Try again</button>
        </div>
      </div>
    );
  }

  const connected = !!status?.connected;
  const configured = status?.configured !== false;
  const reauth = !!status?.reauthRequired;
  const isSandbox = status?.environment === 'sandbox';
  // CS-569: the server sends who connected as a team-member id; the name comes from the roster
  // (the demo stub sends a ready name).
  const connectedByName = status?.connectedByName
    || (status?.connectedBy ? (users || []).find((u) => u.id === status.connectedBy)?.name : null)
    || null;
  // An unfinished nightly refresh (QB-9) is said in words; any other code is shown as it is.
  const lastErrorText = status?.lastError === 'refresh_incomplete' ? t('qbo.status.refreshIncomplete') : status?.lastError;

  return (
    <>
      {/* ── Connection ── */}
      <div className="card detail-card qbo-card">
        <div className="qbo-card-head">
          <div className="qbo-card-body">
            <h3 className="dash-card-title">
              <Icon name="chart" size={16} /> QuickBooks Online
              {connected
                ? (reauth
                  ? <Badge variant="amber">Reconnect required</Badge>
                  : <Badge variant="green">Connected</Badge>)
                : <Badge variant="slate">{configured ? 'Not connected' : 'Not configured'}</Badge>}
              {connected && isSandbox && <Badge variant="amber">Sandbox</Badge>}
              {connected && status?.environment === 'production' && <Badge variant="green">Production</Badge>}
            </h3>
            {connected ? (
              <div className="text-sm text-muted">
                {status.companyName && <><strong>{status.companyName}</strong>{isSandbox ? ' · test data' : ''}<br /></>}
                {connectedByName ? <>Connected by {connectedByName} · </> : null}
                Connected {whenText(status.connectedAt)}
                {status.lastSyncedAt && <> · Last refresh {whenText(status.lastSyncedAt)}</>}
                <br />{t('qbo.status.nightly')}
                {reauth && <div className="form-error qbo-note">The QuickBooks authorization expired. Reconnect to resume the profit &amp; loss feed.</div>}
              </div>
            ) : configured ? (
              <div className="text-sm text-muted">
                {isOwner
                  ? 'Connect QuickBooks Online to show each linked property’s profit & loss on the manager dashboards.'
                  : 'QuickBooks is not connected. Only a Super Admin can connect it.'}
              </div>
            ) : (
              <div className="text-sm text-muted">
                QuickBooks Online is not configured for this deployment. It will be available once the QuickBooks
                app credentials are provisioned.
              </div>
            )}
            {status?.lastError && !reauth && (
              <div className="form-error qbo-note">Last error: {lastErrorText}</div>
            )}
          </div>
          {isOwner && (
            <div className="qbo-actions">
              {!connected && configured && (
                <button className="btn btn-primary" onClick={handleConnect} disabled={connecting}>{connecting ? 'Connecting…' : 'Connect'}</button>
              )}
              {connected && reauth && (
                <button className="btn btn-primary" onClick={handleConnect} disabled={connecting}>{connecting ? 'Reconnecting…' : 'Reconnect'}</button>
              )}
              {connected && !reauth && (
                <button className="btn btn-outline" onClick={handleRefresh} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh data'}</button>
              )}
              {connected && (
                <button className="btn btn-outline" onClick={() => setConfirmDisconnect(true)} disabled={disconnecting}>{disconnecting ? 'Disconnecting…' : 'Disconnect'}</button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Linked properties (owner, when connected) ── */}
      {isOwner && connected && (
        <div className="card detail-card qbo-card">
          <div className="qbo-linked-head">
            <h3 className="dash-card-title qbo-title-flush"><Icon name="building" size={16} /> Linked properties</h3>
            <div className="qbo-actions">
              {canEditClients && numberPlan.apply.length > 0 && (
                <button type="button" className="btn btn-outline" onClick={applyAllNumbers}>
                  {t('qbo.number.applyAll', { count: numberPlan.apply.length })}
                </button>
              )}
              <button className="btn btn-primary" onClick={() => openLink(null)}>Link a property</button>
            </div>
          </div>
          {numberPlan.conflicts.length > 0 && (
            <div className="form-help qbo-note">{t('qbo.number.conflictNote', { count: numberPlan.conflicts.length })}</div>
          )}
          {activeLinks.length === 0 ? (
            <EmptyState
              title="No properties linked yet"
              message="Link a property to a QuickBooks customer, class or location so its profit & loss shows on the dashboard."
            />
          ) : (
            <>
              <div className="table-wrap mobile-stack">
                <table>
                  <thead>
                    <tr>
                      <th>Property</th>
                      <th>Dimension</th>
                      <th>QuickBooks entity</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pager.pageRows.map((l) => {
                      const linked = clientsById.get(l.clientId);
                      const name = (linked && customerLabel(linked)) || l.clientName || l.clientId;
                      return (
                        <tr key={l.clientId}>
                          <td className="cell-primary" data-label="Property"><span className="name">{name}</span></td>
                          <td data-label="Dimension">
                            <Badge variant="slate">{dimLabel(l.entityType)}</Badge>
                            {/* CS-565: linked on another dimension than the rest (before that rule),
                                so its money is left out of every book rather than counted twice. */}
                            {l.counted === false && <Badge variant="amber" title={t('qbo.links.notCountedHint')}>{t('qbo.links.notCounted')}</Badge>}
                          </td>
                          <td data-label="QuickBooks entity">{l.entityName || l.entityId}</td>
                          <td className="text-right" data-label="">
                            <button type="button" className="btn btn-outline btn-sm" onClick={() => setConfirmUnlink(l.clientId)} disabled={unlinking}>
                              <Icon name="trash" size={13} /> Unlink
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <ListPager pager={pager} noun="properties" />
            </>
          )}
        </div>
      )}

      {/* ── Needs matching (QB-12): anyone who sees QuickBooks here, when it is connected. A list
          table under its own header, not boxed in a card (UI_RULES §72). ── */}
      {connected && <QboMatchingCard isOwner={isOwner} onLink={openLink} reloadKey={matchKey} />}

      <LinkPropertyModal
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        clients={clients}
        links={activeLinks}
        preset={linkPreset}
        onSaved={(linkedTo) => { setLinkOpen(false); applyQuickBooksNumber(linkedTo); load(); setMatchKey((k) => k + 1); }}
      />
      <ConfirmDialog
        open={confirmDisconnect}
        title="Disconnect QuickBooks?"
        message="The manager dashboards will stop showing live profit & loss until QuickBooks is reconnected. Your property links are kept."
        confirmLabel="Disconnect"
        variant="danger"
        onConfirm={handleDisconnect}
        onClose={() => setConfirmDisconnect(false)}
      />
      <ConfirmDialog
        open={!!confirmUnlink}
        title="Unlink this property?"
        message="Its profit & loss will no longer appear on the dashboard. You can re-link it at any time."
        confirmLabel="Unlink"
        variant="danger"
        onConfirm={handleUnlink}
        onClose={() => setConfirmUnlink(null)}
      />
    </>
  );
}
