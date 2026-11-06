import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import { useStore } from '../store';
import { useAuth } from '../hooks/useAuth';
import { useToast } from './Toast';
import { selectVisibleSitesFor, selectSiteById, selectClientById } from '../store/selectors';
import * as qcApi from '../lib/qcApi';
import { itemAllowsNa, itemRequiresPhoto, countChecklistSubmission } from '../lib/checklistCount';
import { newChecklistId } from '../lib/checklistQueue';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import SearchSelect from './SearchSelect';
import ChecklistItemPhoto from './ChecklistItemPhoto';
import { useT } from '../i18n/react';
import { english } from '../i18n/core';
import { errorText } from '../i18n/errors';
import { checklistLabel, templateNameOf } from '../lib/checklistI18n';

// Complete a checklist: pick a PUBLISHED checklist template + site → tick the
// frozen items (+ note) → submit to checklist_results (items inline, no scoring).
// Reuses the inspection template system (kind='checklist'). See CLEANSPACE_SWEPT.md §5.6.
// The office's STANDALONE flow (the Quality hub's "Fill a checklist"): pick a customer, one of
// its published checklists and a location. A cleaner's checklist ON A CLEAN is its own page
// since the Cleaner Hub (pages/crew/CrewChecklist, lib/crewPaths checklist): the bound-to-a-clean
// open this modal used to have (a preset site and checklist, a job id) is deleted with its
// last caller (2026-10-14).
//
// LANGUAGE (CS-193). The screen's own words are catalog lines in the cleaner's language.
// The office's section and item labels show in their language wherever the line is for
// today's English — the server translates every one on save (CS-850, lib/checklistI18n
// checklistLabel), the office may have typed its own — English otherwise. What
// is POSTED is always the office's English label: the stored record is the office's record,
// and the count (lib/checklistCount) reads item keys, never a label in any language.
export default function ChecklistFill({ open, onClose, onSubmitted }) {
  const t = useT();
  const state = useStore();
  const { currentUser } = useAuth();
  const toast = useToast();
  const online = useOnlineStatus();
  // Crew pick from their assigned sites only (manager-safe: returns all sites for
  // non-crew), and MUST pick one — the server scopes crew submits to assigned
  // accounts, so an unscoped "no site" submit would 403.
  const isCrew = currentUser?.role === 'crew';
  const sites = useMemo(() => selectVisibleSitesFor(state, currentUser), [state, currentUser]);
  // The customers the viewer can reach, derived from the sites they can reach — so a crew
  // member sees only their own accounts here without a second scope rule to keep in step.
  const customers = useMemo(() => {
    const seen = new Map();
    for (const s of sites) {
      if (!s.clientId || seen.has(s.clientId)) continue;
      const c = selectClientById(state, s.clientId);
      seen.set(s.clientId, { id: s.clientId, name: c?.name || s.name });
    }
    return [...seen.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [sites, state]);

  const [templates, setTemplates] = useState([]);
  const [customerId, setCustomerId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [schema, setSchema] = useState(null);
  const [checks, setChecks] = useState({});
  const [busy, setBusy] = useState(false);
  // CS-547 — this fill's own id, minted BEFORE anything is uploaded. It is the submission's
  // idempotency key (`clientSubmitId`, which the offline queue has always stamped and this
  // screen never did) AND the `ref_id` every required photo is filed under, so a photo
  // taken minutes before Submit is already attached to the submission it proves. One id
  // for both, so a photo can never belong to a different submission than the one it
  // unlocked. Re-minted on each open: two fills are two submissions.
  const [submissionId, setSubmissionId] = useState(() => newChecklistId());
  // itemKey → how many photos this device has put on it (uploaded OR still queued). Local
  // because nothing else knows yet; the SERVER re-counts the real rows at submit.
  const [photos, setPhotos] = useState({});

  // The schema is what these checkboxes are drawn from; the version it belongs to is NOT
  // sent. The server counts every submission against whatever is published when it lands,
  // and a submission naming its own version was the CS-494 bypass (store.js submitChecklist).
  const load = async (id) => {
    if (!id) { toast.error(t('checklist.fill.pickChecklist')); return; }
    setBusy(true);
    try { const r = await qcApi.getTemplate(id); setSchema(r?.published?.schema || { areas: [] }); }
    catch (e) { toast.error(errorText(t, e, 'checklist.fill.loadFailed')); }
    finally { setBusy(false); }
  };
  const start = () => load(templateId);

  useEffect(() => {
    if (!open) return;
    setTemplateId(''); setSiteId(''); setCustomerId(''); setSchema(null); setChecks({});
    setPhotos({}); setSubmissionId(newChecklistId());
  }, [open]);

  // A CHECKLIST BELONGS TO ONE CUSTOMER (R2), so the list is that customer's published
  // checklists — never the company's. Without a customer there is nothing to offer, which
  // is why the customer is asked first rather than filtered afterwards.
  useEffect(() => {
    if (!open) return undefined;
    if (!customerId) { setTemplates([]); return undefined; }
    let alive = true;
    qcApi.listTemplates({ kind: 'checklist', clientId: customerId })
      .then((list) => { if (alive) setTemplates((list || []).filter((x) => x.is_published)); })
      .catch(() => { if (alive) setTemplates([]); });
    return () => { alive = false; };
  }, [open, customerId]);

  // ONE list: what the cleaner's progress is measured from IS what gets posted, so the
  // screen and the server can never disagree about how far the checklist has got. An item
  // carries BOTH marks so the stored record says which of the two it was — a manager
  // reading it sees "did not apply", not "missed".
  //
  // `completedAt` (QR-1) is stamped when the mark was MADE, not when Submit was pressed:
  // an area counts as cleaned when its last item was finished, and on a two-hour clean the
  // difference is the whole point. It is the phone's clock, so the server clamps it to the
  // submission's own instant (src/lib/checklistAreas) — it is the cleaner's own record of
  // their own work, like `na`, and it decides nothing that gates them.
  //
  // `label` is the OFFICE's English, always — the record is read in the office, and the
  // fallbacks are the catalog's English for the same reason.
  const items = useMemo(() => {
    const out = [];
    for (const area of schema?.areas || []) {
      for (const it of area.items || []) {
        const c = checks[it.id] || {};
        out.push({
          key: it.id,
          label: `${area.label || english('checklist.fill.areaFallback')}. ${it.label || english('checklist.fill.itemFallback')}`,
          checked: !!c.checked,
          na: !!c.na,
          note: c.note || null,
          completedAt: (c.checked || c.na) ? (c.at || null) : null,
        });
      }
    }
    return out;
  }, [schema, checks]);

  // The item keys this device has a photo for — uploaded or still queued (CS-547). What
  // the screen counts by; the server counts the rows that actually landed.
  const photoKeys = useMemo(() => Object.keys(photos).filter((k) => photos[k] > 0), [photos]);

  // The same rule the route stores (lib/checklistCount, CS-494/CS-546/CS-547): ticked (with
  // its photo where the office requires one), or marked N/A on an item the OFFICE allowed.
  // It is shown, never enforced — a partial submission is accepted and the clock-out block
  // is the boundary (THE LAW II.8).
  const progress = useMemo(() => countChecklistSubmission(schema, items, { photoKeys }), [schema, items, photoKeys]);
  const naCount = useMemo(() => items.filter((i) => i.na).length, [items]);
  // A checklist whose office marked any item photo-required can only be filled AGAINST A
  // LOCATION: media is site-scoped (api/account-media gates on the site the upload URL was
  // minted for), so with no location there is nowhere to put the photo — and the server
  // would then count every marked item as not done while this screen showed it ticked.
  // Said out loud and Submit held, rather than letting the two quietly disagree. Only the
  // office's standalone flow can reach it; a crew fill always carries its site.
  const needsLocationForPhotos = useMemo(
    () => !!schema && !siteId && (schema.areas || []).some((a) => (a.items || []).some(itemRequiresPhoto)),
    [schema, siteId],
  );

  const submit = async () => {
    setBusy(true);
    try {
      const site = siteId ? selectSiteById(state, siteId) : null;
      const res = await qcApi.submitChecklist({ templateId, siteId: siteId || null, clientId: site?.clientId || null, items, completedByUserId: currentUser?.id || null, clientSubmitId: submissionId });
      // Offline → buffered on-device (qcApi returns pending_sync); OfflineChecklistSync
      // replays it when the network returns. Tell the crew it's SAVED, not failed.
      toast.success(res?.pending_sync ? t('checklist.fill.savedOffline') : t('checklist.fill.submitted'));
      onSubmitted?.();
      onClose();
    } catch (e) { toast.error(errorText(t, e, 'checklist.fill.submitFailed')); }
    finally { setBusy(false); }
  };

  // Every MARK carries the instant it was made (QR-1). Stamped here, in the one place a
  // mark changes, so the tick, the N/A and a later un-tick cannot each remember a
  // different time. A NOTE is not a mark and goes through `setNote`, which leaves the
  // stamp alone — typing a comment half an hour later must not move when the work
  // finished, and restamping per keystroke would have done exactly that.
  const setChk = (id, patch) => setChecks((p) => ({ ...p, [id]: { ...p[id], ...patch, at: new Date().toISOString() } }));
  const setNote = (id, note) => setChecks((p) => ({ ...p, [id]: { ...p[id], note } }));
  const setPhotoCount = (id, n) => setPhotos((p) => ({ ...p, [id]: n }));

  return (
    <Modal open={open} onClose={onClose} title={schema ? t('checklist.fill.titleFill') : t('checklist.fill.titleNew')}>
      {!schema ? (
        <div>
          {/* WHOSE checklist first: a checklist belongs to one customer, so the list below
              is that customer's and no one else's. */}
          <div className="form-group">
            <label className="form-label">{t('checklist.fill.customer')}</label>
            <SearchSelect
              value={customerId}
              onChange={(id) => { setCustomerId(id || ''); setTemplateId(''); setSiteId(''); }}
              options={customers.map((c) => ({ value: c.id, label: c.name }))}
              placeholder={t('checklist.fill.customerPlaceholder')}
              searchPlaceholder={t('checklist.fill.customerSearch')}
              emptyText={t('checklist.fill.noCustomers')}
            />
          </div>
          <div className="form-group">
            <label className="form-label">{t('checklist.fill.checklist')}</label>
            <SearchSelect
              value={templateId}
              onChange={(id) => setTemplateId(id || '')}
              options={templates.map((x) => ({ value: x.id, label: templateNameOf(x, t.lang) }))}
              placeholder={customerId ? t('checklist.fill.checklistPlaceholder') : t('checklist.fill.customerFirstPlaceholder')}
              searchPlaceholder={t('checklist.fill.checklistSearch')}
              emptyText={t('checklist.fill.noChecklists')}
            />
            {!customerId
              ? <p className="form-help">{t('checklist.fill.customerFirstHelp')}</p>
              // CS-554: names the two places the app really has — it used to send the office to
              // a customer "Templates tab" that does not exist.
              : templates.length === 0 && <p className="form-help">{t('checklist.fill.noneForCustomer')}</p>}
          </div>
          <div className="form-group">
            <label className="form-label">{t('checklist.fill.location')}</label>
            {/* Scoped to the chosen customer: a checklist filed under one customer submitted
                against another's site would be a record nobody can explain. */}
            <SearchSelect
              value={siteId}
              onChange={(id) => setSiteId(id || '')}
              options={sites.filter((s) => !customerId || s.clientId === customerId)
                .map((s) => { const c = selectClientById(state, s.clientId); return { value: s.id, label: s.name || c?.name, sublabel: s.address || '' }; })}
              placeholder={isCrew ? t('checklist.fill.locationPlaceholderCrew') : t('checklist.fill.locationPlaceholderOffice')}
              searchPlaceholder={t('checklist.fill.locationSearch')}
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-primary" disabled={busy || !customerId || !templateId || (isCrew && !siteId)} onClick={start}>{t('checklist.fill.start')}</button>
          </div>
        </div>
      ) : (
        <div className="insp-fill">
          {!online && (
            <p className="text-xs" role="status" style={{ margin: '0 0 8px', color: 'var(--color-semantic-warning-700)' }}>
              {t('checklist.fill.offlineNote')}
            </p>
          )}
          {needsLocationForPhotos && (
            <p className="callout callout-info text-sm">
              {t('checklist.fill.needsLocationForPhotos')}
            </p>
          )}
          {(schema.areas || []).map((area) => (
            <div className="insp-area" key={area.id}>
              <div className="insp-area-label">{checklistLabel(area, t.lang) || t('checklist.fill.areaFallback')}</div>
              {(area.items || []).map((it) => {
                const c = checks[it.id] || {};
                const itemText = checklistLabel(it, t.lang) || t('checklist.fill.itemFallback');
                // CS-547: the office marked this item "photo required", so the tick is not
                // available until a photo is on it. The control is right beside the tick
                // and says why; the SERVER is the boundary (it counts the rows that
                // actually landed), and this is what stops a cleaner finishing the clean
                // believing the item was accepted.
                const needsPhoto = itemRequiresPhoto(it);
                const shots = photos[it.id] || 0;
                const photoBlocked = needsPhoto && shots === 0;
                return (
                  <div className="chk-item" key={it.id}>
                    <label className="chk-item-check">
                      <input
                        type="checkbox"
                        checked={!!c.checked}
                        disabled={photoBlocked}
                        onChange={(e) => setChk(it.id, { checked: e.target.checked, na: false })}
                      />
                      <span>{itemText}</span>
                    </label>
                    {/* The office's per-item exception, and the ONLY one there is (CS-546):
                        it appears only on an item they flagged "N/A ok", it is exclusive
                        with the tick, and it counts as done by the same rule the server
                        stores. An item without the flag simply has no control here — there
                        is no way around the checklist on the cleaner's side.
                        It is NOT gated on the photo: the office said this item may not
                        apply tonight, and there is nothing to photograph when it didn't
                        happen.
                        CS-549: its accessible name says WHICH item it marks — several N/A
                        buttons in one checklist all announced "N/A". */}
                    {itemAllowsNa(it) && (
                      <button
                        type="button"
                        className={`chip chk-item-na ${c.na ? 'on' : ''}`}
                        aria-pressed={!!c.na}
                        aria-label={t('checklist.fill.naAria', { item: itemText })}
                        onClick={() => setChk(it.id, { na: !c.na, checked: false })}
                      >
                        {t('checklist.fill.na')}
                      </button>
                    )}
                    {needsPhoto && siteId && (
                      <ChecklistItemPhoto
                        siteId={siteId}
                        clientId={customerId || null}
                        submissionId={submissionId}
                        itemKey={it.id}
                        itemLabel={itemText}
                        count={shots}
                        onCount={(n) => setPhotoCount(it.id, n)}
                      />
                    )}
                    <input className="input chk-item-note" placeholder={t('checklist.fill.notePlaceholder')} aria-label={t('checklist.fill.noteAria', { item: itemText })} value={c.note || ''} onChange={(e) => setNote(it.id, e.target.value)} />
                  </div>
                );
              })}
            </div>
          ))}
          {/* How far it has got, by the rule the server will apply — so "done" here and
              "done" at the clock-out button are the same word. */}
          {progress.total_count > 0 && (
            <p className="insp-fill-progress" role="status">
              {progress.completed_count >= progress.total_count
                ? t('checklist.fill.allDone', { count: progress.total_count })
                : t('checklist.fill.someDone', { done: progress.completed_count, total: progress.total_count })}
              {naCount > 0 ? ` · ${t('checklist.fill.naCount', { count: naCount })}` : ''}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
            {/* Never gated on completeness: a part-finished checklist is stored and counted
                honestly (II.8 — the clean already happened and this is its only record),
                and the clock-out block is what actually holds the line. The ONE thing that
                holds it is a fill that cannot physically do what the office asked —
                a photo-required checklist with nowhere to put the photos. */}
            <button type="button" className="btn btn-primary" disabled={busy || needsLocationForPhotos} onClick={submit}>{t('checklist.fill.submit')}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
