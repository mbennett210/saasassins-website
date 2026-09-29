import { useCallback, useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import Select from './Select';
import Avatar from './Avatar';
import Badge from './Badge';
import EmptyState from './EmptyState';
import Icon from './Icon';
import { useStore, useDispatch } from '../store';
import { ACTIONS } from '../store/reducer';
import { useToast } from './Toast';
import { useAuth } from '../hooks/useAuth';
import { selectJobsForClient, selectUserById, selectActiveUsers } from '../store/selectors';
import { pruneCrewChecklists } from '../lib/crewChecklist';
import { compareUsersByName } from '../lib/roles';
import * as qcApi from '../lib/qcApi';

// Master "who gets which checklist, where" organizer. Assignments live scattered on each
// customer row (client.crewChecklists); this aggregates them into ONE view grouped by
// customer, with a cleaner filter, and — crucially — SURFACES strays (a cleaner still
// holding a checklist but no longer on the account's upcoming cleans) instead of hiding
// them the way the per-account Service Setup card does. There is no location-wide default
// (R3): a cleaner with no pick reads "No checklist", which is a normal state (R1).
// It also lets a manager assign a cleaner who isn't on the schedule yet. Edits stage
// locally and commit per-customer via UPDATE_CLIENT_OPS on Save (gated ops.edit upstream).

export default function ChecklistAssignmentsModal({ open, onClose, canEdit = false }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const { currentUser } = useAuth();

  const [templates, setTemplates] = useState([]);
  const [cleanerFilter, setCleanerFilter] = useState(''); // '' = all cleaners
  const [drafts, setDrafts] = useState({});               // { [clientId]: { crewChecklists } }
  const [extraRows, setExtraRows] = useState({});         // { [clientId]: string[] } proactively-added cleaner ids

  useEffect(() => {
    if (!open) return;
    setDrafts({}); setExtraRows({}); setCleanerFilter('');
    qcApi.listTemplates({ kind: 'checklist' })
      .then((t) => setTemplates((t || []).filter((x) => x.is_published)))
      .catch(() => setTemplates([]));
  }, [open]);

  const activeUsers = useMemo(() => selectActiveUsers(state).slice().sort(compareUsersByName), [state]);

  // Scheduled cleaner ids per client (upcoming / in-progress cleans) — same basis as the
  // per-account Service Setup card, so "scheduled here" means the same thing everywhere.
  const scheduledByClient = useMemo(() => {
    const map = new Map();
    for (const c of state.clients || []) {
      const jobs = selectJobsForClient(state, c.id).filter((j) => j.status === 'upcoming' || j.status === 'in_progress');
      map.set(c.id, new Set(jobs.flatMap((j) => j.crewIds || [])));
    }
    return map;
  }, [state]);

  const effective = useCallback((client) => {
    const d = drafts[client.id];
    return { crewChecklists: d ? d.crewChecklists : (client.crewChecklists || {}) };
  }, [drafts]);

  const editClient = (client, patch) => setDrafts((prev) => {
    const cur = prev[client.id] || { crewChecklists: { ...(client.crewChecklists || {}) } };
    return { ...prev, [client.id]: { ...cur, ...patch } };
  });
  const setCleaner = (client, uid, val) => {
    const cur = (drafts[client.id]?.crewChecklists) || client.crewChecklists || {};
    const next = { ...cur };
    if (val) next[uid] = val; else delete next[uid];
    editClient(client, { crewChecklists: next });
  };
  const addCleanerRow = (client, uid) => {
    if (!uid) return;
    setExtraRows((prev) => ({ ...prev, [client.id]: [...new Set([...(prev[client.id] || []), uid])] }));
  };

  // Template options: 'No checklist' + published templates + a keep-row for an
  // assigned-but-unpublished template so we never silently drop it.
  const templateOptions = useCallback((currentId) => {
    const opts = [{ value: '', label: 'No checklist' }];
    for (const t of templates) opts.push({ value: t.id, label: t.name });
    if (currentId && !templates.some((t) => t.id === currentId)) opts.push({ value: currentId, label: 'Currently assigned checklist' });
    return opts;
  }, [templates]);

  // One card per customer that has checklist assignments or scheduled cleaners.
  const cards = useMemo(() => {
    const out = [];
    for (const c of state.clients || []) {
      const eff = effective(c);
      const scheduled = scheduledByClient.get(c.id) || new Set();
      const extra = extraRows[c.id] || [];
      const cleanerIds = [...new Set([...Object.keys(eff.crewChecklists), ...scheduled, ...extra])];
      if (cleanerIds.length === 0) continue;
      if (cleanerFilter && !cleanerIds.includes(cleanerFilter)) continue;
      const cleaners = cleanerIds
        .map((uid) => {
          const u = selectUserById(state, uid);
          if (!u) return null; // deleted users are swept on DELETE_USER; guard anyway
          const tid = eff.crewChecklists[uid] || '';
          return { u, tid, scheduled: scheduled.has(uid), stray: !!eff.crewChecklists[uid] && !scheduled.has(uid) };
        })
        .filter(Boolean)
        .filter((r) => !cleanerFilter || r.u.id === cleanerFilter)
        .sort((a, b) => compareUsersByName(a.u, b.u));
      const addable = activeUsers.filter((u) => !cleanerIds.includes(u.id));
      out.push({ client: c, cleaners, addable });
    }
    return out.sort((a, b) => (a.client.name || '').localeCompare(b.client.name || ''));
  }, [state, effective, scheduledByClient, extraRows, cleanerFilter, activeUsers]);

  const dirtyIds = useMemo(() => Object.keys(drafts).filter((cid) => {
    const c = (state.clients || []).find((x) => x.id === cid);
    if (!c) return false;
    const d = drafts[cid];
    return JSON.stringify(pruneCrewChecklists(d.crewChecklists)) !== JSON.stringify(pruneCrewChecklists(c.crewChecklists || {}));
  }), [drafts, state.clients]);

  const save = () => {
    let n = 0;
    for (const cid of dirtyIds) {
      const c = (state.clients || []).find((x) => x.id === cid);
      if (!c) continue;
      const d = drafts[cid];
      dispatch({
        type: ACTIONS.UPDATE_CLIENT_OPS,
        id: cid,
        patch: { crewChecklists: pruneCrewChecklists(d.crewChecklists) },
        actorName: currentUser?.name,
        summary: 'Checklist assignments were updated.',
      });
      n += 1;
    }
    toast.success(n ? `Saved ${n} customer${n > 1 ? 's' : ''}` : 'No changes');
    setDrafts({}); setExtraRows({});
    onClose();
  };

  const cleanerFilterOptions = useMemo(() => (
    [{ value: '', label: 'All cleaners' }, ...activeUsers.map((u) => ({ value: u.id, label: u.name }))]
  ), [activeUsers]);

  return (
    <Modal open={open} onClose={onClose} title="Checklist assignments" size="wide">
      <div className="cla-filter">
        <label className="cla-filter-label" htmlFor="cla-cleaner">Filter by cleaner</label>
        <Select id="cla-cleaner" ariaLabel="Filter by cleaner" value={cleanerFilter} onChange={setCleanerFilter} options={cleanerFilterOptions} />
        <span className="text-xs text-muted">Each cleaner's checklist is per customer — the same person can have a different one at each account, and “No checklist” is normal.</span>
      </div>

      {cards.length === 0 ? (
        <EmptyState icon={<Icon name="forms" size={28} />} title="Nothing to show" message={cleanerFilter ? 'That cleaner has no assignments or upcoming cleans.' : 'No customers have checklist assignments or scheduled cleaners yet.'} />
      ) : (
        <div className="cla-list">
          {cards.map(({ client, cleaners, addable }) => (
            <div className="card cla-card" key={client.id}>
              <div className="cla-card-head">
                <span className="cla-cust">{client.name}</span>
              </div>
              {cleaners.map(({ u, tid, stray }) => (
                <div className="cla-row" key={u.id}>
                  <span className="cla-who">
                    <Avatar initials={u.initials} variant={u.avatar} size="sm" />
                    <span className="cla-name">{u.name}</span>
                    {stray && <Badge variant="amber">Not scheduled</Badge>}
                  </span>
                  <span className="cla-what">
                    <Select ariaLabel={`Checklist for ${u.name} at ${client.name}`} value={tid} onChange={(v) => setCleaner(client, u.id, v)} options={templateOptions(tid)} placeholder="No checklist" disabled={!canEdit} />
                  </span>
                </div>
              ))}
              {canEdit && addable.length > 0 && (
                <div className="cla-row cla-row-add">
                  <span className="cla-who cla-who-add">Assign a cleaner</span>
                  <span className="cla-what">
                    <Select ariaLabel={`Assign another cleaner at ${client.name}`} value="" onChange={(v) => addCleanerRow(client, v)} options={[{ value: '', label: '＋ Add a cleaner…' }, ...addable.map((u) => ({ value: u.id, label: u.name }))]} placeholder="＋ Add a cleaner…" />
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="modal-actions cla-actions">
        <span className="save-hint">{dirtyIds.length ? `${dirtyIds.length} customer${dirtyIds.length > 1 ? 's' : ''} changed` : 'No changes yet'}</span>
        <button type="button" className="btn btn-outline" onClick={onClose}>{canEdit ? 'Cancel' : 'Close'}</button>
        {canEdit && <button type="button" className="btn btn-primary" onClick={save} disabled={dirtyIds.length === 0}>Save changes</button>}
      </div>
    </Modal>
  );
}
