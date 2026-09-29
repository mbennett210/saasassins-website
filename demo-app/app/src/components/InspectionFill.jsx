import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import MediaGallery from './MediaGallery';
import { useStore } from '../store';
import { useAuth } from '../hooks/useAuth';
import { useToast } from './Toast';
import { selectSites, selectSiteById, selectClientById } from '../store/selectors';
import * as qcApi from '../lib/qcApi';
import SearchSelect from './SearchSelect';

// Perform an inspection: pick a PUBLISHED template + site → the frozen template
// snapshot renders → rate each item (+ comment) → submit (scored server-side via
// lib/inspections). The record keeps the snapshot so history never drifts. §5.6.
export default function InspectionFill({ open, onClose, onSubmitted, presetSiteId = '' }) {
  const state = useStore();
  const { currentUser } = useAuth();
  const toast = useToast();
  const sites = useMemo(() => selectSites(state), [state]);

  const [templates, setTemplates] = useState([]);
  const [templateId, setTemplateId] = useState('');
  const [siteId, setSiteId] = useState(presetSiteId);
  const [record, setRecord] = useState(null); // created inspection (has template_snapshot)
  const [answers, setAnswers] = useState({}); // { itemId: { rating, comment } }
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTemplateId(''); setSiteId(presetSiteId); setRecord(null); setAnswers({});
    qcApi.listTemplates().then((t) => setTemplates((t || []).filter((x) => x.is_published))).catch(() => setTemplates([]));
  }, [open, presetSiteId]);

  const start = async () => {
    if (!templateId) { toast.error('Pick a template'); return; }
    setBusy(true);
    try {
      const site = siteId ? selectSiteById(state, siteId) : null;
      const client = site ? selectClientById(state, site.clientId) : null;
      const rec = await qcApi.createInspection({
        templateId, siteId: siteId || null, clientId: site?.clientId || null,
        siteName: site?.name || null, clientName: client?.name || null, inspectorName: currentUser?.name || null,
      });
      setRecord(rec);
    } catch (e) { toast.error(e.message || 'Could not start the inspection'); }
    finally { setBusy(false); }
  };

  const submit = async () => {
    const snap = record?.template_snapshot;
    const items = [];
    for (const area of snap?.schema?.areas || []) {
      for (const it of area.items || []) {
        const a = answers[it.id] || {};
        items.push({ item_key: it.id, label: `${area.label || 'Area'}. ${it.label || 'Item'}`, rating: a.rating ?? null, comment: a.comment || null });
      }
    }
    setBusy(true);
    try {
      await qcApi.submitInspection({ id: record.id, items });
      toast.success('Inspection submitted');
      onSubmitted?.();
      onClose();
    } catch (e) { toast.error(e.message || 'Could not submit'); }
    finally { setBusy(false); }
  };

  const snap = record?.template_snapshot;
  const scaleType = snap?.rating_scale?.type === 'numeric' ? 'numeric' : 'passfail';
  const max = snap?.rating_scale?.max || 5;
  const setAns = (id, patch) => setAnswers((p) => ({ ...p, [id]: { ...p[id], ...patch } }));

  return (
    <Modal open={open} onClose={onClose} title={record ? `Inspect. ${snap?.name || ''}` : 'New inspection'}>
      {!record ? (
        <div>
          <div className="form-group">
            <label className="form-label">Template</label>
            <SearchSelect
              value={templateId}
              onChange={(id) => setTemplateId(id || '')}
              options={templates.map((t) => ({ value: t.id, label: t.name }))}
              placeholder="Select a published template…"
              searchPlaceholder="Search templates…"
              emptyText="No published templates"
            />
            {templates.length === 0 && <div className="text-xs text-muted" style={{ marginTop: 4 }}>No published templates yet. Create and publish one first.</div>}
          </div>
          <div className="form-group">
            <label className="form-label">Location</label>
            <SearchSelect
              value={siteId}
              onChange={(id) => setSiteId(id || '')}
              options={sites.map((s) => { const c = selectClientById(state, s.clientId); return { value: s.id, label: c?.name || s.name, sublabel: s.address || '' }; })}
              placeholder="no specific location"
              searchPlaceholder="Search locations…"
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy || !templateId} onClick={start}>Start inspection</button>
          </div>
        </div>
      ) : (
        <div className="insp-fill">
          {(snap?.schema?.areas || []).map((area) => (
            <div className="insp-area" key={area.id}>
              <div className="insp-area-label">{area.label || 'Area'}</div>
              {(area.items || []).map((it) => {
                const a = answers[it.id] || {};
                return (
                  <div className="insp-item" key={it.id}>
                    <div className="insp-item-label">{it.label || 'Item'}{it.photoRequired ? <span className="text-muted text-xs"> · photo</span> : null}</div>
                    {scaleType === 'numeric' ? (
                      <select className="input insp-rate-num" value={a.rating ?? ''} onChange={(e) => setAns(it.id, { rating: e.target.value })}>
                        <option value="">—</option>
                        {Array.from({ length: max }, (_, n) => <option key={n + 1} value={n + 1}>{n + 1}</option>)}
                        {it.naAllowed && <option value="na">N/A</option>}
                      </select>
                    ) : (
                      <div className="insp-rate-pf">
                        <button type="button" className={`tab-btn ${a.rating === 'pass' ? 'active' : ''}`} onClick={() => setAns(it.id, { rating: 'pass' })}>Pass</button>
                        <button type="button" className={`tab-btn ${a.rating === 'fail' ? 'active' : ''}`} onClick={() => setAns(it.id, { rating: 'fail' })}>Fail</button>
                        {it.naAllowed && <button type="button" className={`tab-btn ${a.rating === 'na' ? 'active' : ''}`} onClick={() => setAns(it.id, { rating: 'na' })}>N/A</button>}
                      </div>
                    )}
                    <input className="input insp-item-comment" placeholder="Comment (optional)" value={a.comment || ''} onChange={(e) => setAns(it.id, { comment: e.target.value })} />
                  </div>
                );
              })}
              {/* Per-section photos: the inspector attaches shots to THIS section, and
                  the report groups them under it. Keyed by the frozen template area id
                  (account_media.area_id) + the inspection record id. Needs a site
                  (media is site-scoped); a site-less ad-hoc inspection shows the tip below. */}
              {siteId ? (
                <MediaGallery
                  siteId={siteId}
                  scope="inspection"
                  refId={record.id}
                  areaId={area.id}
                  label="Photos for this section"
                  hint="Attached to this section of the report. Images up to 10MB, video up to 200MB."
                />
              ) : null}
            </div>
          ))}
          {!siteId && (
            <p className="text-xs text-muted">
              Tip: start an inspection with a site selected to attach photos to each section of the report.
            </p>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>Submit inspection</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
