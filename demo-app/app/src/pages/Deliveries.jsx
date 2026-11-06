// Deliveries — the driver's page (Matt, SUP-16 a + SUP-17 a, 2026-10-12: "Alberto, who's our
// delivery driver, would mark it delivered when it's delivered to the property"; plan 2026-10-12
// §2, S4; PER LINE since S131, Daniel's answer 1). PHONE FIRST: a driver reads it in the van.
//
// Every order with the supplier that still has something to come, grouped by building — its name
// and address, then each drop: its number, each LINE still to come (how many, and a backorder with
// its ETA) with its own Delivered, and "All delivered" for the whole drop, each behind one
// confirmation that names the building, with an optional photo of the drop-off. Each line is
// stamped with the driver's name and the time (`via: driver`); the person who asked and the
// building's account manager are told (lib/supplyFlow); the cleaners there see "Delivered today at
// …". Completing the order is the Supply Manager's, never the driver's. Below: today's deliveries.
//
// 🔴 NO MONEY ANYWHERE (S3: "Holding it reveals no prices and no budgets"). The page reads ONE
// route (GET /api/supplies/deliveries, gated on supplies.deliver), whose answer is built field by
// field with no price, total or budget in it (lib/supplies supplyDeliveryList), and Delivered's
// answer carries no order. This file imports no money formatter, so nothing here can show one.
//
// Who sees it: `supplies.deliver` — the owner and admin by default, and anyone given the key by a
// per-person grant (a driver on a crew login), in the nav and the phone menu (lib/navData).
// Offline is honest: nothing is kept on the phone, so "No signal" is said and Delivered is off
// until there is one (UI_RULES §131). Every word is a catalog line (`deliveries.*`, UI_RULES §140);
// building names, addresses, item names and people's names travel as written.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { useAuth } from '../hooks/useAuth';
import { usePermission } from '../hooks/usePermission';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useTableSearch } from '../hooks/useTableSearch';
import { usePagedRows } from '../hooks/usePagedRows';
import { searchRows } from '../lib/searchRows';
import * as suppliesApi from '../lib/suppliesApi';
import { useToast } from '../components/Toast';
import Icon from '../components/Icon';
import EmptyState from '../components/EmptyState';
import Modal from '../components/Modal';
import FormField from '../components/FormField';
import Badge from '../components/Badge';
import { uploadMedia } from '../lib/accountMediaApi';
import { supplyEtaInstant, SUPPLY_LINE_STATE } from '../lib/supplies';
import TableSearch from '../components/TableSearch';
import ListPager from '../components/ListPager';
import { useT } from '../i18n/react';

// The submitted orders, one group per building, in the order the van is loaded (the oldest
// submitted first — the route's order), each building's drops in that order too.
function byBuilding(toDeliver) {
  const groups = new Map();
  for (const r of Array.isArray(toDeliver) ? toDeliver : []) {
    const key = r.clientId || r.id;
    if (!groups.has(key)) groups.set(key, { clientId: key, building: r.building || { name: '', address: '' }, requests: [] });
    groups.get(key).requests.push(r);
  }
  return [...groups.values()];
}

