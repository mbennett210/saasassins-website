// REQUEST SUPPLIES — the cleaner orders supplies for a building they clean (the Cleaner Hub, D4,
// 2026-10-13; rebuilt to Matt's RequestSupplies board by S131 Builder C, 2026-10-14 — plan
// docs/plans/2026-10-14-supply-orders.md §4, UI_RULES §170). `/my-day/supplies?b=<customer>`
// (crewPaths.supplies), from Home's tile.
//
//   back · "Request Supplies" · the building (one button per stop today when there is more than one;
//   `?b=` first, else the stop in progress, else the next one)
//   "Your last order · #SO-1047" — the cleaner's newest order here: its status in their words and
//   each line's state (pages/crew/supplyOrderParts), and the way into the order's page
//   "Order Supplies" — "Only products approved for this property are shown": every switched-on item
//   (grouped by category when there is more than one group): its photo, its name and how it comes,
//   and a − 0 + stepper (0 to CREW_SUPPLY_MAX_QTY, the server's own cap). NO price (Daniel: cleaners
//   never see prices) and no "Other" (SUP-3 a: no open-ended requests)
//   Notes (optional) · Submit for Approval — off until a quantity is above 0, the reason said under
//   it — and the board's line "Your account manager reviews every request before it's sent to the
//   Supply Manager"; once sent: "{First L.} approves it next"
//   Order History — the cleaner's orders here, newest first (the server's 10): "#SO-1047 · Oct 13",
//   the items, the status; each opens the order's page (crewPaths.supplyOrder)
//
// 🔴 NO MONEY ON THIS SCREEN: it reads GET /api/supplies/crew-list (names, units, categories, photo
// links and the cleaner's own orders — built field by field on the server) and is answered field by
// field when it sends; this file imports no money helper (test-crew-supplies.mjs 5i).
// The key is the gate (`supplies.request`, the cleaner's by default — switched off per cleaner on
// their Team page, or for every cleaner in Settings → Roles): without it the page says so instead of
// a list. The owner's View-as reads the viewed cleaner's orders (the server honours `userId` with
// supplies.view) and every write is off (the server would record the owner), as with no signal. An
// order's id is minted once per attempt and kept until it lands, so a retry after a timeout is the
// same order, never a second (THE LAW II.7).
//
// Every word is a catalog line (`crewSupplies.*`); item names and units are the office's own words.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import Icon from '../../components/Icon';
import Badge from '../../components/Badge';
import { useT } from '../../i18n/react';
import { useBackTarget } from '../../hooks/useBackTarget';
import { useFromHere } from '../../hooks/useFromHere';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { usePermission } from '../../hooks/usePermission';
import { useCrewPreview } from '../../hooks/useCrewPreview';
import { refreshMySupplyOrders } from '../../hooks/useMySupplyOrders';
import { useGetState, useSelector, shallowEqual } from '../../store';
import { selectCurrentUser, selectTodayCleansForUser } from '../../store/selectors';
import { crewPaths } from '../../lib/crewPaths';
import {
  groupSupplyByCategory, crewSupplyQty, crewSupplySendBlock, CREW_SUPPLY_MAX_QTY,
  supplyOrderLabelKey, supplyOrderVariant,
} from '../../lib/supplies';
import * as suppliesApi from '../../lib/suppliesApi';
import { CrewOrderLines, crewItemQty } from './supplyOrderParts';

// Today's stops as buildings, in start order, each once: the customer of each clean (its own, else
// its location's).
function stopBuildings(cleans, sites, clients) {
  const siteClient = new Map((sites || []).filter(Boolean).map((s) => [s.id, s.clientId || null]));
  const out = [];
  for (const j of cleans) {
    const id = j.clientId || (j.siteId ? siteClient.get(j.siteId) : null);
    if (!id || out.some((b) => b.id === id)) continue;
    const c = (clients || []).find((x) => x && x.id === id);
    out.push({ id, name: (c && c.name) || '', live: j.status === 'in_progress', done: j.status === 'done' });
  }
  return out;
}

