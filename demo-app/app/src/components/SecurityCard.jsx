import { forwardRef, useImperativeHandle, useState } from 'react';
import { useStore, useDispatch } from '../store';
import { ACTIONS } from '../store/reducer';
import { usePermission } from '../hooks/usePermission';
import { useAuth } from '../hooks/useAuth';
import { useToast } from './Toast';
import { selectSiteById, selectUserById } from '../store/selectors';
import * as securityApi from '../lib/securityApi';
import { fmtRelative } from '../lib/dates';

// Per-site door/alarm codes — set here, masked by default, revealed on demand. Codes
// are AES-256-GCM at rest, set + revealed via /api/site-security (the key never
// reaches the browser; reveal re-checks the caller is a manager or assigned crew).
// In demo mode (no backend) they round-trip through the blob as a STUB: marker.
// Gated ops.security.view (see) / ops.revealCodes (reveal) / ops.edit (set).
//
// `embedded` = rendered inside an already-open editor (LocationCard): the code
// inputs show directly (no read view, no its own Edit/Save/Cancel), and the parent
// persists them by calling the imperative `save()` handle from its own Save.
const noEnter = (e) => { if (e.key === 'Enter') e.preventDefault(); };

function SecurityCard({ siteId, embedded = false, readOnly = false }, ref) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const { currentUser } = useAuth();
  const canView = usePermission('ops.security.view');
  const canReveal = usePermission('ops.revealCodes');
  const canEdit = usePermission('ops.edit');

  const site = selectSiteById(state, siteId);
  const sec = site?.security || {};
  const stub = securityApi.isSecurityStub();

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => ({ doorCode: '', alarmCode: '', codeHint: sec.codeHint || '' }));
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState({});

  const save = async () => {
    // No-op when nothing was entered/changed, so a parent Save that never touched the
    // codes doesn't rewrite them.
    const dirty = form.doorCode !== '' || form.alarmCode !== '' || (form.codeHint || '') !== (sec.codeHint || '');
    if (!dirty) return;
    setBusy(true);
    try {
      if (stub) {
        const next = { ...sec, codeHint: form.codeHint || null, updatedAt: new Date().toISOString(), updatedByUserId: currentUser?.id || null };
        if (form.doorCode !== '') next.doorCodeCipher = form.doorCode ? `STUB:${form.doorCode}` : null;
        if (form.alarmCode !== '') next.alarmCodeCipher = form.alarmCode ? `STUB:${form.alarmCode}` : null;
        dispatch({ type: ACTIONS.UPDATE_SITE, id: siteId, patch: { security: next } });
      } else {
        await securityApi.setSecurity({
          siteId,
          doorCode: form.doorCode === '' ? undefined : form.doorCode,
          alarmCode: form.alarmCode === '' ? undefined : form.alarmCode,
          codeHint: form.codeHint,
        });
      }
      // Standalone shows its own confirmation + closes; embedded stays quiet (the
      // parent's Save toast covers it) and leaves the fields for the parent to unmount.
      if (!embedded) { toast.success('Access codes updated'); setEditing(false); setRevealed({}); }
    } catch (e) { toast.error(e.message || 'Could not save codes'); throw e; }
    finally { setBusy(false); }
  };

  useImperativeHandle(ref, () => ({ save }));

  if (!canView) return null;

  const hasDoor = !!sec.doorCodeCipher;
  const hasAlarm = !!sec.alarmCodeCipher;
  const updatedByName = sec.updatedByUserId ? (selectUserById(state, sec.updatedByUserId)?.name || null) : null;

  const reveal = async (which) => {
    try {
      let code;
      if (stub) {
        const cipher = which === 'alarm' ? sec.alarmCodeCipher : sec.doorCodeCipher;
        code = typeof cipher === 'string' ? cipher.replace(/^STUB:/, '') : null;
        if (!code) { toast.error('No code set'); return; }
      } else {
        code = await securityApi.revealCode({ siteId, which });
      }
      setRevealed((r) => ({ ...r, [which]: code }));
      setTimeout(() => setRevealed((r) => { const n = { ...r }; delete n[which]; return n; }), 20000);
    } catch (e) { toast.error(e.message || 'Could not reveal the code'); }
  };

  const codeInputs = (
    <>
      <input className="input" type="text" autoComplete="off" onKeyDown={noEnter} placeholder={hasDoor ? 'New door code (blank = keep)' : 'Door code'} value={form.doorCode} onChange={(e) => setForm({ ...form, doorCode: e.target.value })} />
      <input className="input" type="text" autoComplete="off" onKeyDown={noEnter} placeholder={hasAlarm ? 'New alarm code (blank = keep)' : 'Alarm code'} value={form.alarmCode} onChange={(e) => setForm({ ...form, alarmCode: e.target.value })} />
      <input className="input" type="text" onKeyDown={noEnter} placeholder="Hint (e.g. 'ends 42'). Shown without revealing" value={form.codeHint} onChange={(e) => setForm({ ...form, codeHint: e.target.value })} />
    </>
  );

  // Embedded: parent is already in edit mode — set the codes right here, no chrome.
  if (embedded) {
    if (!canEdit) return null;
    return (
      <div className="form-group security-card">
        <label className="form-label">Door &amp; alarm codes</label>
        <div className="security-edit">{codeInputs}</div>
      </div>
    );
  }

  return (
    <div className="form-group security-card">
      <label className="form-label">Door &amp; alarm codes</label>
      {!editing ? (
        <div className="security-view">
          <div className="security-row">
            <span className="security-key">Door</span>
            {hasDoor ? (
              <>
                <span className="security-code">{revealed.door || '••••'}</span>
                {sec.codeHint && !revealed.door && <span className="text-muted text-xs">hint: {sec.codeHint}</span>}
                {canReveal && <button type="button" className="btn btn-link" onClick={() => reveal('door')}>{revealed.door ? 'Hide' : 'Reveal'}</button>}
              </>
            ) : <span className="text-muted text-sm">Not set</span>}
          </div>
          <div className="security-row">
            <span className="security-key">Alarm</span>
            {hasAlarm ? (
              <>
                <span className="security-code">{revealed.alarm || '••••'}</span>
                {canReveal && <button type="button" className="btn btn-link" onClick={() => reveal('alarm')}>{revealed.alarm ? 'Hide' : 'Reveal'}</button>}
              </>
            ) : <span className="text-muted text-sm">Not set</span>}
          </div>
          {sec.updatedAt && <p className="text-muted text-xs" style={{ margin: '2px 0 0' }}>Updated {fmtRelative(sec.updatedAt)}{updatedByName ? ` by ${updatedByName}` : ''}</p>}
          {canEdit && !readOnly && <button type="button" className="btn btn-link" style={{ paddingLeft: 0 }} onClick={() => { setForm({ doorCode: '', alarmCode: '', codeHint: sec.codeHint || '' }); setEditing(true); }}>Edit</button>}
        </div>
      ) : (
        <div className="security-edit">
          {codeInputs}
          <div className="security-edit-actions">
            <button type="button" className="btn btn-link" onClick={() => setEditing(false)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default forwardRef(SecurityCard);
