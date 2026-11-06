import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Badge from './Badge';
import Avatar from './Avatar';
import { usePermission } from '../hooks/usePermission';
import { useAuth } from '../hooks/useAuth';
import { useFromHere } from '../hooks/useFromHere';
import { crewPaths } from '../lib/crewPaths';
import { useChecklistResults } from '../hooks/useCleanChecklist';
import { useStore } from '../store';
import { selectEffectiveCrewForJob, selectUserById } from '../store/selectors';
import {
  checklistFor, hasChecklistOnClean,
  isChecklistComplete, latestChecklistFor,
} from '../lib/crewChecklist';
import { coveredCleanerId } from '../lib/jobCover';
import { checklistFillRefusal, checklistOpensAt } from '../lib/checklistWindow';
import { fmtDate, fmtTime } from '../lib/dates';
import * as qcApi from '../lib/qcApi';
import { useT } from '../i18n/react';
import { templateNameOf, templateNameLabel } from '../lib/checklistI18n';

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
// THE CLEANER FILLS IT ON ITS OWN PAGE (Cleaner Hub, Brief B, UI_RULES §166): "Complete
// checklist" opens My Checklist (`crewPaths.checklist(jobId)` → pages/crew/CrewChecklist) —
// a photo, a comment and "not completed" on every task, saved on the phone as they go, one
// Save at the end. It REPLACED opening the ChecklistFill pop-up from here, which stays the
// office's standalone "Fill a checklist" (the Quality hub).
//
// A result belongs to a cleaner by `completed_by_user_id` — the only actor the backend
// stores. It was matched on the completer's NAME until CS-403: the real backend returns
// no name, so the filter kept every row and two cleaners sharing a checklist on one
// clean each read the other's completion. Display names come from the roster.
// Every word is a catalog line in the viewer's language (CS-193); a checklist's NAME is the
// office's own and shows as written.

