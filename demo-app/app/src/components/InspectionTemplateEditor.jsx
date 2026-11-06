import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import FilterSelect from './FilterSelect';
import Icon from './Icon';
import { useToast } from './Toast';
import { useStore } from '../store';
import { selectActiveClients, selectClientById, selectSitesForClient } from '../store/selectors';
import * as qcApi from '../lib/qcApi';
import { publishRefusal, createTemplateRefusal, effectiveTemplateMeta } from '../lib/inspections';
import { defaultNaAllowed } from '../lib/checklistCount';
import TemplateTranslations from './TemplateTranslations';
import { useT } from '../i18n/react';
import { customerLabel } from '../lib/customerNumber';

// Versioned inspection/checklist template editor (areas → items + a rating scale).
// Save persists to the working draft; Publish freezes the version so submitted
// records never drift. See CLEANSPACE_SWEPT.md §5.6.
//
// A CHECKLIST BELONGS TO ONE CUSTOMER (R2, plan step 5), so creating one has to say whose
// it is BEFORE it can be saved — the server refuses a checklist with no customer, and an
// error at the end of a long form is a worse way to learn that than a field at the top.
// `clientId` pre-sets it (the customer page and step 6's assignments view open the editor
// that way); without one the customer is chosen here from a searchable picker. An
// INSPECTION template never carries a customer — it stays company-wide.
const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 9)}`;
// A new item's "N/A ok" flag follows the TEMPLATE'S KIND, through the one shared rule
// (lib/checklistCount.defaultNaAllowed — CS-546): a CHECKLIST item starts with it OFF,
// because a checklist is ticked and gates a clock-out, so the one exception the cleaner has
// must be something the office chose per item, never something that arrived switched on.
// An INSPECTION item keeps the long-standing ON — a scored N/A is a rating, and it blocks
// nothing. Every new item in this editor is minted here, so the two paths cannot drift.
const blankItem = (kind) => ({ id: rid('i'), label: '', photoRequired: false, naAllowed: defaultNaAllowed(kind) });
// `siteAreaId` (QR-1) links a CHECKLIST section to the physical area of the building it
// covers — a `site.cleaningAreas[].id`, the thing a QR code is stuck to the wall of. null
// is the normal state and means "this section answers for no QR code"; it is never
// guessed from a label (src/lib/checklistAreas says why).
const blankArea = (kind) => ({ id: rid('a'), label: '', siteAreaId: null, items: [blankItem(kind)] });

// Switching the type before anything is saved re-defaults the flags NOBODY opted into: an
// item still carrying the old kind's default was never a decision, it was the default, and
// leaving it would hand a brand-new checklist the exception on every item. An item the
// office deliberately set keeps its value.
//
// "Deliberately set" is a FLAG, `naTouched`, not "its value differs from the old default":
// by value alone, Checklist → Inspection → Checklist silently threw the office's own choice
// away, because the first hop made every item `true` and the second could no longer tell a
// deliberate `true` from the default one. `naTouched` is editor state only — `schema()`
// writes an explicit field list, so it never reaches the saved template.
const retypeNaDefaults = (areas, from, to) => (
  defaultNaAllowed(from) === defaultNaAllowed(to) ? areas : areas.map((a) => ({
    ...a,
    items: (a.items || []).map((i) => (i.naTouched ? i : { ...i, naAllowed: defaultNaAllowed(to) })),
  }))
);

export default function InspectionTemplateEditor({ open, onClose, templateId = null, onSaved, presetKind = null, clientId = null }) {
  const t = useT();
  const toast = useToast();
  const state = useStore();
  // CS-193: the wording, or its Spanish / Creole beside it (components/TemplateTranslations).
  const [view, setView] = useState('wording');
  const [tid, setTid] = useState(templateId);
  const [meta, setMeta] = useState({ name: '', kind: 'inspection', scaleType: 'passfail', max: 5, passThreshold: 80, isPublished: false });
  const [customerId, setCustomerId] = useState(clientId || '');
  const [areas, setAreas] = useState(() => [blankArea(presetKind || 'inspection')]);
  // The NAME's Spanish / Creole lines (CS-850), kept with the version like the areas' own.
  const [nameI18n, setNameI18n] = useState(null);
  const [busy, setBusy] = useState(false);

  // The one place the type changes, so the untouched N/A defaults follow it.
  const setKind = (kind) => {
    setAreas((prev) => retypeNaDefaults(prev, meta.kind, kind));
    setMeta({ ...meta, kind });
  };

  useEffect(() => {
    if (!open) return;
    setTid(templateId);
    setView('wording');
    if (templateId) {
      qcApi.getTemplate(templateId).then((r) => {
        if (!r) return;
        // CS-669: a published template's saved draft carries its OWN name and pass mark (live
        // only once published), so the editor opens on those, not on the row's live ones.
        const eff = effectiveTemplateMeta(r.template, r.latest);
        const sc = eff.ratingScale || {};
        setMeta({ name: eff.name || '', kind: r.template.kind || 'inspection', scaleType: sc.type === 'numeric' ? 'numeric' : 'passfail', max: sc.max || 5, passThreshold: sc.passThreshold ?? 80, isPublished: !!r.template.is_published });
        setCustomerId(r.template.client_id || '');
        setAreas(r.latest?.schema?.areas?.length ? r.latest.schema.areas : [blankArea(r.template.kind || 'inspection')]);
        setNameI18n(r.latest?.schema?.nameI18n || null);
      }).catch((e) => toast.error(e.message || 'Could not load template'));
    } else {
      setMeta({ name: '', kind: presetKind || 'inspection', scaleType: 'passfail', max: 5, passThreshold: 80, isPublished: false });
      setCustomerId(clientId || '');
      setAreas([blankArea(presetKind || 'inspection')]);
      setNameI18n(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, templateId, clientId]);

  // The customer roster, as the pickers elsewhere read it (every company but an archived one —
  // see the selector's own note; a brand-new customer must be choosable).
  const customers = useMemo(
    () => [...(selectActiveClients(state) || [])].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [state],
  );
  const customerOptions = useMemo(
    () => [{ value: '', label: 'Choose a customer…' }, ...customers.map((c) => ({ value: c.id, label: customerLabel(c) || c.id }))],
    [customers],
  );
  // An inspection NEVER carries a customer, whatever the caller passed — the refusal and
  // the value sent to the server are computed from the same expression, so they cannot
  // disagree (the server refuses an inspection that arrives with one).
  const effectiveClientId = meta.kind === 'checklist' ? (customerId || null) : null;
  const customerName = effectiveClientId ? (selectClientById(state, effectiveClientId)?.name || effectiveClientId) : null;
  // ONE rule, shared with the server route and the demo stub (lib/inspections). It only
  // gates a CREATE: editing an existing template never re-asks, because moving a checklist
  // between customers is a different operation ("Start from…" makes a copy instead).
  const customerBlock = tid ? null : createTemplateRefusal({ kind: meta.kind, clientId: effectiveClientId });

  const ratingScale = () => (meta.scaleType === 'numeric'
    ? { type: 'numeric', max: Number(meta.max) || 5, passThreshold: Number(meta.passThreshold) || 80 }
    : { type: 'passfail', passThreshold: Number(meta.passThreshold) || 80 });
  // `i18n` (CS-193, CS-850): each label's lines ride beside it; the server cleans them and
  // translates whatever has no line for today's English on save (src/lib/checklistI18n).
  const withI18n = (n) => (n.i18n ? { i18n: n.i18n } : {});
  const schema = () => ({ areas: areas.map((a) => ({ id: a.id, label: a.label, siteAreaId: a.siteAreaId || null, ...withI18n(a), items: (a.items || []).map((i) => ({ id: i.id, label: i.label, photoRequired: !!i.photoRequired, naAllowed: !!i.naAllowed, ...withI18n(i) })) })), ...(nameI18n ? { nameI18n } : {}) });

  // QR-1: the physical areas of the customer's building(s), to link a checklist section
  // to. Read from the store because `site.cleaningAreas` lives in the blob; empty when the
  // customer has none yet, and the picker then says so instead of offering nothing.
  const siteAreaOptions = useMemo(() => {
    if (meta.kind !== 'checklist' || !effectiveClientId) return [];
    const out = [{ value: '', label: 'Not linked to an area' }];
    for (const s of selectSitesForClient(state, effectiveClientId) || []) {
      for (const a of Array.isArray(s?.cleaningAreas) ? s.cleaningAreas : []) {
        if (a?.id) out.push({ value: a.id, label: a.label || 'Untitled area' });
      }
    }
    return out.length > 1 ? out : [];
  }, [state, meta.kind, effectiveClientId]);

  const setArea = (id, patch) => setAreas((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const setItem = (aid, iid, patch) => setAreas((prev) => prev.map((a) => (a.id === aid ? { ...a, items: a.items.map((i) => (i.id === iid ? { ...i, ...patch } : i)) } : a)));

  const persist = async ({ publish } = {}) => {
    if (!meta.name.trim()) { toast.error('Name the template first'); return; }
    setBusy(true);
    try {
      let id = tid;
      if (!id) { const r = await qcApi.createTemplate({ name: meta.name.trim(), kind: meta.kind, ratingScale: ratingScale(), clientId: effectiveClientId }); id = r.template.id; setTid(id); }
      // The server translates every section and item into Spanish and Creole on this save (CS-850).
      await qcApi.saveTemplate(id, { name: meta.name.trim(), ratingScale: ratingScale(), schema: schema() });
      if (publish) await qcApi.publishTemplate(id);
      toast.success(publish ? 'Template published' : 'Template saved');
      onSaved?.(id);
      onClose();
    } catch (e) { toast.error(e.message || 'Could not save the template'); }
    finally { setBusy(false); }
  };

  // Plain-language scoring help + a live conversion of the pass % into an item-score
  // equivalent (80% of a 0-5 scale = 4.0), so the two side-by-side scales stop reading
  // as unrelated. Mirrors the fallbacks in ratingScale() so help and saved value agree.
  const threshold = Number.isFinite(Number(meta.passThreshold)) ? Number(meta.passThreshold) : 80;
  const maxN = Number(meta.max) > 0 ? Number(meta.max) : 5;
  // An item-less CHECKLIST can never be completed, so it cannot be published (the server
  // and the demo stub refuse it too — ONE rule, lib/inspections.publishRefusal). Shown as
  // visible text, not a tooltip: a tooltip never appears on a phone.
  const publishBlock = publishRefusal({ kind: meta.kind, schema: schema() });

  const scoreHelp = meta.scaleType === 'numeric'
    ? `Score each item from 0 to ${maxN}. The inspection's score is the average across items, as a percent of ${maxN}. It passes at ${threshold}% or higher, i.e. an average of about ${(threshold / 100 * maxN).toFixed(1)} out of ${maxN}.`
    : `The score is the percent of items marked Pass. It passes at ${threshold}% or higher.`;

  return (
    <Modal open={open} onClose={onClose} title={`${tid ? 'Edit' : 'New'} ${meta.kind === 'checklist' ? 'checklist' : 'inspection'} template`}>
      <div className="tpl-editor">
        <FormField label="Name" required value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} placeholder="e.g. Monthly walkthrough" />
        <div className="form-group">
          <label className="form-label">Type</label>
          {tid || presetKind ? (
            <>
              <div className="tpl-type-locked">{meta.kind === 'checklist' ? 'Checklist' : 'Inspection (scored)'}</div>
              <p className="form-help">{tid
                ? 'Type is set when a template is created and cannot be changed. Create a new template to use the other type.'
                : 'Creating a checklist for this customer.'}</p>
            </>
          ) : (
            <div className="tab-container-line" role="group">
              <button type="button" className={`tab-btn ${meta.kind === 'inspection' ? 'active' : ''}`} onClick={() => setKind('inspection')}>Inspection (scored)</button>
              <button type="button" className={`tab-btn ${meta.kind === 'checklist' ? 'active' : ''}`} onClick={() => setKind('checklist')}>Checklist</button>
            </div>
          )}
        </div>
        {/* WHOSE checklist is this? Asked before the areas, because the answer decides
            which menus it will appear in and it cannot be changed afterwards. Locked when
            the caller already knows (the customer page, step 6's assignments view) or when
            the template exists. Inspections skip it entirely — they are company-wide. */}
        {meta.kind === 'checklist' && (
          <div className="form-group">
            <label className="form-label">Customer</label>
            {tid || clientId ? (
              <>
                <div className="tpl-type-locked">{customerName || 'Starter (no customer)'}</div>
                <p className="form-help">{tid
                  ? 'A checklist belongs to one customer and stays with it. To reuse this one elsewhere, copy it from that customer with “Start from…”.'
                  : 'This checklist will be filed under this customer, and will show in its menus only.'}</p>
              </>
            ) : (
              <>
                <FilterSelect
                  value={customerId}
                  onChange={setCustomerId}
                  options={customerOptions}
                  ariaLabel="Customer"
                />
                <p className="form-help">
                  {customerBlock || 'This checklist will show in this customer’s menus only. Other customers get their own.'}
                </p>
              </>
            )}
          </div>
        )}
        {meta.kind === 'inspection' && (
          <div className="form-group">
            <label className="form-label">Rating</label>
            <div className="tab-container-line" role="group">
              <button type="button" className={`tab-btn ${meta.scaleType === 'passfail' ? 'active' : ''}`} onClick={() => setMeta({ ...meta, scaleType: 'passfail' })}>Pass / Fail</button>
              <button type="button" className={`tab-btn ${meta.scaleType === 'numeric' ? 'active' : ''}`} onClick={() => setMeta({ ...meta, scaleType: 'numeric' })}>Numeric</button>
            </div>
            <div className="tpl-scale-row">
              {meta.scaleType === 'numeric' && (
                <label className="tpl-scale-field">Out of <input className="input" type="number" min="2" value={meta.max} onChange={(e) => setMeta({ ...meta, max: e.target.value })} /></label>
              )}
              <label className="tpl-scale-field">Pass at <input className="input" type="number" min="0" max="100" value={meta.passThreshold} onChange={(e) => setMeta({ ...meta, passThreshold: e.target.value })} />%</label>
            </div>
            <p className="form-help">{scoreHelp}</p>
          </div>
        )}

        <div className="tab-container-line" role="tablist" aria-label={t('translations.viewAria')}>
          <button type="button" role="tab" aria-selected={view === 'wording'} className={`tab-btn ${view === 'wording' ? 'active' : ''}`} onClick={() => setView('wording')}>{t('translations.tabWording')}</button>
          <button type="button" role="tab" aria-selected={view === 'translations'} className={`tab-btn ${view === 'translations' ? 'active' : ''}`} onClick={() => setView('translations')}>{t('translations.tabTranslations')}</button>
        </div>
        {view === 'translations' ? <TemplateTranslations areas={areas} onChange={setAreas} name={meta.name} nameI18n={nameI18n} onNameChange={setNameI18n} /> : (<>
        <div className="form-label" style={{ marginTop: 4 }}>Areas &amp; items</div>
        {/* What "N/A ok" actually does on a CHECKLIST, said once, in visible text — a
            tooltip never appears on a phone, and the office needs to know it is handing out
            the only exception the cleaner has to finishing the list. Inspections keep their
            own meaning (a rating), so they are not told this. */}
        {meta.kind === 'checklist' && (
          <p className="form-help">
            Tick “N/A ok” on an item a cleaner may mark N/A on a night it doesn’t apply — it then counts as done,
            so they can finish the checklist and clock out without it. Leave it off and the item has to be done.
          </p>
        )}
        {areas.map((a) => (
          <div className="tpl-area" key={a.id}>
            <div className="tpl-area-head">
              <input className="input" placeholder="Area (e.g. Restrooms)" value={a.label} onChange={(e) => setArea(a.id, { label: e.target.value })} />
              {areas.length > 1 && <button type="button" className="btn-icon" aria-label="Remove area" onClick={() => setAreas((p) => p.filter((x) => x.id !== a.id))}><Icon name="trash" size={14} /></button>}
            </div>
            {/* QR-1: which part of the BUILDING this section covers. Optional, and the
                picker is only offered when the customer actually has cleaning areas set
                up on its location — an empty dropdown would just be a question nobody can
                answer. Linking it is what lets the QR code on that wall say when the area
                was last cleaned. */}
            {siteAreaOptions.length > 0 && (
              <div className="tpl-area-link">
                <span className="form-label">Building area</span>
                <FilterSelect
                  value={a.siteAreaId || ''}
                  onChange={(v) => setArea(a.id, { siteAreaId: v || null })}
                  options={siteAreaOptions}
                  ariaLabel={`Building area covered by ${a.label || 'this section'}`}
                />
              </div>
            )}
            {(a.items || []).map((i) => (
              <div className="tpl-item" key={i.id}>
                <input className="input" placeholder="Item to check" value={i.label} onChange={(e) => setItem(a.id, i.id, { label: e.target.value })} />
                <label className="tpl-item-flag"><input type="checkbox" checked={!!i.photoRequired} onChange={(e) => setItem(a.id, i.id, { photoRequired: e.target.checked })} /> photo</label>
                {/* `naTouched` marks this as the office's own decision, so switching the
                    template's type never re-defaults it out from under them. */}
                <label className="tpl-item-flag"><input type="checkbox" checked={!!i.naAllowed} onChange={(e) => setItem(a.id, i.id, { naAllowed: e.target.checked, naTouched: true })} /> N/A ok</label>
                {a.items.length > 1 && <button type="button" className="btn-icon" aria-label="Remove item" onClick={() => setArea(a.id, { items: a.items.filter((x) => x.id !== i.id) })}><Icon name="x" size={13} /></button>}
              </div>
            ))}
            <button type="button" className="btn btn-link" onClick={() => setArea(a.id, { items: [...a.items, blankItem(meta.kind)] })}>Add item</button>
          </div>
        ))}
        <button type="button" className="btn btn-outline" onClick={() => setAreas((p) => [...p, blankArea(meta.kind)])}>Add area</button>
        </>)}

        {/* CS-669: on a live template, Save draft changes nothing anyone fills until Publish. */}
        {meta.isPublished && <div className="text-xs text-muted">{t('tplEditor.liveNote')}</div>}
        {publishBlock && <div className="text-xs text-muted">{publishBlock} — you can still save a draft.</div>}
        {/* Not a warning to read past: without a customer the server refuses the create, so
            both buttons are unreachable until one is chosen. The reason is beside the
            picker above, as visible text (a tooltip never appears on a phone). */}
        {customerBlock && <div className="text-xs text-muted">{customerBlock}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !!customerBlock} onClick={() => persist({ publish: false })}>Save draft</button>
          <button type="button" className="btn btn-success" disabled={busy || !!publishBlock || !!customerBlock} onClick={() => persist({ publish: true })}>Save &amp; publish</button>
        </div>
      </div>
    </Modal>
  );
}
