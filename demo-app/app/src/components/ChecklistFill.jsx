import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import { useStore } from '../store';
import { useAuth } from '../hooks/useAuth';
import { useToast } from './Toast';
import { selectVisibleSitesFor, selectSiteById, selectClientById } from '../store/selectors';
import * as qcApi from '../lib/qcApi';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import SearchSelect from './SearchSelect';

// Complete a checklist: pick a PUBLISHED checklist template + site → tick the
// frozen items (+ note) → submit to checklist_results (items inline, no scoring).
// Reuses the inspection template system (kind='checklist'). See CLEANSPACE_SWEPT.md §5.6.
// presetTemplateId + jobId let a clean (My Day / JobDetail) open this straight to
// the bound checklist for the account, pre-locked to that site, and stamp the
// completed result onto the job (checklist_results.job_id). Without them it's the
// standalone Quality-hub flow: pick a published checklist + site.
export default function ChecklistFill({ open, onClose, onSubmitted, presetSiteId = '', presetTemplateId = '', jobId = null }) {
  const state = useStore();
  const { currentUser } = useAuth();
  const toast = useToast();
  const online = useOnlineStatus();
  // Crew pick from their assigned sites only (manager-safe: returns all sites for
  // non-crew), and MUST pick one — the server scopes crew submits to assigned
  // accounts, so an unscoped "no site" submit would 403.
  const isCrew = currentUser?.role === 'crew';
  const sites = useMemo(() => selectVisibleSitesFor(state, currentUser), [state, currentUser]);

  const [templates, setTemplates] = useState([]);
  const [templateId, setTemplateId] = useState('');
  const [siteId, setSiteId] = useState(presetSiteId);
  const [schema, setSchema] = useState(null);
  const [checks, setChecks] = useState({});
  const [busy, setBusy] = useState(false);

  const load = async (id) => {
    if (!id) { toast.error('Pick a checklist'); return; }
    setBusy(true);
    try { const r = await qcApi.getTemplate(id); setSchema(r?.published?.schema || { areas: [] }); }
    catch (e) { toast.error(e.message || 'Could not load the checklist'); }
    finally { setBusy(false); }
  };
  const start = () => load(templateId);

  useEffect(() => {
    if (!open) return;
    setTemplateId(presetTemplateId || ''); setSiteId(presetSiteId); setSchema(null); setChecks({});
    // Bound-to-a-clean open: skip the picker and load the account's checklist directly.
    if (presetTemplateId) { load(presetTemplateId); return; }
    qcApi.listTemplates({ kind: 'checklist' }).then((t) => setTemplates((t || []).filter((x) => x.is_published))).catch(() => setTemplates([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, presetSiteId, presetTemplateId]);

  const submit = async () => {
    const items = [];
    for (const area of schema?.areas || []) {
      for (const it of area.items || []) {
        const c = checks[it.id] || {};
        items.push({ key: it.id, label: `${area.label || 'Area'}. ${it.label || 'Item'}`, checked: !!c.checked, note: c.note || null });
      }
    }
    setBusy(true);
    try {
      const site = siteId ? selectSiteById(state, siteId) : null;
      const res = await qcApi.submitChecklist({ templateId: templateId || presetTemplateId, siteId: siteId || null, clientId: site?.clientId || null, jobId: jobId || null, items, completedByUserId: currentUser?.id || null });
      // Offline → buffered on-device (qcApi returns pending_sync); OfflineChecklistSync
      // replays it when the network returns. Tell the crew it's SAVED, not failed.
      toast.success(res?.pending_sync
        ? 'Saved on this device. It’ll sync when you’re back online.'
        : 'Checklist submitted');
      onSubmitted?.();
      onClose();
    } catch (e) { toast.error(e.message || 'Could not submit'); }
    finally { setBusy(false); }
  };

  const setChk = (id, patch) => setChecks((p) => ({ ...p, [id]: { ...p[id], ...patch } }));

  return (
    <Modal open={open} onClose={onClose} title={schema ? 'Complete checklist' : 'New checklist'}>
      {!schema ? (
        <div>
          <div className="form-group">
            <label className="form-label">Checklist</label>
            <SearchSelect
              value={templateId}
              onChange={(id) => setTemplateId(id || '')}
              options={templates.map((t) => ({ value: t.id, label: t.name }))}
              placeholder="Select a published checklist…"
              searchPlaceholder="Search checklists…"
              emptyText="No published checklists"
            />
            {templates.length === 0 && <div className="text-xs text-muted" style={{ marginTop: 4 }}>No published checklists yet. Create a template with type “Checklist” and publish it.</div>}
          </div>
          <div className="form-group">
            <label className="form-label">Location</label>
            <SearchSelect
              value={siteId}
              onChange={(id) => setSiteId(id || '')}
              options={sites.map((s) => { const c = selectClientById(state, s.clientId); return { value: s.id, label: c?.name || s.name, sublabel: s.address || '' }; })}
              placeholder={isCrew ? 'Select your location…' : 'no specific location'}
              searchPlaceholder="Search locations…"
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy || !templateId || (isCrew && !siteId)} onClick={start}>Start</button>
          </div>
        </div>
      ) : (
        <div className="insp-fill">
          {!online && (
            <p className="text-xs" role="status" style={{ margin: '0 0 8px', color: 'var(--color-semantic-warning-700)' }}>
              You’re offline. Your completed checklist will be saved on this device and synced automatically when you’re back online.
            </p>
          )}
          {(schema.areas || []).map((area) => (
            <div className="insp-area" key={area.id}>
              <div className="insp-area-label">{area.label || 'Area'}</div>
              {(area.items || []).map((it) => {
                const c = checks[it.id] || {};
                return (
                  <div className="chk-item" key={it.id}>
                    <label className="chk-item-check">
                      <input type="checkbox" checked={!!c.checked} onChange={(e) => setChk(it.id, { checked: e.target.checked })} />
                      <span>{it.label || 'Item'}</span>
                    </label>
                    <input className="input chk-item-note" placeholder="Note" value={c.note || ''} onChange={(e) => setChk(it.id, { note: e.target.value })} />
                  </div>
                );
              })}
            </div>
          ))}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>Submit checklist</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