export default function Deliveries() {
  const t = useT();
  const toast = useToast();
  const state = useStore();
  const online = useOnlineStatus() !== false;
  const { currentUser } = useAuth();
  const canDeliver = usePermission('supplies.deliver');
  // What the demo stub reads to judge like the route does (the real route reads the claim).
  const ctx = useMemo(() => ({ state, user: currentUser, holds: { deliver: canDeliver } }), [state, currentUser, canDeliver]);

  const [data, setData] = useState(null); // { dayKey, toDeliver, deliveredToday } | null while loading
  const [err, setErr] = useState(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    setErr(null);
    suppliesApi.deliveries(ctx)
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setErr(e); });
    return () => { live = false; };
    // ctx carries the store for the demo stub; the real read keys on nothing but a reload
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const groups = useMemo(() => byBuilding(data ? data.toDeliver : []), [data]);
  const [q, setQ] = useTableSearch('q');
  const found = useMemo(() => searchRows(groups, q, (g) => [
    g.building.name, g.building.address, ...g.requests.flatMap((r) => (r.items || []).map((it) => `${it.name} ${it.sku || ''}`)),
  ].join(' ')), [groups, q]);
  const pager = usePagedRows(found, { param: 'p', resetKey: q });
  const delivered = useMemo(() => (data ? data.deliveredToday : []), [data]);
  const todayPager = usePagedRows(delivered, { param: 'dp' });

  // Delivered — one line, or every line still to come on a drop ("All delivered"): one confirmation
  // naming the building (with an optional photo), then ONE call on the version the list showed,
  // behind an in-flight guard so a double tap sends once.
  const [confirm, setConfirm] = useState(null);   // { r, building, line | null }
  const busy = useRef(false);
  const [working, setWorking] = useState(false);
  async function deliver({ r, building, line }, photo) {
    if (busy.current || !online) return;
    busy.current = true; setWorking(true);
    try {
      await suppliesApi.deliverRequests({ id: r.id, version: r.version, lines: line ? [line.line] : null }, ctx);
      toast.success(t('deliveries.toast.done', { building: building.name || '—' }));
      if (photo) {
        try { await uploadMedia(photo, { siteId: null, clientId: r.clientId, scope: 'supply', refId: r.id }); }
        catch { toast.error(t('deliveries.toast.photoFailed')); }
      }
      setConfirm(null);
      reload();
    } catch (e) {
      // Moved since the list was read (stale, already delivered, taken back): say so and re-read.
      if (e && (e.status === 409 || e.status === 404)) { toast.info(t('deliveries.toast.moved')); setConfirm(null); reload(); }
      else toast.error(t('deliveries.toast.failed'));
    } finally {
      busy.current = false; setWorking(false);
    }
  }

  const toDeliverCount = data ? data.toDeliver.length : 0;
  return (
    <div className="page page-narrow">
      <div className="page-head">
        <div className="page-head-text">
          <h1>{t('deliveries.title')}</h1>
          <p className="page-sub">{data ? t.rich('deliveries.sub', { toDeliver: toDeliverCount, delivered: delivered.length }) : null}</p>
        </div>
      </div>
      {!online && <p className="supply-offline text-sm" role="status">{t('deliveries.offline')}</p>}

      {err ? (
        <EmptyState
          icon={<Icon name="warning" size={28} />}
          title={t('deliveries.loadFailed')}
          message={online ? t('supplyPage.loadFailedHint') : t('deliveries.offline')}
          action={<button type="button" className="btn btn-primary" onClick={reload}>{t('supplyPage.tryAgain')}</button>}
        />
      ) : !data ? (
        <p className="text-muted text-sm supply-loading">{t('common.loading')}</p>
      ) : (
        <>
          <div className="section-head"><h3>{t('deliveries.toDeliver')}</h3></div>
          {groups.length === 0 ? (
            <EmptyState icon={<Icon name="box" size={28} />} title={t('deliveries.empty')} message={t('deliveries.emptyHint')} />
          ) : (
            <>
              <div className="table-head">
                <div className="table-controls">
                  <TableSearch value={q} onChange={setQ} placeholder={t('deliveries.search')} />
                </div>
              </div>
              {found.length === 0 ? (
                <EmptyState icon={<Icon name="search" size={28} />} title={t('supplyPage.noSearchMatch')} message={t('supplyPage.noSearchMatchHint')} />
              ) : (
                <>
                  <div className="supply-drops">
                    {pager.pageRows.map((g) => (
                      <section key={g.clientId} className="card supply-drop">
                        <div className="supply-drop-head">
                          {/* i18n-ok: the building's own name and address, as written */}
                          <h3 className="supply-drop-name">{g.building.name || '—'}</h3>
                          <span className="supply-drop-addr">
                            <Icon name="mapPin" size={14} /> {g.building.address || t('deliveries.noAddress')}
                          </span>
                        </div>
                        {g.requests.map((r) => (
                          <div key={r.id} className="supply-drop-req">
                            {/* i18n-ok: the order's number, as stored */}
                            {r.no ? <span className="supply-drop-no">#{r.no}</span> : null}
                            <ul className="supply-drop-items">
                              {(r.items || []).map((it) => (
                                <li key={`${r.id}-${it.line}`} className="supply-drop-line">
                                  <span className="supply-drop-line-text">
                                    {/* i18n-ok: the item's own name and SKU, as the office wrote them */}
                                    <span className="supply-drop-item">{it.name}{it.sku ? <span className="supply-sku">{it.sku}</span> : null}</span>
                                    {it.state === SUPPLY_LINE_STATE.backordered && (
                                      <Badge variant="amber">{it.eta ? t('deliveries.backorderedEta', { eta: supplyEtaInstant(it.eta) }) : t('deliveries.backordered')}</Badge>
                                    )}
                                  </span>
                                  <b className="supply-drop-qty">{t('supplyPage.detail.qty', { qty: it.qty })}</b>
                                  <button
                                    type="button" className="btn btn-outline supply-drop-line-btn"
                                    disabled={working || !online}
                                    onClick={() => setConfirm({ r, building: g.building, line: it })}
                                  >{t('deliveries.deliver')}</button>
                                </li>
                              ))}
                            </ul>
                            <div className="supply-drop-meta">
                              <span className="text-xs text-muted">
                                {r.sentByName ? t('deliveries.sentBy', { name: r.sentByName, when: r.sentAt }) : t('deliveries.sentAt', { when: r.sentAt })}
                                {' · '}{t('deliveries.items', { count: r.itemCount })}
                              </span>
                              <button
                                type="button" className="btn btn-gold supply-drop-btn"
                                disabled={working || !online}
                                onClick={() => setConfirm({ r, building: g.building, line: null })}
                              >
                                <Icon name="check" size={16} /> {t('deliveries.allDelivered')}
                              </button>
                            </div>
                          </div>
                        ))}
                      </section>
                    ))}
                  </div>
                  <ListPager pager={pager} noun={t('pager.noun.buildings')} />
                </>
              )}
            </>
          )}

          <div className="section-head supply-drop-today-head"><h3>{t('deliveries.deliveredToday')}</h3></div>
          {delivered.length === 0 ? (
            <p className="text-muted text-sm">{t('deliveries.emptyToday')}</p>
          ) : (
            <>
              <div className="supply-drops">
                {todayPager.pageRows.map((r) => (
                  <section key={r.id} className="card supply-drop is-done">
                    <div className="supply-drop-head">
                      {/* i18n-ok: the building's own name and address, as written */}
                      <h3 className="supply-drop-name">{r.building.name || '—'}</h3>
                      <span className="supply-drop-addr"><Icon name="check" size={14} /> {r.deliveredByName
                        ? t('deliveries.deliveredBy', { time: r.deliveredAt, name: r.deliveredByName })
                        : t('deliveries.deliveredAt', { time: r.deliveredAt })}</span>
                    </div>
                    <ul className="supply-drop-items">
                      {(r.items || []).map((it, i) => (
                        <li key={`${it.name}-${i}`}>
                          {/* i18n-ok: the item's own name, as the office wrote it */}
                          <span className="supply-drop-item">{it.name}</span>
                          <b className="supply-drop-qty">{t('supplyPage.detail.qty', { qty: it.qty })}</b>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
              <ListPager pager={todayPager} noun={t('pager.noun.requests')} />
            </>
          )}
        </>
      )}

      {confirm && (
        <DeliverModal
          confirm={confirm} working={working}
          onConfirm={(photo) => deliver(confirm, photo)}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

// One confirmation that names the building and what is being marked: one line, or everything still
// to come on the drop — with an optional photo of the drop-off (filed under the order).
function DeliverModal({ confirm, working, onConfirm, onClose }) {
  const t = useT();
  const [photo, setPhoto] = useState(null);
  const { r, building, line } = confirm;
  return (
    <Modal open onClose={onClose} title={t('deliveries.confirmTitle', { building: building.name || '—' })}>
      <p className="text-sm">{line
        ? t('deliveries.confirmLine', { item: line.name || '—', qty: line.qty })
        : t('deliveries.confirmMessage', { count: r.itemCount })}</p>
      <FormField label={t('deliveries.photo')}>
        <input className="input" type="file" accept="image/*" capture="environment" onChange={(e) => setPhoto((e.target.files && e.target.files[0]) || null)} />
      </FormField>
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-gold" disabled={working} onClick={() => onConfirm(photo)}>{t('deliveries.confirm')}</button>
      </div>
    </Modal>
  );
}
