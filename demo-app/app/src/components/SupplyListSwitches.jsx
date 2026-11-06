// A building's SWITCHES over the master supply list (Matt, the Oct 6 call: "when you go to that
// customer… the supplies will come from that master list with maybe a toggle switch"; plan
// 2026-10-11 §2, D3/D4/D6). Opened by the office (supplies.manage) from the customer's Supplies
// tab — its "Edit list" or "Set up the list" — and by `?edit=1` from the order sheet.
//
//   • the WHOLE catalog (GET /api/supplies/catalog?all=1), grouped by category, A to Z, the
//     unlabelled last (lib/supplies groupSupplyByCategory); each group has ONE master switch —
//     every item in it on, or off (the Roles page's per-section switch) — and its "3 of 6 on";
//   • a search over the name, SKU and category, and "N of M items switched on";
//   • every flip SAVES AS YOU GO: changes made within a moment of each other go as ONE call
//     (suppliesApi.assignItems → POST /api/supplies/items/assign), the next batch waits for the one
//     in flight, and the line under the title says Saving… / Changes saved / "1 change didn't save"
//     with Try again. A change that did not land goes back to what is saved and its row says so
//     (§117: the screen never shows a state the server does not hold). With no signal every
//     switch is off and says why (§131).
// Switching an item off and back on keeps its history (D6: the route keys history on the
// catalog item), so a mis-tap costs nothing.
//
// LANGUAGES: every word is a catalog line (`supplyPage.switches.*`); the items' own names, SKUs,
// categories and units travel as the office wrote them.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useFromHere } from '../hooks/useFromHere';
import { money } from '../lib/dates';
import { groupSupplyByCategory } from '../lib/supplies';
import { searchRows } from '../lib/searchRows';
import * as suppliesApi from '../lib/suppliesApi';
import Icon from './Icon';
import Modal from './Modal';
import Toggle from './Toggle';
import EmptyState from './EmptyState';
import TableSearch from './TableSearch';
import { useT } from '../i18n/react';

// Flips made within this long of each other go as one call.
const BATCH_MS = 400;

/**
 * @param client     the customer (the building)
 * @param onIds      the catalog items the building has switched on now (from its list)
 * @param onClose    (changed) — closes; `changed` when anything was saved, so the tab re-reads
 */