export default function CrewSupplies() {
  const t = useT();
  const navigate = useNavigate();
  const nav = useFromHere();
  const online = useOnlineStatus();
  const getState = useGetState();
  const canRequest = usePermission('supplies.request');
  const canView = usePermission('supplies.view');
  const { previewing, name: previewName, userId: shownUserId } = useCrewPreview();
  const me = useSelector(selectCurrentUser);
  const userId = me?.id || null;
  const { href, goBack } = useBackTarget(crewPaths.home());
  const [searchParams, setSearchParams] = useSearchParams();
  const [now] = useState(() => Date.now());
  const cleans = useSelector(useCallback((s) => selectTodayCleansForUser(s, userId, now), [userId, now]), shallowEqual);
  const sites = useSelector(useCallback((s) => s.sites, []));
  const clients = useSelector(useCallback((s) => s.clients, []));
  const stops = useMemo(() => stopBuildings(cleans, sites, clients), [cleans, sites, clients]);

  // The building: `?b=` first, else the stop in progress, else the next one not done, else the first.
  const asked = searchParams.get('b') || '';
  const fallback = (stops.find((b) => b.live) || stops.find((b) => !b.done) || stops[0] || null)?.id || '';
  const buildingId = asked || fallback;
  const building = (clients || []).find((c) => c && c.id === buildingId) || null;
  const choices = useMemo(() => {
    const list = stops.slice();
    if (buildingId && !list.some((b) => b.id === buildingId)) list.unshift({ id: buildingId, name: building?.name || '' });
    return list;
  }, [stops, buildingId, building]);

  // ── the read: the list and the cleaner's own orders here ──
  // The demo stub reads `ctx` (the server reads the login's claim); the View-as names the person on screen.
  const ctx = useCallback(() => ({ state: getState(), user: me, holds: { request: canRequest, view: canView } }), [getState, me, canRequest, canView]);
  const [read, setRead] = useState({ loading: true, data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    window.addEventListener('online', again);
    return () => window.removeEventListener('online', again);
  }, []);
  useEffect(() => {
    if (!canRequest || !buildingId) { setRead({ loading: false, data: null, error: null }); return undefined; }
    let live = true;
    setRead((r) => ({ loading: true, data: r.data && r.data.clientId === buildingId ? r.data : null, error: null }));
    suppliesApi.crewList(buildingId, ctx(), { userId: previewing ? shownUserId : null })
      .then((data) => { if (live) setRead({ loading: false, data, error: null }); })
      .catch((err) => { if (live) setRead({ loading: false, data: null, error: err }); });
    return () => { live = false; };
    // `ctx` is read for the demo stub only; the identity that matters is userId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildingId, canRequest, userId, previewing, shownUserId, tick]);

  // ── the form: a quantity per item, 0 = not ordered ──
  const [counts, setCounts] = useState(() => new Map());
  const [note, setNote] = useState('');
  const [send, setSend] = useState({ busy: false, error: null, sent: null });
  const pendingId = useRef(null);
  useEffect(() => {
    setCounts(new Map()); setNote(''); setSend({ busy: false, error: null, sent: null });
    pendingId.current = null;
  }, [buildingId]);

  const items = read.data?.items || [];
  const groups = useMemo(() => groupSupplyByCategory(items), [items]);
  const showHeads = groups.length > 1;
  const lines = [...counts.entries()].filter(([, n]) => n > 0).map(([itemId, n]) => ({ itemId, qty: n }));
  const block = crewSupplySendBlock({ lines });
  const sendDisabled = previewing || !online || send.busy || !!block;

  const step = (id, by) => setCounts((m) => {
    const next = new Map(m);
    const n = crewSupplyQty((next.get(id) || 0) + by);
    if (n > 0) next.set(id, n); else next.delete(id);
    return next;
  });

  const submit = async () => {
    if (sendDisabled) return;
    if (!pendingId.current) pendingId.current = suppliesApi.newSupplyRequestId();
    setSend({ busy: true, error: null, sent: null });
    try {
      await suppliesApi.createRequest({ id: pendingId.current, clientId: buildingId, lines, note: note.trim() }, ctx());
      pendingId.current = null;
      setCounts(new Map()); setNote('');
      setSend({ busy: false, error: null, sent: { approverName: read.data?.approverName || null } });
      setTick((n) => n + 1);
      // Home's tile names the newest order: read it again now, not when its answer ages out.
      refreshMySupplyOrders({ previewing, userId: shownUserId, ctx: ctx() });
    } catch (err) {
      // A refusal the server named is not a retry of the same order: a new id next time.
      if (err && err.status) pendingId.current = null;
      setSend({ busy: false, error: err || {}, sent: null });
      if (err && err.code === 'unknown_item') setTick((n) => n + 1);
    }
  };

  const head = (
    <header className="crew-sup-head">
      <a href={href} onClick={goBack} className="btn-icon crew-sup-back" aria-label={t('back.back')}>
        <Icon name="chevronLeft" size={20} />
      </a>
      <div className="crew-sup-head-text">
        <h1 className="crew-sup-title">{t('crewSupplies.title')}</h1>
        {building?.name && <div className="crew-sup-sub">{building.name}</div>}
      </div>
    </header>
  );

  if (!canRequest) {
    return (
      <div className="crew-sup">
        {head}
        <div className="card crew-sup-card crew-sup-note" role="status"><Icon name="lock" size={18} /><span>{t('crewSupplies.off')}</span></div>
      </div>
    );
  }
  if (!buildingId) {
    return (
      <div className="crew-sup">
        {head}
        <div className="card crew-sup-card crew-sup-note" role="status"><Icon name="building" size={18} /><span>{t('crewSupplies.noStops')}</span></div>
      </div>
    );
  }

  const data = read.data;
  const orders = data?.orders || [];
  const last = orders[0] || null;
  const notYours = read.error && read.error.code === 'not_your_building';
  const sentErr = send.error;
  const sentErrKey = !sentErr ? null
    : sentErr.status == null ? 'crewSupplies.offline'
      : sentErr.code === 'not_your_building' ? 'crewSupplies.notYours'
        : sentErr.code === 'unknown_item' ? 'crewSupplies.error.unknownItem'
          : sentErr.code === 'qty_over_cap' ? 'crewSupplies.error.overCap'
            : 'crewSupplies.error.failed';
  const why = previewing ? t('crewSupplies.previewOff', { name: previewName })
    : !online ? t('crewSupplies.offline')
      : sentErrKey ? t(sentErrKey, { max: (sentErr && sentErr.max) || CREW_SUPPLY_MAX_QTY })
        : block ? t('crewSupplies.pickOne') : '';

  return (
    <div className="crew-sup">
      {head}

      {choices.length > 1 && (
        <div className="crew-sup-switch" role="group" aria-label={t('crewSupplies.building')}>
          {choices.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`chip${b.id === buildingId ? ' on' : ''}`}
              aria-pressed={b.id === buildingId}
              onClick={() => setSearchParams({ b: b.id }, { replace: true })}
            >
              {b.name || t('crewSupplies.building')}
            </button>
          ))}
        </div>
      )}

      {read.loading && !data && <p className="crew-sup-muted" role="status">{t('common.loading')}</p>}

      {!read.loading && !data && read.error && (
        <div className="card crew-sup-card crew-sup-note" role="status">
          <Icon name="warning" size={18} />
          <span>{notYours ? t('crewSupplies.notYours') : read.error.status == null ? t('crewSupplies.offlineRead') : t('crewSupplies.loadFailed')}</span>
          {!notYours && (
            <button type="button" className="btn btn-outline crew-sup-retry" onClick={() => setTick((n) => n + 1)}>{t('crewSupplies.tryAgain')}</button>
          )}
        </div>
      )}

      {data && (
        <>
          {last && (
            <section className={`card crew-sup-card crew-sup-last is-${supplyOrderVariant(last)}`} aria-labelledby="crew-sup-last-h">
              <div className="crew-sup-last-head">
                <h2 id="crew-sup-last-h" className="crew-sup-kicker">
                  {last.no ? t('crewSupplies.last.title', { no: last.no }) : t('crewSupplies.last.titleNoNumber')}
                </h2>
                <Badge variant={supplyOrderVariant(last)}>{t(supplyOrderLabelKey(last, 'crew'))}</Badge>
              </div>
              <CrewOrderLines order={last} />
              <Link className="crew-sup-last-open" to={crewPaths.supplyOrder(last.id)} state={nav}>
                {t('crewSupplies.last.open')} <Icon name="chevronRight" size={16} />
              </Link>
            </section>
          )}

          {send.sent ? (
            <div className="card crew-sup-card crew-sup-sent" role="status">
              <div className="crew-sup-sent-title"><Icon name="check" size={20} /><span>{t('crewSupplies.sent.title')}</span></div>
              <p className="crew-sup-muted">
                {send.sent.approverName ? t('crewSupplies.sent.body', { name: send.sent.approverName }) : t('crewSupplies.sent.bodyNoName')}
              </p>
              <div className="crew-sup-actions">
                <button type="button" className="btn btn-outline" onClick={() => setSend({ busy: false, error: null, sent: null })}>{t('crewSupplies.sent.more')}</button>
                <a className="btn btn-primary" href={crewPaths.home()} onClick={(e) => { e.preventDefault(); navigate(crewPaths.home()); }}>{t('crewSupplies.sent.home')}</a>
              </div>
            </div>
          ) : !items.length ? (
            <div className="card crew-sup-card crew-sup-note" role="status"><Icon name="box" size={18} /><span>{t('crewSupplies.noList')}</span></div>
          ) : (
            <form className="crew-sup-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
              <div className="crew-sup-form-head">
                <h2 className="crew-sup-section">{t('crewSupplies.orderTitle')}</h2>
                <p className="crew-sup-muted">{t('crewSupplies.orderHint')}</p>
              </div>
              <div className="crew-sup-list">
                {groups.map((g) => (
                  <div key={g.key} className="crew-sup-group">
                    {showHeads && <div className="crew-sup-group-head">{g.category || t('crewSupplies.noCategory')}</div>}
                    {g.items.map((it) => {
                      const qty = counts.get(it.id) || 0;
                      return (
                        <div key={it.id} className={`card crew-sup-row${qty > 0 ? ' is-on' : ''}`}>
                          {it.imageUrl ? <img className="crew-sup-thumb" src={it.imageUrl} alt="" width={40} height={40} loading="lazy" /> : null}
                          <div className="crew-sup-item">
                            <span className="crew-sup-name">{it.name}</span>
                            {it.unit && <span className="crew-sup-unit">{it.unit}</span>}
                            {qty >= CREW_SUPPLY_MAX_QTY && <span className="crew-sup-unit">{t('crewSupplies.maxReached', { max: CREW_SUPPLY_MAX_QTY })}</span>}
                          </div>
                          <div className="crew-sup-qty">
                            <button type="button" className="btn-icon crew-sup-step" onClick={() => step(it.id, -1)} disabled={qty <= 0} aria-label={t('crewSupplies.qtyLess', { item: it.name })}>
                              <Icon name="minus" size={16} />
                            </button>
                            <span className="crew-sup-count" aria-live="polite">{qty}</span>
                            <button type="button" className="btn-icon crew-sup-step is-more" onClick={() => step(it.id, 1)} disabled={qty >= CREW_SUPPLY_MAX_QTY} aria-label={t('crewSupplies.qtyMore', { item: it.name })}>
                              <Icon name="plus" size={16} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>

              <label className="crew-sup-notes">
                <span className="crew-sup-notes-label">{t('crewSupplies.notes')}</span>
                <textarea
                  className="input crew-sup-textarea"
                  rows={3}
                  value={note}
                  maxLength={2000}
                  placeholder={t('crewSupplies.notesPlaceholder')}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>

              <button type="submit" className="btn btn-primary crew-sup-send" disabled={sendDisabled} aria-describedby="crew-sup-why">
                {send.busy ? t('crewSupplies.sending') : t('crewSupplies.submit')}
              </button>
              <p id="crew-sup-why" className="crew-sup-why" role="status">{why}</p>
              <p className="crew-sup-review">{t('crewSupplies.reviewNote')}</p>
            </form>
          )}

          {orders.length > 0 && (
            <section className="crew-sup-history" aria-labelledby="crew-sup-history-h">
              <h2 id="crew-sup-history-h" className="crew-sup-section">{t('crewSupplies.history.title')}</h2>
              <ul className="crew-sup-history-list">
                {orders.map((o) => (
                  <li key={o.id}>
                    <Link className="card crew-sup-history-row" to={crewPaths.supplyOrder(o.id)} state={nav}>
                      <span className="crew-sup-history-head">
                        <span className="crew-sup-history-no">
                          {o.no ? t('crewSupplies.history.row', { no: o.no, date: o.requestedAt }) : t('crewSupplies.history.rowNoNumber', { date: o.requestedAt })}
                        </span>
                        <Badge variant={supplyOrderVariant(o)}>{t(supplyOrderLabelKey(o, 'crew'))}</Badge>
                      </span>
                      <span className="crew-sup-history-items">{t('crewSupplies.itemList', { items: (o.lines || []).map((l) => crewItemQty(t, l)) })}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
