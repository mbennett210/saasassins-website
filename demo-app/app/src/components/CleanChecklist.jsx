import { useCallback, useEffect, useMemo, useState } from 'react';
import Badge from './Badge';
import Avatar from './Avatar';
import ChecklistFill from './ChecklistFill';
import { usePermission } from '../hooks/usePermission';
import { useAuth } from '../hooks/useAuth';
import { useChecklistResults } from '../hooks/useCleanChecklist';
import { useStore } from '../store';
import { selectEffectiveCrewForJob, selectUserById } from '../store/selectors';
import {
  checklistFor, hasChecklistOnClean,
  isChecklistComplete, latestChecklistFor,
} from '../lib/crewChecklist';
import { coveredCleanerId } from '../lib/jobCover';
import { fmtDate } from '../lib/dates';
import * as qcApi from '../lib/qcApi';

// The cleaner's checklist, surfaced INSIDE a clean (My Day + JobDetail). A checklist is
// assigned PER CLEANER and only per cleaner (client.crewChecklists, lib/crewChecklist);
// there is no location-wide default (R3), so a cleaner with no pick simply has none — a
// normal state, never a warning (R1). What renders depends on WHO is looking:
//   • a cleaner ON this clean (My Day, the crew visit step) sees THEIR OWN checklist and
//     completes it, locked to the clean's site + job;
//   • a manager/admin viewing the clean (JobDetail) sees the ROSTER — each cleaner, their
//     assigned checklist or "No checklist", its completion — whenever anyone at the
//     location holds one.
// Self-hides when nothing is assigned and nothing was ever completed here. Records are a
// component-local projection (checklist_results, keyed by job_id).
//
// A result belongs to a cleaner by `completed_by_user_id` — the only actor the backend
// stores. It was matched on the completer's NAME until CS-403: the real backend returns
// no name, so the filter kept every row and two cleaners sharing a checklist on one
// clean each read the other's completion. Display names come from the roster.