export default function SupplyListSwitches({ client, clientName, onIds, onClose }) {
  const t = useT();
  const online = useOnlineStatus() !== false;
  const nav = useFromHere();

  // The whole catalog, once.
  const [catalog, setCatalog] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoadErr(null);
    suppliesApi.listCatalog({ all: true })
      .then((r) => { if (live) setCatalog((r && r.items) || []); })
      .catch((e) => { if (live) { setCatalog(null); setLoadErr(e); } });
    return () => { live = false; };
  }, [tick]);

  // What the server holds (`saved`), what the screen shows (`shown` = saved + the changes not yet
  // answered), the changes waiting for the next call, the ones in flight, and the ones that failed.
  const [saved, setSaved] = useState(() => new Set(onIds || []));
  const [queued, setQueued] = useState(() => new Map());   // catalogItemId → wanted on?
  const [inFlight, setInFlight] = useState(() => new Map());
  const [failed, setFailed] = useState(() => new Map());   // catalogItemId → { on, code }
  const [lastSaved, setLastSaved] = useState(false);
  const changed = useRef(false);
  const flushing = useRef(null); // the call in flight (a promise), or null
  const timer = useRef(null);
  const queuedRef = useRef(queued);
  queuedRef.current = queued;

  // Send what is queued — unless a call is already out, which sends it when it lands. Everything
  // either reads refs or sets state, so any render's copy does the same thing.
  function flush() {
    if (flushing.current) return flushing.current;
    const batch = new Map(queuedRef.current);
    if (!batch.size) return Promise.resolve();
    const run = send(batch);
    flushing.current = run;
    return run;
  }

  // ONE assign call for a batch of flips; every answer named, a failure kept per item.
  async function send(batch) {
    queuedRef.current = new Map();
    setQueued(new Map());
    setInFlight(batch);
    const on = [...batch].filter(([, v]) => v).map(([id]) => id);
    const off = [...batch].filter(([, v]) => !v).map(([id]) => id);
    try {
      const { results } = await suppliesApi.assignItems({ clientId: client.id, on, off });
      const byId = new Map((results || []).map((x) => [`${x.catalogItemId}|${x.on}`, x]));
      setSaved((prev) => {
        const next = new Set(prev);
        for (const [id, want] of batch) {
          const r = byId.get(`${id}|${want}`);
          if (r && r.ok) { if (want) next.add(id); else next.delete(id); }
        }
        return next;
      });
      setFailed((prev) => {
        const next = new Map(prev);
        for (const [id, want] of batch) {
          const r = byId.get(`${id}|${want}`);
          if (r && r.ok) next.delete(id);
          else next.set(id, { on: want, code: (r && r.code) || 'failed' });
        }
        return next;
      });
      if ((results || []).some((x) => x.ok)) { changed.current = true; setLastSaved(true); }
    } catch {
      setFailed((prev) => {
        const next = new Map(prev);
        for (const [id, want] of batch) next.set(id, { on: want, code: 'failed' });
        return next;
      });
    } finally {
      setInFlight(new Map());
      flushing.current = null;
      // Whatever was flipped while this call was out goes next.
      if (queuedRef.current.size) timer.current = setTimeout(() => { flush(); }, BATCH_MS);
    }
  }

  useEffect(() => () => clearTimeout(timer.current), []);

  // Flip some items to one state: shown at once, sent with whatever else is flipped this moment.
  const want = (ids, on) => {
    if (!online || !ids.length) return;
    setLastSaved(false);
    setFailed((prev) => { const next = new Map(prev); ids.forEach((id) => next.delete(id)); return next; });
    setQueued((prev) => {
      const next = new Map(prev);
      for (const id of ids) {
        // Back to what is saved with nothing in flight: nothing to send.
        if (saved.has(id) === on && !inFlight.has(id)) next.delete(id); else next.set(id, on);
      }
      queuedRef.current = next;
      return next;
    });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { flush(); }, BATCH_MS);
  };
  // Try again: each change that did not land is sent again, as it was asked for.
  const retry = () => {
    const again = [...failed].filter(([, f]) => f.code !== 'not_found');
    want(again.filter(([, f]) => f.on).map(([id]) => id), true);
    want(again.filter(([, f]) => !f.on).map(([id]) => id), false);
  };

  const isOn = (id) => (queued.has(id) ? queued.get(id) : inFlight.has(id) ? inFlight.get(id) : saved.has(id));
  const saving = queued.size > 0 || inFlight.size > 0;

  const [q, setQ] = useState('');
  const items = useMemo(() => searchRows(catalog || [], q, (c) => `${c.name} ${c.sku || ''} ${c.category || ''}`), [catalog, q]);
  const groups = useMemo(() => groupSupplyByCategory(items), [items]);
  const onCount = (catalog || []).filter((c) => isOn(c.id)).length;

  // Closing finishes what is in flight and sends what is queued first, so the tab re-reads a list
  // the server already holds.
  const closing = useRef(false);
  const close = async () => {
    if (closing.current) return;
    closing.current = true;
    clearTimeout(timer.current);
    try {
      if (flushing.current) await flushing.current;
      if (queuedRef.current.size && online) await flush();
    } finally {
      onClose(changed.current);
    }
  };

  let body;
  if (loadErr) {
    body = (
      <EmptyState
        icon={<Icon name="warning" size={26} />}
        title={t('supplyPage.catalog.loadFailed')}
        message={online ? t('supplyPage.loadFailedHint') : t('supplyPage.offline')}
        action={<button type="button" className="btn btn-primary" onClick={() => setTick((n) => n + 1)}>{t('supplyPage.tryAgain')}</button>}
      />
    );
  } else if (!catalog) {
    body = <p className="text-muted text-sm supply-loading">{t('common.loading')}</p>;
  } else if (!catalog.length) {
    // An empty catalog says so, and sends the office where items are added.
    body = (
      <EmptyState
        icon={<Icon name="box" size={26} />}
        title={t('supplyPage.switches.emptyCatalog')}
        message={t('supplyPage.switches.emptyCatalogHint')}
        action={<Link className="btn btn-primary" to="/supplies?tab=catalog" state={nav}>{t('supplyPage.switches.openCatalog')}</Link>}
      />
    );
  } else {
    body = (
      <>
        <div className="table-controls supply-switch-tools">
          <TableSearch value={q} onChange={setQ} placeholder={t('supplyPage.switches.search')} />
        </div>
        {!groups.length && <p className="text-sm text-muted">{t('supplyPage.switches.noMatch', { q })}</p>}
        {groups.map((g) => {
          const ids = g.items.map((c) => c.id);
          const onHere = ids.filter(isOn).length;
          const label = g.category || t('supplyPage.catalog.noCategory');
          return (
            <section key={g.key} className="supply-switch-group" aria-label={label}>
              <div className="supply-switch-head">
                <h4 className="supply-switch-title">{label}</h4>
                <span className="text-xs text-muted supply-switch-count">{t('supplyPage.switches.groupCount', { on: onHere, total: ids.length })}</span>
                {/* The group's master switch: on = every item in it on. A tap turns them all on,
                    or — when they already are — all off. */}
                <label className="supply-switch-all">
                  <span aria-hidden>{t('supplyPage.switches.all')}</span>
                  <span className="sr-only">{t('supplyPage.switches.allAria', { category: label })}</span>
                  <Toggle on={onHere === ids.length} disabled={!online} onChange={() => want(ids, onHere !== ids.length)} />
                </label>
              </div>
              {g.items.map((c) => {
                const f = failed.get(c.id);
                const pending = queued.has(c.id) || inFlight.has(c.id);
                const meta = c.sku ? t('supplyPage.skuUnit', { sku: c.sku, unit: c.unit || t('supplyPage.each') }) : (c.unit || t('supplyPage.each'));
                return (
                  <label key={c.id} className={`supply-switch-row${isOn(c.id) ? ' is-on' : ''}`}>
                    <span className="supply-switch-text">
                      {/* i18n-ok: the item's own name, as the office wrote it */}
                      <b>{c.name}</b>
                      <span className="supply-sheet-meta">{meta}{' · '}{Number(c.unitPrice) > 0 ? money(c.unitPrice) : t('supplyPage.noPrice')}</span>
                      {f && <span className="supply-switch-err">{f.code === 'not_found' ? t('supplyPage.switches.gone') : t('supplyPage.switches.notSaved')}</span>}
                      {pending && <span className="sr-only">{t('supplyPage.switches.saving')}</span>}
                    </span>
                    <Toggle on={isOn(c.id)} disabled={!online || (f && f.code === 'not_found')} onChange={(v) => want([c.id], v)} />
                  </label>
                );
              })}
            </section>
          );
        })}
      </>
    );
  }

  const failedCount = [...failed.values()].filter((f) => f.code !== 'not_found').length;
  return (
    <Modal open onClose={close} size="md" title={t('supplyPage.list.title', { customer: clientName })}>
      <p className="text-sm text-muted supply-switch-lead">{t('supplyPage.switches.lead')}</p>
      {/* The live line: how many are on, and what the saving is doing. */}
      <div className="supply-switch-status" role="status" aria-live="polite">
        {catalog && catalog.length > 0 && <span>{t('supplyPage.switches.countOn', { count: onCount, total: catalog.length })}</span>}
        {saving ? <span className="text-muted">{t('supplyPage.switches.saving')}</span>
          : failedCount ? (
            <span className="supply-switch-err">
              {t('supplyPage.switches.failed', { count: failedCount })}{' '}
              <button type="button" className="btn btn-link" onClick={retry} disabled={!online}>{t('supplyPage.switches.retry')}</button>
            </span>
          ) : lastSaved ? <span className="text-muted"><Icon name="check" size={14} /> {t('supplyPage.switches.saved')}</span> : null}
      </div>
      {!online && <p className="supply-offline text-sm" role="status">{t('supplyPage.offline')}</p>}
      <div className="supply-switches">{body}</div>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={close}>{t('supplyPage.switches.done')}</button>
      </div>
    </Modal>
  );
}
