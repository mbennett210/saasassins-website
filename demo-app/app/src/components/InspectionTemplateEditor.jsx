import { useEffect, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import Icon from './Icon';
import { useToast } from './Toast';
import * as qcApi from '../lib/qcApi';
import { publishRefusal } from '../lib/inspections';

// Versioned inspection/checklist template editor (areas → items + a rating scale).
// Save persists to the working draft; Publish freezes the version so submitted
// records never drift. See CLEANSPACE_SWEPT.md §5.6.
const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 9)}`;
const blankArea = () => ({ id: rid('a'), label: '', items: [{ id: rid('i'), label: '', photoRequired: false, naAllowed: true }] });

export default function InspectionTemplateEditor({ open, onClose, templateId = null, onSaved, presetKind = null }) {
  const toast = useToast();
  const [tid, setTid] = useState(templateId);
  const [meta, setMeta] = useState({ name: '', kind: 'inspection', scaleType: 'passfail', max: 5, passThreshold: 80, isPublished: false });
  const [areas, setAreas] = useState([blankArea()]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTid(templateId);
    if (templateId) {
      qcApi.getTemplate(templateId).then((r) => {
        if (!r) return;
        const sc = r.template.rating_scale || {};
        setMeta({ name: r.template.name || '', kind: r.template.kind || 'inspection', scaleType: sc.type === 'numeric' ? 'numeric' : 'passfail', max: sc.max || 5, passThreshold: sc.passThreshold ?? 80, isPublished: !!r.template.is_published });
        setAreas(r.latest?.schema?.areas?.length ? r.latest.schema.areas : [blankArea()]);
      }).catch((e) => toast.error(e.message || 'Could not load template'));
    } else {
      setMeta({ name: '', kind: presetKind || 'inspection', scaleType: 'passfail', max: 5, passThreshold: 80, isPublished: false });
      setAreas([blankArea()]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, templateId]);

  const ratingScale = () => (meta.scaleType === 'numeric'
    ? { type: 'numeric', max: Number(meta.max) || 5, passThreshold: Number(meta.passThreshold) || 80 }
    : { type: 'passfail', passThreshold: Number(meta.passThreshold) || 80 });
  const schema = () => ({ areas: areas.map((a) => ({ id: a.id, label: a.label, items: (a.items || []).map((i) => ({ id: i.id, label: i.label, photoRequired: !!i.photoRequired, naAllowed: !!i.naAllowed })) })) });

  const setArea = (id, patch) => setAreas((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const setItem = (aid, iid, patch) => setAreas((prev) => prev.map((a) => (a.id === aid ? { ...a, items: a.items.map((i) => (i.id === iid ? { ...i, ...patch } : i)) } : a)));

  const persist = async ({ publish } = {}) => {
    if (!meta.name.trim()) { toast.error('Name the template first'); return; }
    setBusy(true);
    try {
      let id = tid;
      if (!id) { const r = await qcApi.createTemplate({ name: meta.name.trim(), kind: meta.kind, ratingScale: ratingScale() }); id = r.template.id; setTid(id); }
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
                : 'Creating a checklist to bind to this account.'}</p>
            </>
          ) : (
            <div className="tab-container-line" role="group">
              <button type="button" className={`tab-btn ${meta.kind === 'inspection' ? 'active' : ''}`} onClick={() => setMeta({ ...meta, kind: 'inspection' })}>Inspection (scored)</button>
              <button type="button" className={`tab-btn ${meta.kind === 'checklist' ? 'active' : ''}`} onClick={() => setMeta({ ...meta, kind: 'checklist' })}>Checklist</button>
            </div>
          )}
        </div>
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

        <div className="form-label" style={{ marginTop: 4 }}>Areas &amp; items</div>
        {areas.map((a) => (
          <div className="tpl-area" key={a.id}>
            <div className="tpl-area-head">
              <input className="input" placeholder="Area (e.g. Restrooms)" value={a.label} onChange={(e) => setArea(a.id, { label: e.target.value })} />
              {areas.length > 1 && <button type="button" className="btn-icon" aria-label="Remove area" onClick={() => setAreas((p) => p.filter((x) => x.id !== a.id))}><Icon name="trash" size={14} /></button>}
            </div>
            {(a.items || []).map((i) => (
              <div className="tpl-item" key={i.id}>
                <input className="input" placeholder="Item to check" value={i.label} onChange={(e) => setItem(a.id, i.id, { label: e.target.value })} />
                <label className="tpl-item-flag"><input type="checkbox" checked={!!i.photoRequired} onChange={(e) => setItem(a.id, i.id, { photoRequired: e.target.checked })} /> photo</label>
                <label className="tpl-item-flag"><input type="checkbox" checked={!!i.naAllowed} onChange={(e) => setItem(a.id, i.id, { naAllowed: e.target.checked })} /> N/A ok</label>
                {a.items.length > 1 && <button type="button" className="btn-icon" aria-label="Remove item" onClick={() => setArea(a.id, { items: a.items.filter((x) => x.id !== i.id) })}><Icon name="x" size={13} /></button>}
              </div>
            ))}
            <button type="button" className="btn btn-link" onClick={() => setArea(a.id, { items: [...a.items, { id: rid('i'), label: '', photoRequired: false, naAllowed: true }] })}>Add item</button>
          </div>
        ))}
        <button type="button" className="btn btn-outline" onClick={() => setAreas((p) => [...p, blankArea()])}>Add area</button>

        {publishBlock && <div className="text-xs text-muted">{publishBlock} — you can still save a draft.</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => persist({ publish: false })}>Save draft</button>
          <button type="button" className="btn btn-success" disabled={busy || !!publishBlock} onClick={() => persist({ publish: true })}>Save &amp; publish</button>
        </div>
      </div>
    </Modal>
  );
}