// `clockedIn` = the viewer is clocked in to this clean (My Day and the crew visit pass it):
// past the clean's window a cleaner still on the clock there may fill it in (CS-690).
export default function CleanChecklist({ job, client, compact = false, variant = 'card', onStatus = null, clockedIn = false }) {
  const t = useT();
  const canPerform = usePermission('qc.checklist.perform');
  const { currentUser } = useAuth();
  const state = useStore();
  const navigate = useNavigate();
  const nav = useFromHere();

  // 🔴 THE CLEAN'S WINDOW (CS-690, lib/checklistWindow): a checklist counts for this clean only
  // when filled in from 2 h before it starts to its end plus the grace — or later while still
  // clocked in here. Outside that the server keeps a fill but NOT for this clean (it cannot
  // unlock the clock-out or stamp an area "last cleaned"), so the button says when it opens
  // instead of taking a fill that would not count. It used to take the night-before fill that
  // unlocked the next morning's clock-out. The clock ticks while it waits to open.
  const graceMins = state.opsSettings?.autoCloseGraceMins;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const fillRefusal = job ? checklistFillRefusal(job, nowMs, { graceMins, clockedIn }) : null;
  useEffect(() => {
    if (fillRefusal !== 'early') return undefined;
    const id = setInterval(() => setNowMs(Date.now()), 30000);
    return () => clearInterval(id);
  }, [fillRefusal]);
  const opensAt = fillRefusal === 'early' ? checklistOpensAt(job, { graceMins }) : null;
  const fillNote = fillRefusal === 'early'
    ? t('checklist.clean.opensAt', { time: fmtTime(new Date(opensAt).toISOString()) })
    : (fillRefusal === 'late' ? t('checklist.clean.closed') : null);
  const [templates, setTemplates] = useState([]); // roster mode only — for names of unfinished assignments

  // ONE read per clean, shared with the clock button on the same card (hooks/
  // useCleanChecklist): two fetches could show a finished checklist beside a Clock-out
  // button that still read it as unfinished. `results` is null while unread or unreadable.
  const { results, loading } = useChecklistResults(job?.id || null);

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
  // THIS CLEAN'S CUSTOMER, not the company (R2, plan step 5). Every checklist that can be
  // named here — the roster's picks and the covered cleaner's — is filed under this
  // customer, because `crewChecklists` lives on the customer row; a cover is served the
  // COVERED cleaner's pick at the SAME customer, so the scoped read still names it. At ~750
  // customers the company-wide read was ~3,750 rows to label a handful.
  const templateClientId = client?.id || job?.clientId || null;
  useEffect(() => {
    if (!needTemplates || !templateClientId) { setTemplates([]); return undefined; }
    let alive = true;
    qcApi.listTemplates({ kind: 'checklist', clientId: templateClientId })
      .then((list) => { if (alive) setTemplates(list || []); })
      .catch(() => { if (alive) setTemplates([]); });
    return () => { alive = false; };
  }, [needTemplates, templateClientId]);
  // The checklist's NAME in the reader's language (CS-850: the row carries its published version's
  // name lines, lib/checklistI18n templateNameOf).
  const templateName = useCallback((id) => {
    const row = id ? templates.find((x) => x.id === id) : null;
    return row?.name ? templateNameOf(row, t.lang) : null;
  }, [templates, t.lang]);

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

  // The cleaner's own checklist page for this clean, with the referrer so its back arrow
  // returns here (My Day, the crew visit).
  const openChecklist = () => { if (job?.id) navigate(crewPaths.checklist(job.id), { state: nav }); };

  // The cover's own line, shown wherever they see their checklist. `coverNote` is the
  // whole of R8 in one sentence: whose shift this is and which checklist that makes theirs.
  const coverNote = coveredName ? (
    <div className="text-xs clean-checklist-cover">
      {t('checklist.clean.coveringFor', { name: coveredName })}
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
        coversName: covers ? (selectUserById(state, covers)?.name || t('checklist.clean.anotherCleaner')) : null,
        res: latestChecklistFor(results, { templateId: tid, userId: u.id }),
      };
    });
    return (
      <div className={`clean-checklist${compact ? ' clean-checklist-compact' : ''}`}>
        <div className="clean-checklist-head">
          <span className="clean-checklist-title">{t('checklist.clean.byCleaner')}</span>
        </div>
        <ul className="crew-checklist-list">
          {rows.map(({ u, tid, res, coversName }) => (
            <li key={u.id} className="crew-checklist-row">
              <span className="crew-checklist-who"><Avatar user={u} size="sm" /><span className="crew-checklist-wname">{u.name}</span></span>
              <span className="crew-checklist-status">
                {tid
                  ? (res ? <Badge variant={isChecklistComplete(res) ? 'green' : 'amber'}>{res.completed_count}/{res.total_count}</Badge> : <Badge variant="slate">{t('checklist.clean.notStarted')}</Badge>)
                  : null}
              </span>
              <span className="crew-checklist-what">
                {tid
                  ? <>{templateName(tid) || (res?.template_snapshot?.name ? templateNameLabel(res.template_snapshot.name, res.template_snapshot.schema?.nameI18n, t.lang) : null) || t('checklist.clean.checklist')}</>
                  : <span className="text-muted">{t('checklist.clean.noChecklist')}</span>}
                {coversName ? <span className="text-muted"> · {t('checklist.clean.coveringForLower', { name: coversName })}</span> : null}
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
      return !myLatest ? (
        <div className="text-xs text-muted">
          {t('checklist.clean.setForThisClean')}
          {coveredName ? ` ${t('checklist.clean.coveringForSentence', { name: coveredName })}` : ''}
        </div>
      ) : null;
    }
    return (
      <>
        {coverNote}
        <button type="button" className="btn btn-gold" disabled={!!fillRefusal} onClick={openChecklist}>
          {isChecklistComplete(myLatest)
            ? t('checklist.clean.completeDone')
            : (myLatest
              ? t('checklist.clean.finishProgress', { done: myLatest.completed_count, total: myLatest.total_count })
              : t('checklist.clean.complete'))}
        </button>
        {fillNote && <div className="text-xs text-muted">{fillNote}</div>}
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
        <span className="clean-checklist-title">{t('checklist.clean.checklist')}</span>
        {myLatest ? (
          <Badge variant={complete ? 'green' : 'amber'}>{t('checklist.clean.doneProgress', { done: myLatest.completed_count, total: myLatest.total_count })}</Badge>
        ) : loading ? (
          <span className="text-xs text-muted">{t('common.loading')}</span>
        ) : results === null ? (
          // Offline, or the read failed: "Not started" would be a claim we can't make (UX-13).
          <span className="text-xs text-muted">{t('checklist.clean.notCheckedYet')}</span>
        ) : (
          <Badge variant="slate">{t('checklist.clean.notStarted')}</Badge>
        )}
      </div>
      {coverNote}
      {myLatest && (
        <div className="text-xs text-muted">
          {myLatest.template_snapshot?.name || t('checklist.clean.checklist')}
          {completedByName ? ` · ${completedByName}` : ''}
          {myLatest.performed_at ? ` · ${fmtDate(myLatest.performed_at)}` : ''}
        </div>
      )}
      {myTemplateId && canPerform && (
        <button type="button" className="btn btn-link" style={{ paddingLeft: 0 }} disabled={!!fillRefusal} onClick={openChecklist}>
          {myLatest ? t('checklist.clean.completeAgain') : t('checklist.clean.complete')}
        </button>
      )}
      {myTemplateId && canPerform && fillNote && <div className="text-xs text-muted">{fillNote}</div>}
      {myTemplateId && !canPerform && !myLatest && (
        <div className="text-xs text-muted">{t('checklist.clean.assignedCrewCompletes')}</div>
      )}
    </div>
  );
}