export default function CleanChecklist({ job, client, compact = false, variant = 'card', onStatus = null }) {
  const canPerform = usePermission('qc.checklist.perform');
  const { currentUser } = useAuth();
  const state = useStore();
  const [open, setOpen] = useState(false);
  const [fillTemplateId, setFillTemplateId] = useState('');
  const [templates, setTemplates] = useState([]); // roster mode only — for names of unfinished assignments

  // ONE read per clean, shared with the clock button on the same card (hooks/
  // useCleanChecklist): two fetches could show a finished checklist beside a Clock-out
  // button that still read it as unfinished. `results` is null while unread or unreadable.
  const { results, loading, reload } = useChecklistResults(job?.id || null);

  const viewerId = currentUser?.id || null;
  const crew = useMemo(() => selectEffectiveCrewForJob(state, job).map((c) => c.user), [state, job]);
  const viewerIsCrewOnJob = !!(viewerId && crew.some((u) => u.id === viewerId));
  // ROSTER when a manager/admin (NOT a cleaner on this clean) views a card AND at least one
  // cleaner ON THIS CLEAN resolves a checklist (lib/crewChecklist.hasChecklistOnClean, the
  // same resolver the rows use). Asking the LOCATION instead rendered a titled card whose
  // every row read "No checklist", and an empty one on a clean with no crew.
  const crewIds = useMemo(() => crew.map((u) => u.id), [crew]);
  const rosterMode = variant === 'card' && !viewerIsCrewOnJob
    && hasChecklistOnClean({ client, job, crewIds });

  // WHO IS THE VIEWER COVERING FOR on this clean (R8)? A cover fills the COVERED cleaner's
  // checklist here and nowhere else, and from step 4 that checklist gates their clock-out,
  // so it has to be said in words BEFORE they start — not inferred from a template name
  // they have never seen. Naming the checklist needs the template list, which the roster
  // already fetches; a cover clean fetches it for the same reason.
  const coveredId = coveredCleanerId(job, viewerId);
  const coveredName = coveredId ? (selectUserById(state, coveredId)?.name || null) : null;
  const needTemplates = rosterMode || !!coveredId;
  useEffect(() => {
    if (!needTemplates) return;
    qcApi.listTemplates({ kind: 'checklist' }).then((t) => setTemplates(t || [])).catch(() => setTemplates([]));
  }, [needTemplates]);
  const templateName = useCallback((id) => (id ? (templates.find((t) => t.id === id)?.name || null) : null), [templates]);

  // The viewer's OWN checklist (My Day, the crew step). A cleaner's completion is matched
  // to their USER ID — the only actor the backend stores (CS-403). A manager who is not on
  // the clean has no pick of their own, so this is null for them and the roster above is
  // what they see.
  const myTemplateId = checklistFor({ client, job, userId: viewerId });
  const myLatest = latestChecklistFor(results, { templateId: myTemplateId, userId: viewerIsCrewOnJob ? viewerId : null });

  // Report {hasChecklist, complete} up for the crew visit step. Runs before any early
  // return so a checklist-less clean still reports hasChecklist:false.
  useEffect(() => {
    if (!onStatus || results === null) return;
    onStatus({ hasChecklist: !!myTemplateId, complete: isChecklistComplete(myLatest) });
  }, [results, myTemplateId, myLatest, onStatus]);

  const openFill = (tid) => { setFillTemplateId(tid || ''); setOpen(true); };
  const fillModal = (
    <ChecklistFill
      open={open}
      onClose={() => setOpen(false)}
      onSubmitted={() => { setOpen(false); reload(); }}
      presetSiteId={job?.siteId || ''}
      presetTemplateId={fillTemplateId || ''}
      jobId={job?.id || null}
    />
  );

  // The cover's own line, shown wherever they see their checklist. `coverNote` is the
  // whole of R8 in one sentence: whose shift this is and which checklist that makes theirs.
  const coverNote = coveredName ? (
    <div className="text-xs clean-checklist-cover">
      Covering for {coveredName}
      {templateName(myTemplateId) ? <> · {templateName(myTemplateId)}</> : null}
    </div>
  ) : null;

  // ── Manager roster: each cleaner → assigned checklist → status ──
  if (rosterMode) {
    const rows = crew.map((u) => {
      const tid = checklistFor({ client, job, userId: u.id });
      const covers = coveredCleanerId(job, u.id);
      return {
        u, tid, covers,
        coversName: covers ? (selectUserById(state, covers)?.name || 'another cleaner') : null,
        res: latestChecklistFor(results, { templateId: tid, userId: u.id }),
      };
    });
    return (
      <div className={`clean-checklist${compact ? ' clean-checklist-compact' : ''}`}>
        <div className="clean-checklist-head">
          <span className="clean-checklist-title">Checklists by cleaner</span>
        </div>
        <ul className="crew-checklist-list">
          {rows.map(({ u, tid, res, coversName }) => (
            <li key={u.id} className="crew-checklist-row">
              <span className="crew-checklist-who"><Avatar initials={u.initials} variant={u.avatar} size="sm" /><span className="crew-checklist-wname">{u.name}</span></span>
              <span className="crew-checklist-status">
                {tid
                  ? (res ? <Badge variant={isChecklistComplete(res) ? 'green' : 'amber'}>{res.completed_count}/{res.total_count}</Badge> : <Badge variant="slate">Not started</Badge>)
                  : null}
              </span>
              <span className="crew-checklist-what">
                {tid
                  ? <>{templateName(tid) || res?.template_snapshot?.name || 'Checklist'}</>
                  : <span className="text-muted">No checklist</span>}
                {coversName ? <span className="text-muted"> · covering for {coversName}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // No checklist for the viewer and nothing completed here → render nothing (and stay
  // hidden while loading, so a checklist-less clean never flashes a card).
  if (!myTemplateId && (results === null || !myLatest)) return null;

  // ── Crew step (CrewJobVisit): ONE gold button that opens the fill modal ──
  if (variant === 'button') {
    if (myTemplateId && !canPerform) {
      return !myLatest ? <div className="text-xs text-muted">A checklist is set for this clean.{coveredName ? ` Covering for ${coveredName}.` : ''}</div> : null;
    }
    return (
      <>
        {coverNote}
        <button type="button" className="btn btn-gold" onClick={() => openFill(myTemplateId)}>
          {isChecklistComplete(myLatest)
            ? '✓ Checklist complete'
            : (myLatest ? `Finish checklist · ${myLatest.completed_count}/${myLatest.total_count}` : 'Complete checklist')}
        </button>
        {fillModal}
      </>
    );
  }

  // ── Single-cleaner card (My Day) ──
  const complete = isChecklistComplete(myLatest);
  // Who completed it, from the ROSTER — the record stores only the user id (CS-403).
  const completedByName = myLatest?.completed_by_user_id
    ? (selectUserById(state, myLatest.completed_by_user_id)?.name || null)
    : null;
  return (
    <div className={`clean-checklist${compact ? ' clean-checklist-compact' : ''}`}>
      <div className="clean-checklist-head">
        <span className="clean-checklist-title">Checklist</span>
        {myLatest ? (
          <Badge variant={complete ? 'green' : 'amber'}>{myLatest.completed_count}/{myLatest.total_count} done</Badge>
        ) : loading ? (
          <span className="text-xs text-muted">Loading…</span>
        ) : results === null ? (
          // Offline, or the read failed: "Not started" would be a claim we can't make (UX-13).
          <span className="text-xs text-muted">Not checked yet</span>
        ) : (
          <Badge variant="slate">Not started</Badge>
        )}
      </div>
      {coverNote}
      {myLatest && (
        <div className="text-xs text-muted">
          {myLatest.template_snapshot?.name || 'Checklist'}
          {completedByName ? ` · ${completedByName}` : ''}
          {myLatest.performed_at ? ` · ${fmtDate(myLatest.performed_at)}` : ''}
        </div>
      )}
      {myTemplateId && canPerform && (
        <button type="button" className="btn btn-link" style={{ paddingLeft: 0 }} onClick={() => openFill(myTemplateId)}>
          {myLatest ? 'Complete again' : 'Complete checklist'}
        </button>
      )}
      {myTemplateId && !canPerform && !myLatest && (
        <div className="text-xs text-muted">A checklist is assigned for this clean. The crew completes it on the clean.</div>
      )}
      {fillModal}
    </div>
  );
}
