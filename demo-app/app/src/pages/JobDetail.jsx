import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import { useDispatch, useStore, useJobsHydrated } from '../store';
import { ACTIONS } from '../store/reducer';
import {
  selectJobById, selectClientById, selectSiteById, selectServiceById, selectUsers, selectContactById,
  selectSeriesJobs, selectSeriesMaster, selectCrewConflicts, selectClockContextForJob,
  selectEffectiveExpectedCleanMins, selectCleaningAreasForSite,
  isJobAssignedToUser, selectEffectiveCrewForJob, selectIsJobUnassigned,
} from '../store/selectors';
import { usePermission, useCanEditJobs } from '../hooks/usePermission';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../components/Toast';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { savedMsg } from '../lib/offlineCopy';
import DetailHeader from '../components/DetailHeader';
import Badge, { statusBadgeVariant } from '../components/Badge';
import Avatar from '../components/Avatar';
import ConfirmDialog from '../components/ConfirmDialog';
import SeriesScopeModal from '../components/SeriesScopeModal';
import FormField from '../components/FormField';
import Select from '../components/Select';
import Icon from '../components/Icon';
import TimeClockHistory from '../components/TimeClockHistory';
import { seriesFromDate, STARTED_SERIES_NOTE } from '../lib/seriesScope';
import PhoneLink from '../components/PhoneLink';
import CleaningAreasEditor from '../components/CleaningAreasEditor';
import MediaGallery from '../components/MediaGallery';
import CrewJobVisit from '../components/CrewJobVisit';
import ScheduleBlocksEditor from '../components/ScheduleBlocksEditor';
import AccountNotesPanel from '../components/AccountNotesPanel';
import CleanChecklist from '../components/CleanChecklist';
import { fmtDate, fmtDateLong, fmtTimeRange, splitIso, composeIso, composeEndIso, dayOfWeekIso, normalizeHm, isStrictHm } from '../lib/dates';
import { describeRecurrence, seriesBlocksOf, blockDayLabel, blockTimeLabel, dayPlanFromBlocks, dayPatternOf } from '../lib/recurrence';
import { coverCandidates } from '../lib/jobCover';
import { isUserOffOn } from '../store/timeOffRules';
import * as securityApi from '../lib/securityApi';
import { jobGrantsSiteAccess, statusChangeKept, CODE_REVEAL_WINDOW } from '../lib/siteAccess';
import * as timeApi from '../lib/timeApi';
import { laborOnJob } from '../lib/timeCancel';

const STATUS_LABEL = { upcoming: 'Upcoming', in_progress: 'In Progress', done: 'Done', cancelled: 'Cancelled', missed: 'Missed' };

// Field actions on the Details card (mobile). `mapsDir` deep-links the site address
// into turn-by-turn directions via Google Maps' universal cross-platform URL (opens
// the Maps app on iOS/Android, the web map on desktop); `telHref` mirrors PhoneLink's
// digit-strip so the Call button dials the same normalized number.
const mapsDir = (address) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
const telHref = (phone) => `tel:${String(phone).replace(/[^\d+]/g, '')}`;
const smsHref = (phone) => `sms:${String(phone).replace(/[^\d+]/g, '')}`;

export default function JobDetail() {
  const { jobId } = useParams();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const online = useOnlineStatus(); // status transitions dispatch into the store; offline they buffer + sync
  const navigate = useNavigate();
  const nav = useFromHere();
  const canEdit = usePermission('schedule.edit');
  const canReset = usePermission('schedule.reset');
  // Edit and Delete write crew, times and the site, which the server keeps only from
  // someone who may edit jobs, never crew (jobsGuard). Start / Done / Cancel stay on
  // canEdit: they change status, which the server keeps from anyone within the limits of
  // mayMoveTo below. (Cancel also settles the clean's labor through
  // /api/time/job-cancelled, which requirePermission gates on schedule.edit itself, crew
  // grants included: HANDOFF S78.)
  const canEditJob = useCanEditJobs();
  const { currentUser } = useAuth();
  // Crew open a clean from My Day (they can't see the Schedule list), so their
  // back link returns there; managers go back to the Schedule.
  const backTo = canEdit ? '/schedule' : '/my-day';
  const backLabel = canEdit ? 'Schedule' : 'My Day';
  const [showPhotos, setShowPhotos] = useState(false);

  const job = selectJobById(state, jobId);
  // The status buttons offer only what the server keeps (jobsGuard): owner / admin by
  // role, and a manager who may edit jobs, change any status; anyone it sanitizes (crew
  // granted schedule.edit or .reset) never takes a clean out of Cancelled and never
  // touches a visit more than a day out (statusChangeKept, lib/siteAccess.js).
  const statusWhole = currentUser?.role === 'owner' || currentUser?.role === 'admin' || canEditJob;
  const mayMoveTo = (to) => statusWhole || statusChangeKept(job, to);
  const client = job ? selectClientById(state, job.clientId) : null;
  const site = job ? selectSiteById(state, job.siteId) : null;
  const service = job ? selectServiceById(state, job.serviceId) : null;
  const siteContact = site?.siteContactId ? selectContactById(state, site.siteContactId) : null;
  const users = selectUsers(state);

  const seriesJobs = job?.seriesId ? selectSeriesJobs(state, job.seriesId) : [];
  const seriesMaster = job?.seriesId ? selectSeriesMaster(state, job.seriesId) : null;
  // Whole-series operations need the FULL job set, not the boot window — see the note on
  // SeriesScopeModal below. Same flag Schedule gates TOP_UP on, for the same reason.
  const jobsHydrated = useJobsHydrated();
  // The master is what resolves the DEFAULT block's days + times. Passing it is what
  // makes the summary name every block instead of only the days that carry an
  // override — see the asymmetry note on seriesBlocksOf.
  const recurrenceDesc = seriesMaster?.recurrence ? describeRecurrence(seriesMaster.recurrence, seriesMaster) : null;
  const isWeeklySeries = seriesMaster?.recurrence?.frequency === 'weekly';

  // 🔴 SOME SERIES RUN MORE THAN ONE CLEAN ON THE SAME DAY, AND THE RECURRENCE CANNOT
  // SAY SO. `dayOverrides` holds exactly ONE entry per day-of-week, so a site cleaned
  // twice on a Tuesday is inexpressible: the blocks reconstruction shows one Tuesday
  // block, and a "this & all future" save re-times BY DAY-OF-WEEK — which would land
  // both of that day's cleans on the same time and silently merge them.
  //
  // This is not hypothetical: 9 of 134 weekly series on the live account do it today
  // (Red Dot, Bella Smiles, Commencement Bank – Auburn, People's Injury Network,
  // Red Hawk Fire Protection, Sunrise Park…). Some run 100+ occurrences.
  //
  // The hazard predates the block editor — `dayPatches` always re-timed by weekday —
  // but unlocking the day chips made the editor reach further, and the new breakdown
  // renders a one-block-per-day model that LOOKS authoritative while omitting the
  // second clean. So the series-wide EDIT path is closed for these until the
  // recurrence can hold more than one block per day. Delete is unaffected: it works
  // off the materialized rows and needs no model.
  const seriesRunsTwiceInADay = useMemo(() => {
    if (!job?.seriesId || !isWeeklySeries) return false;
    const perDay = new Map();
    for (const j of seriesJobs) {
      if (j.status !== 'upcoming') continue;
      const k = splitIso(j.startAt).date;
      const n = (perDay.get(k) || 0) + 1;
      if (n > 1) return true;
      perDay.set(k, n);
    }
    return false;
  }, [job?.seriesId, isWeeklySeries, seriesJobs]);

  // The series' schedule blocks — the inverse of what the blocks editor wrote at
  // creation. Shared with the view-mode breakdown and the delete prompt so all
  // three surfaces describe the series identically.
  const seriesBlocks = useMemo(() => (isWeeklySeries ? seriesBlocksOf(seriesMaster) : null), [isWeeklySeries, seriesMaster]);

  // Crew names for a block. Resolve then DROP unknowns rather than printing
  // "Unknown": a crew id can outlive its user (DELETE_USER only scrubs the boot
  // window, so an out-of-window master keeps the departed id in dayOverrides).
  const blockCrewLabel = (crewIds) => {
    const named = (crewIds || []).map((id) => users.find((u) => u.id === id)?.name).filter(Boolean);
    return named.length ? named.join(', ') : 'No named crew';
  };
  // Which block this occurrence belongs to — so the breakdown answers "and which
  // one am I looking at?" rather than leaving the user to match times by eye.
  const thisDow = job ? dayOfWeekIso(job.startAt) : null;

  // Ops data surfaced to crew on the clean (expected time, access, instructions).
  const expectedMins = job ? selectEffectiveExpectedCleanMins(state, { clientId: job.clientId, siteId: job.siteId }) : null;
  const cleaningAreas = job ? selectCleaningAreasForSite(state, job.siteId) : [];
  // Site-specific notes FIRST, then the account-level instructions — both shown.
  // (Account-level used to shadow the site's: on a multi-site account like Harnish,
  // the store-specific notes were never displayed to the crew working that store.)
  const accessInstructions = site?.accessNotes || '';

  // Door/alarm code reveal — the purpose-built crew control (CREW_AUDIT #11).
  // ops.revealCodes always; otherwise CREW on a clean at this site, from a day before it
  // starts to a day after it ends. That is the server's own rule (lib/siteAccess.js,
  // imported by api/site-security's reveal, which takes that path for crew only), so the
  // button never renders where the call would 403. 20s auto-hide like SecurityCard.
  const siteSec = site?.security || {};
  const canRevealPerm = usePermission('ops.revealCodes'); // manager role default
  const canRevealHere = useMemo(() => {
    if (canRevealPerm) return true;
    if (!site || !currentUser?.id || currentUser.role !== 'crew') return false;
    const now = Date.now();
    return (state.jobs || []).some((j) =>
      j.siteId === site.id && jobGrantsSiteAccess(j, currentUser.id, { ...CODE_REVEAL_WINDOW, now }));
  }, [state, site, currentUser, canRevealPerm]);
  const [revealedCodes, setRevealedCodes] = useState({});
  const revealSiteCode = async (which) => {
    if (revealedCodes[which]) { setRevealedCodes((r) => { const n = { ...r }; delete n[which]; return n; }); return; }
    try {
      let code;
      if (securityApi.isSecurityStub()) {
        const cipher = which === 'alarm' ? siteSec.alarmCodeCipher : siteSec.doorCodeCipher;
        code = typeof cipher === 'string' ? cipher.replace(/^STUB:/, '') : null;
        if (!code) { toast.error('No code set'); return; }
      } else {
        code = await securityApi.revealCode({ siteId: site.id, which });
      }
      setRevealedCodes((r) => ({ ...r, [which]: code }));
      setTimeout(() => setRevealedCodes((r) => { const n = { ...r }; delete n[which]; return n; }), 20000);
    } catch (e) { toast.error(e.message || 'Could not reveal the code'); }
  };
  const tagOptions = (state.tags || []).filter((t) => t.scope === 'client' || t.scope === 'all');
  const fmtMins = (m) => { const h = Math.floor(m / 60), mm = m % 60; return h ? (mm ? `${h}h ${mm}m` : `${h}h`) : `${mm}m`; };

  const conflicts = useMemo(() => {
    if (!job) return [];
    // EFFECTIVE crew (named + standing minus exclusions), not raw crewIds — a
    // standing-crew clean carries an empty crewIds and every warning stayed dark
    // for exactly the accounts most exposed to the Sept 1 time-off collision.
    const ids = selectEffectiveCrewForJob(state, job).map((c) => c.user.id);
    return selectCrewConflicts(state, ids, job.startAt, job.endAt, job.id);
  }, [state, job]);

  // What "this & all future" would actually destroy. Built from the MATERIALIZED
  // rows DELETE_JOB_SERIES removes — the SAME predicate as the reducer — not from
  // the recurrence, so the numbers stay true when the master never loaded and any
  // occurrence edited off the pattern is described as it really is.
  const deleteSummary = useMemo(() => {
    if (!job?.seriesId) return null;
    const doomed = (state.jobs || []).filter((j) => (
      // Same clamp the dispatch uses (lib/seriesScope.js): a started occurrence is
      // not in scope, so the preview's count and date range must not include it.
      j.seriesId === job.seriesId && j.status === 'upcoming' && j.startAt >= seriesFromDate(job).fromDate
    ));
    if (!doomed.length) return null;
    const groups = [];
    for (const j of [...doomed].sort((a, b) => a.startAt.localeCompare(b.startAt))) {
      const dow = dayOfWeekIso(j.startAt);
      const s = splitIso(j.startAt);
      const e = splitIso(j.endAt);
      // Effective crew, so standing coverage reads correctly and ids whose user is
      // gone are dropped rather than surfacing as a phantom teammate.
      const crew = selectEffectiveCrewForJob(state, j).map((c) => c.user.name);
      const sig = `${s.time}|${e.time}|${[...crew].sort().join(',')}`;
      const hit = groups.find((g) => g.sig === sig);
      if (hit) { if (!hit.days.includes(dow)) hit.days.push(dow); }
      else groups.push({ sig, days: [dow], startTime: s.time, endTime: e.time, crew });
    }
    return {
      count: doomed.length,
      first: doomed.reduce((m, j) => (j.startAt < m ? j.startAt : m), doomed[0].startAt),
      last: doomed.reduce((m, j) => (j.startAt > m ? j.startAt : m), doomed[0].startAt),
      ongoing: seriesMaster?.recurrence?.endType === 'never',
      groups,
    };
  }, [state, job, seriesMaster]);

  const [editing, setEditing] = useState(false);
  const [editScope, setEditScope] = useState('single');
  const [editBlocks, setEditBlocks] = useState(null);
  // The blocks the editor OPENED with (mount-time snapshot, never the live series): the
  // save sends only what changed against these (dayPlanFromBlocks).
  const [openingBlocks, setOpeningBlocks] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Set to { names, count } when Cancel is clicked and a crew member is clocked in on
  // this clean, so the manager confirms before we clock them out (see handleCancelClick).
  const [cancelPrompt, setCancelPrompt] = useState(null);
  const [showSeriesChoice, setShowSeriesChoice] = useState(null);
  // Confirm-once for the save-time unassigned guard. Keyed on the crew/site/client
  // signature rather than a boolean, so ANY change to who's on the clean re-arms the
  // warning automatically — no scattered resets across the crew chips + block editor.
  // ALSO cleared at the start of every edit session (beginEdit / Cancel): the page
  // stays mounted between edits, so without that a second edit of the same still-
  // unassigned clean would match the old signature and save silently on click one.
  // Snapshot of the record as the edit STARTED. The series patch diffs against this,
  // never against `initial` — `initial` is a useMemo on the LIVE job, so a concurrent
  // change moves it underneath an open draft and every untouched field then reads as
  // an edit, which for a series patch means it gets spread onto every occurrence.
  const [editBaseline, setEditBaseline] = useState(null);

  const initial = useMemo(() => {
    if (!job) return null;
    const s = splitIso(job.startAt);
    const e = splitIso(job.endAt);
    return {
      date: s.date, startTime: s.time, endTime: e.time,
      clientId: job.clientId, siteId: job.siteId, serviceId: job.serviceId,
      crewIds: job.crewIds || [], notes: job.notes || '', tagIds: job.tagIds || [],
      // Who is covering whom on THIS visit (R8) — { [coverId]: coveredId }. Edited by the
      // "Covering for" control below the crew picker and saved with the crew change.
      coverFor: job.coverFor || null,
    };
  }, [job]);
  const [form, setForm] = useState(initial);

  if (!job) {
    return (
      <div style={{ padding: 32 }}>
        <DetailHeader backTo="/schedule" title="Job not found" />
      </div>
    );
  }
  // Crew may only open a clean they're named on (job.crewIds). Without this, any crew
  // member could open ANY job by URL — the route is gated only by schedule.view — and see that account's contact PII +
  // access instructions, and hit Start on it. Managers (schedule.edit) are unaffected.
  // NOTE: the store is one shared org_state blob with open RLS, so this UI gate stops
  // the honest/link path but is NOT a server boundary — see CREW_AUDIT.md (RLS).
  const isCrew = currentUser?.role === 'crew';
  const isMine = !isCrew || isJobAssignedToUser(state, job, currentUser?.id);
  if (!isMine) {
    return (
      <div style={{ padding: 32 }}>
        <DetailHeader backTo={backTo} backLabel={backLabel} title="Not your clean" />
        <p className="text-muted" style={{ padding: '4px 8px' }}>This clean isn’t assigned to you.</p>
      </div>
    );
  }
  const currentForm = form || initial;
  // View mode shows the EFFECTIVE crew (explicit picks + standing coverage) so a
  // standing-crew-covered job never reads "—"; the edit picker stays explicit.
  const effectiveCrew = selectEffectiveCrewForJob(state, job);
  // Geofence clock context (site coords + radius + names) for the crew visit timeline.
  const clockCtx = isCrew ? selectClockContextForJob(state, job, currentUser?.id) : null;
  // True when this series runs genuinely different crews/times across its days, so
  // the per-day breakdown renders (below) — the ONE place the whole roster is shown.
  // The occurrence carries only its own day's crew (correct: a Mon cleaner doesn't
  // work Thu), so on such a series the Details "Crew" field is relabelled
  // "Crew (this clean)" — otherwise the single name reads as if it were the whole
  // team. Same gate as the breakdown minus the edit-mode check the JSX adds.
  const showSeriesBlocks = !!(job.seriesId && seriesBlocks && seriesBlocks.length > 1 && !seriesRunsTwiceInADay);
  // Occurrences to list for series navigation. seriesJobs is every row sharing
  // job.seriesId — the ONLY thing tying the visits together (not the customer) —
  // already sorted by startAt. Show a window CENTERED on the current clean (a little
  // history + what's next) and cap it, so a long/ongoing series doesn't render
  // hundreds of rows; the honest "showing X of Y" note carries the rest.
  const SERIES_VISITS_CAP = 30;
  const seriesVisits = (() => {
    if (!job.seriesId || seriesJobs.length <= 1) return [];
    const idx = seriesJobs.findIndex((j) => j.id === job.id);
    const from = idx >= 0 ? Math.max(0, idx - 3) : 0;
    return seriesJobs.slice(from, from + SERIES_VISITS_CAP);
  })();

  // ── "Covering for" (R8, 2026-09-27): who on this visit is covering whom ──────────
  // A cover fills the COVERED cleaner's checklist on that clean (lib/crewChecklist), so the
  // single-visit edit has to be able to say who. ONE pure rule decides who is offered a
  // cover and among whom (`lib/jobCover.coverCandidates`): a cover is anyone on the visit
  // who is not one of the day's REGULARS, and the options are the regulars who are not on
  // it — so it fires both when the edit swaps a cleaner out and when a regular was already
  // taken off by a time-off booking (`APPLY_TIME_OFF_EXCLUSIONS` removes them from crewIds
  // but they are still the day's regular).
  //
  // 🔴 `coverRegulars === null` is the windowed-boot guard. For a SERIES visit the day's
  // regulars come from the master (`dayPatternOf`), and since E6 the app boots on a window
  // of jobs — for a series that began outside it the master is absent for the first
  // seconds of every session, and permanently on a tab that never finishes the backfill.
  // With the regulars unknowable, EVERY cleaner on the visit would look like a cover with
  // nobody to cover for, and the save would write `coverFor: null` over a perfectly good
  // cover. So the save omits the field entirely then, and the reducer (settleCoverPatch)
  // re-normalizes what is stored against the new crew instead — stale entries still go, a
  // live one survives.
  //
  // A ONE-OFF clean has no weekday pattern, but R8 is about a SHIFT, not about a series
  // (C4): its regulars are the crew it was SAVED with when this edit began, plus anyone a
  // time-off booking took off THIS clean — the booking records the job ids it covered
  // (`timeOff[].scheduledJobIds`), which is how the exclusion's victim is still known to
  // have been a regular of it after `APPLY_TIME_OFF_EXCLUSIONS` removed them from crewIds.
  const coverRegulars = (() => {
    if (job.seriesId) {
      return seriesMaster?.recurrence
        ? (dayPatternOf(seriesMaster, dayOfWeekIso(job.startAt)).crewIds || [])
        : null;
    }
    const base = ((editBaseline || initial)?.crewIds) || job.crewIds || [];
    const bookedOff = (state.timeOff || [])
      .filter((t) => Array.isArray(t.scheduledJobIds) && t.scheduledJobIds.includes(job.id))
      .map((t) => t.userId)
      .filter(Boolean);
    return [...new Set([...base, ...bookedOff])];
  })();
  const coverKnown = coverRegulars !== null;
  const crewName = (id) => users.find((u) => u.id === id)?.name || 'Unknown';
  // The DRAFT may hold '' for "explicitly not covering", which is why the control reads it
  // before the pre-fill: on a 1-for-1 swap the pre-fill is the other cleaner, and deriving
  // the displayed value from the pre-fill alone made clearing the choice impossible.
  const coverDraft = currentForm.coverFor || {};
  const cover = coverCandidates({
    regularCrewIds: coverRegulars || [],
    crewIds: currentForm.crewIds,
    coverFor: coverDraft,
    activeIds: users.filter((u) => u.status === 'active').map((u) => u.id),
  });
  const coverValueFor = (id) => ((id in coverDraft) ? (coverDraft[id] || '') : (cover.prefill[id] || ''));
  // Show the control whenever there is something to choose OR something already chosen —
  // the second half matters when the covered cleaner has since been DEACTIVATED (C3):
  // `left` is then empty, and without this the office could neither see nor clear a live
  // cover pointing at someone who has left the team.
  const showCoverControl = cover.covers.length > 0
    && (cover.left.length > 0 || cover.covers.some((id) => coverValueFor(id)));
  // View mode's read-only line: who is covering whom on this clean, from the SAVED record.
  const savedCovers = Object.entries(job.coverFor || {});
  // What the single-visit save writes: only covers still offered on THIS visit, empties
  // dropped, null when nobody is covering. The reducer normalizes again at the write point.
  const coverForToSave = (() => {
    const out = {};
    for (const id of cover.covers) { const v = coverValueFor(id); if (v) out[id] = v; }
    return Object.keys(out).length ? out : null;
  })();

  // Entering edit re-seeds the draft from the CURRENT record and snapshots that same
  // value as the diff baseline. `form` was previously seeded once at mount and reset
  // only on Cancel, so a job someone else changed while this page sat open reopened
  // with stale values — and saving wrote them back over the newer ones.
  const beginEdit = () => { setForm(initial); setEditBaseline(initial); setEditing(true); };

  const handleEditClick = () => {
    if (job.seriesId && seriesJobs.length > 1) {
      setShowSeriesChoice('edit');
    } else {
      setEditScope('single');
      setEditBlocks(null);
      setOpeningBlocks(null);
      beginEdit();
    }
  };

  const handleDeleteClick = () => {
    if (job.seriesId && seriesJobs.length > 1) setShowSeriesChoice('delete');
    else setConfirmDelete(true);
  };

  const save = () => {
    // Block-editor guards. Days are editable now, so a save can express shapes the
    // series cannot hold: no days at all (nothing would ever generate) or a block
    // the user added and never assigned days to (it would vanish without a word).
    if (editScope === 'future' && isWeeklySeries && editBlocks) {
      if (editBlocks.some((b) => !b.days.length)) {
        toast.error('Every schedule block needs at least one day. Remove the empty block or give it a day.');
        return;
      }
      if (!editBlocks.some((b) => b.days.length)) {
        toast.error('Pick at least one day for this series.');
        return;
      }
      if (editBlocks.some((b) => !b.startTime || !b.endTime)) {
        toast.error('Every schedule block needs a start and end time.');
        return;
      }
      if (editBlocks.some((b) => !isStrictHm(b.startTime) || !isStrictHm(b.endTime))) {
        toast.error('Enter block times as a valid time of day.');
        return;
      }
    }
    // Same strict-HH:MM law as NewJobModal.validate(): on a text-degraded
    // browser (no type=time) composeIso silently composes a WRONG instant from
    // a malformed time ("1800" reads as hour 1800 → ~75 days out) — and unlike
    // the create path, an edit here mirrors that instant fleet-wide.
    if (!isStrictHm(currentForm.startTime) || !isStrictHm(currentForm.endTime)) {
      toast.error('Enter a valid start and end time.');
      return;
    }
    // A clean must name a specific site (Phase 1: site is required to schedule).
    if (!currentForm.siteId) {
      toast.error('Pick a site for this clean before saving.');
      return;
    }
    // Save-time crew guard — mirrors NewJobModal. A clean no active crew is named on
    // shows on no one's schedule and can't be clocked in, so it's a HARD BLOCK.
    // Weekly-future edits: blocked when every block is empty.
    const blocksMode = editScope === 'future' && isWeeklySeries && editBlocks;
    const isUnassigned = blocksMode
      ? editBlocks.every((b) => selectIsJobUnassigned(state, {
        crewIds: b.crewIds || [], siteId: currentForm.siteId || null, clientId: currentForm.clientId,
      }))
      : selectIsJobUnassigned(state, {
        crewIds: currentForm.crewIds || [],
        siteId: currentForm.siteId || null, clientId: currentForm.clientId,
      });
    if (isUnassigned) {
      toast.error('Assign at least one cleaner. A clean can’t be saved with no one on it.');
      return;
    }
    const startAt = composeIso(currentForm.date, currentForm.startTime);
    // Rolls to the next day when end <= start (overnight cleans) — see composeEndIso.
    const endAt = composeEndIso(currentForm.date, currentForm.startTime, currentForm.endTime);
    const patch = {
      startAt, endAt,
      clientId: currentForm.clientId,
      siteId: currentForm.siteId || null,
      serviceId: currentForm.serviceId,
      crewIds: currentForm.crewIds,
      notes: currentForm.notes,
      tagIds: currentForm.tagIds,
      // Who is covering whom on this one visit (R8). Omitted — never written as null —
      // when the day's regulars are unknowable; see the coverKnown note above.
      ...(coverKnown ? { coverFor: coverForToSave } : {}),
    };
    if (editScope === 'future' && job.seriesId) {
      // Never reach an occurrence that has already STARTED (Sept 2: tonight's
      // in-progress clean was deleted/rewritten by a "this & future" edit). The
      // clamp is computed here so the recorded action stays replay-safe.
      const scope = seriesFromDate(job);
      // ⚠️ EVERY field is diffed here, not just crewIds. The uniform patch is spread
      // onto every future occurrence, so an untouched field riding along FLATTENS that
      // field across the series. `shared` used to send notes/serviceId/siteId/tagIds
      // unconditionally, so a crew-only edit overwrote every future occurrence's site,
      // service, notes and tags with the edited occurrence's values.
      //
      // clientId was missing from it entirely. The Company select IS editable in this
      // scope (unlike Date, which is hidden), so changing the account gave a success
      // toast and changed NO occurrence — not even this one, since the future branch
      // never dispatches UPDATE_JOB. Worse, the siteId reset that rides a company
      // change (`siteId: ''` in the Company onChange) WAS in the patch, so the site was
      // wiped series-wide by the very edit that failed to move the account.
      // NewJobModal has diffed all of these since the crew-flatten fix; this is the
      // entry point that was never brought in line.
      const base = editBaseline || initial;
      const sameIds = (a, b) => [...(a || [])].sort().join(',') === [...(b || [])].sort().join(',');
      const shared = {};
      if (currentForm.clientId !== base.clientId) shared.clientId = currentForm.clientId;
      if ((currentForm.siteId || null) !== (base.siteId || null)) shared.siteId = currentForm.siteId || null;
      if (currentForm.serviceId !== base.serviceId) shared.serviceId = currentForm.serviceId;
      if ((currentForm.notes || '') !== (base.notes || '')) shared.notes = currentForm.notes;
      if (!sameIds(currentForm.tagIds, base.tagIds)) shared.tagIds = currentForm.tagIds;
      if (isWeeklySeries && editBlocks) {
        // Per-day times + crew ride the dayPlan; the uniform patch must NOT carry
        // crewIds here or it would flatten the series' per-day crews.
        //
        // dayPlan's `days` is the COMPLETE intended day set: the reducer diffs it
        // against the current one and deletes / materializes occurrences
        // accordingly, so a day removed here disappears from the board and a day
        // added here appears on it — from this occurrence forward only. Its
        // `overrides` are SPARSE: only the times / crew the user changed per day
        // against the blocks this editor opened with. Sending every day's values
        // re-crewed and re-timed every future visit, wiping one-off covers and
        // one-off times even on a notes-only save (2026-09-23).
        const { days, overrides, full } = dayPlanFromBlocks(editBlocks, openingBlocks);
        dispatch({
          type: ACTIONS.UPDATE_JOB_SERIES, seriesId: job.seriesId, fromDate: scope.fromDate,
          patch: shared, dayPlan: { days, overrides, full },
          // "This & all future" includes this visit even if it was changed on its own.
          anchorId: job.id,
        });
      } else {
        const timeChanged = base && (currentForm.startTime !== base.startTime || currentForm.endTime !== base.endTime);
        // ⚠️ crewIds ONLY WHEN THE USER ACTUALLY CHANGED IT.
        //
        // The branch above already refuses to put crewIds in the uniform patch, for the
        // reason stated there: it would flatten the series' per-day crews. But this
        // fallback carried it unconditionally, and the condition that routes here —
        // `isWeeklySeries`, i.e. seriesMaster?.recurrence?.frequency === 'weekly' — is
        // FALSE WHENEVER THE MASTER IS NOT LOADED. Since E6 the app boots on a window of
        // jobs (store/sync.js), so for a series that began outside that window the master
        // is absent for the first seconds of every session, and permanently on a tab that
        // never finishes the backfill. The guard therefore disengaged exactly when it was
        // needed, and a user editing only the notes flattened every day's crew.
        //
        // Diffing against `initial` closes it at the WRITE point, so it holds regardless
        // of which entry offered the scope or whether the master ever loaded.
        const crewChanged = !base || !sameIds(currentForm.crewIds, base.crewIds);
        dispatch({
          type: ACTIONS.UPDATE_JOB_SERIES, seriesId: job.seriesId, fromDate: scope.fromDate,
          patch: { ...shared, ...(crewChanged ? { crewIds: currentForm.crewIds } : {}) },
          ...(timeChanged ? { timePatch: { startTime: currentForm.startTime, endTime: currentForm.endTime } } : {}),
          anchorId: job.id,
        });
      }
      toast.success(scope.started ? `Updated future occurrences. ${STARTED_SERIES_NOTE}` : 'Updated all future jobs in series');
    } else {
      dispatch({ type: ACTIONS.UPDATE_JOB, id: job.id, patch });
      toast.success('Job updated');
    }
    setEditing(false);
  };

  const transition = (status) => {
    dispatch({ type: ACTIONS.SET_JOB_STATUS, id: job.id, status });
    // Confirm the change — and, offline, reassure it's saved and will sync (the crew's
    // "Start" is the field-critical one; it gave no feedback at all before).
    const label = { in_progress: 'Job started', done: 'Marked done', cancelled: 'Job cancelled', upcoming: 'Job reset to Upcoming' }[status] || 'Job updated';
    toast.success(savedMsg(online, label));
  };

  // Cancel is special: a clean can carry LIVE labor. Cancel used to only flip the status,
  // so a crew member's OPEN punch kept running and the auto-close cron paid it to the
  // scheduled end, invisibly. Now cancelling first stops the clock on any open punch
  // (pays the real minutes, capped at the scheduled end) and flags every punch on the
  // clean as cancelled-clean labor, and warns first when someone is on the clock right
  // now. Time entries are server-only, so the labor step goes through timeApi (the demo
  // stub and the live server share lib/timeCancel), NOT the reducer. If the labor can't
  // be settled we do NOT cancel: better to fail loudly than reopen the silent-pay hole.
  const cancelJob = async (hasLabor) => {
    setCancelPrompt(null);
    if (hasLabor) {
      try {
        await timeApi.cancelJobLabor({ jobId: job.id });
      } catch (e) {
        toast.error(e?.message || 'Could not clock out the crew on this clean. Nothing was cancelled, try again.');
        return;
      }
    }
    transition('cancelled');
  };

  const handleCancelClick = async () => {
    let info = null;
    try {
      const list = (await timeApi.entries({ jobIds: [job.id] })).entries || [];
      info = laborOnJob(list, job.id);
    } catch {
      // Couldn't read the ledger, so assume there MAY be labor and let cancelJob settle
      // it server-side rather than skip it (skipping is exactly the old silent-pay bug).
    }
    if (info && info.open.length > 0) {
      setCancelPrompt({ names: info.openNames, count: info.open.length });
      return;
    }
    cancelJob(info ? info.total > 0 : true);
  };

  const del = (scope) => {
    if (scope === 'future' && job.seriesId) {
      // A started occurrence is kept (it has people on site and punches on it);
      // the delete applies from the next one. See lib/seriesScope.js.
      const range = seriesFromDate(job);
      dispatch({ type: ACTIONS.DELETE_JOB_SERIES, seriesId: job.seriesId, fromDate: range.fromDate });
      if (range.started) toast.success(`Deleted future occurrences. ${STARTED_SERIES_NOTE}`);
    } else {
      dispatch({ type: ACTIONS.DELETE_JOB, id: job.id });
    }
    navigate('/schedule');
  };

  return (
    <div className="page-pad">
      <DetailHeader
        backTo={backTo}
        backLabel={backLabel}
        title={`${service?.name || 'Job'}${client ? `. ${client.name}` : ''}`}
        subtitle={`${fmtDateLong(job.startAt)} · ${fmtTimeRange(job.startAt, job.endAt)}`}
        badge={<Badge variant={statusBadgeVariant(STATUS_LABEL[job.status])}>{STATUS_LABEL[job.status]}</Badge>}
        actions={
          <div className="flex-row" style={{ gap: 8 }}>
            {/* "Start" is a manager status override only. Crew START by clocking in
                (the geofence ClockControl in the Visit checklist below) — a plain
                Start that flips status without recording labor is the trap we removed. */}
            {canEdit && mayMoveTo('in_progress') && job.status !== 'in_progress' && job.status !== 'done' && (
              <button className="btn btn-success" onClick={() => transition('in_progress')}>Start</button>
            )}
            {/* Done / Cancel are manager status decisions (schedule.edit); crew can't change job status, only Start + clock in/out. */}
            {canEdit && mayMoveTo('done') && job.status !== 'done' && (
              <button className="btn btn-primary" onClick={() => transition('done')}>Mark Done</button>
            )}
            {canEdit && mayMoveTo('cancelled') && job.status !== 'cancelled' && (
              <button className="btn btn-danger" onClick={handleCancelClick}>Cancel Job</button>
            )}
            {/* Reset returns a mistakenly-terminated FUTURE clean to Upcoming (undo a
                premature Done/Missed/Cancel). Gated on schedule.reset (its own Roles
                permission) and only for a job whose start is still ahead — a past clean
                is history and a past-dated "Upcoming" is nonsense; a future clean was
                never clocked in, so this is a pure status change (no labor to touch). */}
            {canReset && mayMoveTo('upcoming') && ['done', 'missed', 'cancelled'].includes(job.status)
              && new Date(job.startAt).getTime() > Date.now() && (
              <button className="btn btn-outline" onClick={() => transition('upcoming')}>Reset to Upcoming</button>
            )}
            {/* Crew get photos as a step inside the Visit checklist (CrewJobVisit); this
                header toggle is the manager's quick peek. */}
            {!isCrew && (job.siteId ? (
              <button className="btn btn-outline" onClick={() => setShowPhotos((v) => !v)} aria-expanded={showPhotos}>
                {showPhotos ? 'Hide photos' : 'Photos'}
              </button>
            ) : (
              // Media is keyed by site — a siteless clean can't attach photos yet.
              // A disabled control with the reason beats the button silently missing (#17).
              <button className="btn btn-outline" disabled title="Set a site on this clean to attach photos">
                Photos
              </button>
            ))}
            {canEditJob && !editing && <button className="btn btn-primary" onClick={handleEditClick}>Edit</button>}
            {canEditJob && <button className="btn btn-danger" onClick={handleDeleteClick}>Delete</button>}
          </div>
        }
      />

      {isCrew && (
        <CrewJobVisit job={job} ctx={clockCtx} site={site} client={client} userId={currentUser?.id} />
      )}

      {showPhotos && job.siteId && (
        // Before / After are separate areas (media `areaId` phase tag), matching what the
        // crew captures in CrewJobVisit — so admin sees the same split.
        <div className="card detail-card clean-photos-split" style={{ marginBottom: 16 }}>
          <MediaGallery
            siteId={job.siteId}
            clientId={job.clientId || site?.clientId || null}
            scope="clean"
            refId={job.id}
            areaId="before"
            label="Before photos"
            hint="The space before the clean. Images up to 10MB, video up to 200MB."
          />
          <MediaGallery
            siteId={job.siteId}
            clientId={job.clientId || site?.clientId || null}
            scope="clean"
            refId={job.id}
            areaId="after"
            label="After photos"
            hint="The finished result. Images up to 10MB, video up to 200MB."
          />
        </div>
      )}

      {job.seriesId && recurrenceDesc && (
        <div className="series-info-bar">
          <Icon name="repeat" size={14} />
          <span>{recurrenceDesc}. {seriesJobs.length} job{seriesJobs.length !== 1 ? 's' : ''} in series</span>
        </div>
      )}

      {/* Per-block breakdown. A multi-block series runs different days at different
          times with different crew, and the header only ever shows THIS occurrence's
. So without this the page reads as one uniform schedule (the shipped bug:
          a Mon/Fri 1 AM + Wed 10 AM series showed only "Mon, Wed, Fri" and 10 AM). */}
      {/* Withheld for a twice-in-a-day series: the blocks are reconstructed from
          `dayOverrides`, one entry per weekday, so it would render a tidy per-day list
          that silently omits the second clean. The same shape of half-truth this
          breakdown exists to correct. The bar's frequency line and the header's own
          time remain, and the delete prompt (built from real rows) still tells the
          whole story. */}
      {showSeriesBlocks && !editing && (
        <div className="series-blocks-summary">
          <div className="series-blocks-summary-head">Crew across the whole series</div>
          {seriesBlocks.map((b) => {
            const mine = b.days.includes(thisDow);
            return (
              <div key={b.key} className={`series-block-line${mine ? ' is-current' : ''}`}>
                <span className="series-block-days">{blockDayLabel(b.days)}</span>
                <span className="series-block-sep">·</span>
                <span>{blockTimeLabel(b)}</span>
                <span className="series-block-sep">·</span>
                <span className="text-muted">{blockCrewLabel(b.crewIds)}</span>
                {mine && <span className="series-block-current">this clean</span>}
              </div>
            );
          })}
        </div>
      )}

      {conflicts.length > 0 && !editing && (
        <div className="conflict-warning" style={{ marginBottom: 12 }}>
          <Icon name="warning" size={14} />
          <div>
            <strong>Scheduling conflict</strong>
            {conflicts.map((c, i) => {
              if (c.timeOff) {
                return (
                  <div key={i} className="text-xs">
                    {c.userName} has time off this day{c.timeOff.reason ? ` (${c.timeOff.reason})` : ''} but is still on this clean
                  </div>
                );
              }
              const cl = selectClientById(state, c.job.clientId);
              return (
                <div key={i} className="text-xs">
                  {c.userName} overlaps with {cl?.name || 'another job'} {fmtTimeRange(c.job.startAt, c.job.endAt)}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="detail-grid">
        <div className="card detail-card">
          <h3 className="dash-card-title">Details</h3>
          {!editing ? (
            <dl className="detail-dl">
              <div><dt>Company</dt><dd>{client ? <Link className="linklike" to={`/clients/${client.id}`} state={nav}>{client.name}</Link> : '—'}</dd></div>
              <div><dt>Location</dt><dd>
                {site?.address || '—'}
                {site?.address ? (
                  <div className="detail-actions">
                    <a className="btn btn-outline" href={mapsDir(site.address)} target="_blank" rel="noopener noreferrer">
                      <Icon name="mapPin" size={14} />Directions
                    </a>
                  </div>
                ) : null}
              </dd></div>
              <div>
                <dt>Contact</dt>
                <dd>
                  {siteContact ? (
                    <>
                      <span>{siteContact.firstName} {siteContact.lastName}</span>
                      {siteContact.phone ? <div className="text-sm"><PhoneLink phone={siteContact.phone} /></div> : null}
                      {siteContact.email ? <div className="text-muted text-sm">{siteContact.email}</div> : null}
                      {siteContact.phone ? (
                        <div className="detail-actions">
                          <a className="btn btn-outline" href={telHref(siteContact.phone)}>
                            <Icon name="phone" size={14} />Call
                          </a>
                          <a className="btn btn-outline" href={smsHref(siteContact.phone)}>
                            <Icon name="messaging" size={14} />Text
                          </a>
                        </div>
                      ) : null}
                    </>
                  ) : site ? (
                    <span className="text-muted"><span className="text-xs">(set on the site record)</span></span>
                  ) : '—'}
                </dd>
              </div>
              <div><dt>{showSeriesBlocks ? 'Crew (this clean)' : 'Crew'}</dt><dd>
                {effectiveCrew.length === 0 ? '—' : (
                  <div className="flex-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    {effectiveCrew.map(({ user: u, standing }) => (
                      <span key={u.id} className="flex-row" style={{ gap: 6, alignItems: 'center' }}>
                        <Avatar initials={u.initials} variant={u.avatar} size="sm" />
                        <span className="text-sm">{u.name}{standing && <span className="text-muted text-xs"> (standing)</span>}</span>
                      </span>
                    ))}
                  </div>
                )}
              </dd></div>
              {/* Who is covering whom on this clean (R8). READ-ONLY, in view mode: it
                  decides which checklist each cleaner owes — and from step 4 whether they
                  can clock out — so the office must be able to see it without opening the
                  edit. */}
              {savedCovers.length > 0 && (
                <div><dt>Covering for</dt><dd>
                  {savedCovers.map(([coverId, coveredId]) => (
                    <div key={coverId} className="text-sm">
                      {crewName(coverId)} <span className="text-muted">is covering for</span> {crewName(coveredId)}
                    </div>
                  ))}
                  <span className="text-muted text-xs">They fill the covered cleaner’s checklist on this clean.</span>
                </dd></div>
              )}
              <div><dt>Notes</dt><dd>{job.notes || <span className="text-muted">No notes</span>}</dd></div>
            </dl>
          ) : (
            <div>
              {editScope === 'future' && (
                <div className="series-info-bar" style={{ marginBottom: 12 }}>
                  <Icon name="repeat" size={14} />
                  <span>{isWeeklySeries && editBlocks
                    ? 'Editing all future jobs in this series. Each block below owns its own days, times and crew. Adding a day schedules it from this job forward; removing one deletes its upcoming jobs. Past jobs are untouched.'
                    : 'Editing all future jobs in this series. Start/end times, crew, and details apply to every future job.'}</span>
                </div>
              )}
              {/* One occurrence of a multi-block series: say WHICH block is being
                  changed, so a single-time form on a series that runs three
                  different times can't read as "this is the whole schedule". */}
              {editScope === 'single' && seriesBlocks && seriesBlocks.length > 1 && (() => {
                const mine = seriesBlocks.find((b) => b.days.includes(thisDow));
                return (
                  <div className="series-info-bar" style={{ marginBottom: 12 }}>
                    <Icon name="repeat" size={14} />
                    <span>
                      Editing this one job only{mine ? `. The ${blockDayLabel(mine.days)} ${blockTimeLabel(mine)} block` : ''}.
                      {' '}The series’ other schedule blocks are unchanged.
                    </span>
                  </div>
                );
              })()}
              <FormField
                label="Company" as="select" name="clientId" required
                value={currentForm.clientId}
                onChange={(e) => { const cid = e.target.value; const loc = state.sites.find((s) => s.clientId === cid); setForm({ ...currentForm, clientId: cid, siteId: loc?.id || '' }); }}
                options={state.clients.map((c) => ({ value: c.id, label: c.name }))}
              />
              <FormField
                label="Service" as="select" name="serviceId" required
                value={currentForm.serviceId}
                onChange={(e) => setForm({ ...currentForm, serviceId: e.target.value })}
                options={state.services.map((s) => ({ value: s.id, label: s.name }))}
              />
              {editScope === 'future' && isWeeklySeries && editBlocks ? (
                <ScheduleBlocksEditor
                  blocks={editBlocks}
                  onChange={setEditBlocks}
                  crewPool={users.filter((u) => u.status === 'active')}
                />
              ) : (
                <div className="form-row">
                  {editScope !== 'future' && (
                    <FormField label="Date" type="date" name="date" required value={currentForm.date} onChange={(e) => setForm({ ...currentForm, date: e.target.value })} />
                  )}
                  {/* onBlur: auto-correct typed military/12-hour time on text-degraded
                      browsers (no type=time). Same guard as NewJobModal. */}
                  <FormField label="Start" type="time" step={900} name="startTime" required value={currentForm.startTime}
                    onChange={(e) => setForm({ ...currentForm, startTime: e.target.value })}
                    onBlur={() => { const n = normalizeHm(currentForm.startTime); if (n && n !== currentForm.startTime) setForm({ ...currentForm, startTime: n }); }} />
                  <FormField label="End" type="time" step={900} name="endTime" required value={currentForm.endTime}
                    onChange={(e) => setForm({ ...currentForm, endTime: e.target.value })}
                    onBlur={() => { const n = normalizeHm(currentForm.endTime); if (n && n !== currentForm.endTime) setForm({ ...currentForm, endTime: n }); }} />
                </div>
              )}
              {!(editScope === 'future' && isWeeklySeries && editBlocks) && (() => {
                // Crew is exactly whoever is named on the clean. Toggling a chip adds
                // or removes them from crewIds.
                const named = new Set(currentForm.crewIds || []);
                const toggleCrew = (id) => {
                  const next = new Set(named);
                  if (next.has(id)) next.delete(id); else next.add(id);
                  setForm({ ...currentForm, crewIds: [...next] });
                };
                return (
                <FormField label="Crew" help="Whoever is highlighted works this clean and can clock in. Click to add or remove someone.">
                  <div className="chip-picker">
                    {users.filter((u) => u.status === 'active').map((u) => {
                      const on = named.has(u.id);
                      return (
                        <button key={u.id} type="button" className={`chip ${on ? 'on' : ''}`} onClick={() => toggleCrew(u.id)}>
                          <Avatar initials={u.initials} variant={u.avatar} size="sm" />
                          <span>{u.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </FormField>
                );
              })()}
              {/* 🔴 "Covering for" (R8, 2026-09-27) — ONLY on the single-visit scope, the
                  only save that writes `job.coverFor`. A cleaner covering someone's shift
                  fills the COVERED cleaner's checklist on that clean, so the office has to
                  be able to say who. The rule that decides who is offered a cover, among
                  whom, is pure and shared with its tests (lib/jobCover.coverCandidates);
                  see the derivation above `save`. */}
              {editScope !== 'future' && coverKnown && showCoverControl && (
                <FormField
                  label="Covering for"
                  help="A cleaner covering someone's shift fills the covered cleaner's checklist on this clean — just this one."
                >
                  <div className="cover-for-rows">
                    {cover.covers.map((coverId) => (
                      <div key={coverId} className="cover-for-row">
                        <span className="cover-for-who">{crewName(coverId)}</span>
                        <Select
                          ariaLabel={`Who ${crewName(coverId)} is covering for`}
                          value={coverValueFor(coverId)}
                          onChange={(v) => setForm({
                            ...currentForm, coverFor: { ...coverDraft, [coverId]: v },
                          })}
                          options={[
                            { value: '', label: 'Not covering for anyone' },
                            // Per row, so a regular another row already holds is not
                            // offered twice (C6) and a saved pick whose cleaner has left
                            // the team still shows and can be cleared (C3).
                            ...(cover.options[coverId] || []).map((id) => ({
                              value: id,
                              label: users.find((u) => u.id === id && u.status === 'active')
                                ? (isUserOffOn(state.timeOff, id, job.startAt)
                                  ? `${crewName(id)} (off that day)` : crewName(id))
                                : `${crewName(id)} (no longer on the team)`,
                            })),
                          ]}
                        />
                      </div>
                    ))}
                  </div>
                </FormField>
              )}
              <FormField label="Tags" help="Tag this clean. Tags power the schedule's tag filter.">

                <div className="chip-picker">
                  {tagOptions.length === 0 ? (
                    <span className="text-muted text-xs">No tags defined. Create tags in Settings → Tags.</span>
                  ) : tagOptions.map((t) => {
                    const on = (currentForm.tagIds || []).includes(t.id);
                    return (
                      <button key={t.id} type="button" className={`chip ${on ? 'on' : ''}`}
                        onClick={() => setForm({
                          ...currentForm,
                          tagIds: on ? currentForm.tagIds.filter((x) => x !== t.id) : [...(currentForm.tagIds || []), t.id],
                        })}
                      >
                        {t.label}
                      </button>
                    );
                  })}
                </div>
              </FormField>
              <FormField label="Notes" as="textarea" name="notes" value={currentForm.notes} onChange={(e) => setForm({ ...currentForm, notes: e.target.value })} />
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => { setEditing(false); setForm(initial); setEditBlocks(null); setOpeningBlocks(null); }}>Cancel</button>
                <button type="button" className="btn btn-primary" onClick={save}>Save Changes</button>
              </div>
            </div>
          )}
        </div>

        <div className="card detail-card">
          <h3 className="dash-card-title">Service instructions</h3>
          <dl className="detail-dl">
            <div><dt>Expected time</dt><dd>{expectedMins != null ? fmtMins(expectedMins) : <span className="text-muted">Not set</span>}</dd></div>
            {accessInstructions ? (
              <div><dt>Access</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{accessInstructions}</dd></div>
            ) : null}
            {/* Encrypted door/alarm codes — masked, revealed on demand for authorized
                staff at THIS site (manager, standing crew, or on a job here). */}
            {canRevealHere && (siteSec.doorCodeCipher || siteSec.alarmCodeCipher) ? (
              <div>
                <dt>Codes</dt>
                <dd style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', alignItems: 'center' }}>
                  {siteSec.doorCodeCipher && (
                    <span>
                      Door: <span className="security-code">{revealedCodes.door || '••••'}</span>
                      {siteSec.codeHint && !revealedCodes.door && <span className="text-muted text-xs"> (hint: {siteSec.codeHint})</span>}
                      <button type="button" className="btn btn-link" onClick={() => revealSiteCode('door')}>{revealedCodes.door ? 'Hide' : 'Reveal'}</button>
                    </span>
                  )}
                  {siteSec.alarmCodeCipher && (
                    <span>
                      Alarm: <span className="security-code">{revealedCodes.alarm || '••••'}</span>
                      <button type="button" className="btn btn-link" onClick={() => revealSiteCode('alarm')}>{revealedCodes.alarm ? 'Hide' : 'Reveal'}</button>
                    </span>
                  )}
                </dd>
              </div>
            ) : null}
          </dl>
          <AccountNotesPanel client={client} />
          {/* Account checklist bound to this clean — completion (job_id) shows here;
              self-hides when no checklist is set and none was completed. */}
          <CleanChecklist job={job} client={client} />
          <div className="ji-areas-head">Cleaning areas</div>
          {cleaningAreas.length > 0
            ? <CleaningAreasEditor value={cleaningAreas} readOnly />
            : <p className="text-muted text-xs">No cleaning instructions set for this site yet.</p>}
          {/* Manager-uploaded reference media (scope cleaning_instruction, site-wide)
. Read-only for the crew working the clean; renders nothing when the
              site has none (CREW_AUDIT #18). Distinct from the per-clean
              before/after gallery above (scope 'clean', refId job.id). */}
          {job.siteId && (
            <MediaGallery
              siteId={job.siteId}
              clientId={job.clientId || site?.clientId || null}
              scope="cleaning_instruction"
              label="Reference photos & video"
              hint={null}
              readOnly
              hideWhenEmpty
            />
          )}
        </div>
      </div>

      {/* Jump to the other cleans in this recurring series. Every row links to its
          own /schedule/:jobId (each occurrence is a SEPARATE job record with its own
          id; they share job.seriesId, which is what ties them together). The current
          clean is marked and not a link. Carries the referrer so the back arrow
          returns here. Withheld while editing so it doesn't distract from the form. */}
      {job.seriesId && seriesVisits.length > 1 && !editing && (
        <div className="card detail-card series-visits">
          <div className="section-head">
            <h3 className="dash-card-title">Visits in this series</h3>
            <span className="text-muted text-sm">{seriesJobs.length} total</span>
          </div>
          <div className="series-visits-list">
            {seriesVisits.map((j) => {
              const crew = selectEffectiveCrewForJob(state, j).map((c) => c.user.name.split(' ')[0]).join(', ');
              const isCurrent = j.id === job.id;
              const body = (
                <>
                  <span className="series-visit-date">{fmtDate(j.startAt)}</span>
                  <span className="series-visit-time">{fmtTimeRange(j.startAt, j.endAt)}</span>
                  <span className="series-visit-crew text-muted">{crew || 'Unassigned'}</span>
                  <Badge variant={statusBadgeVariant(STATUS_LABEL[j.status])}>{STATUS_LABEL[j.status]}</Badge>
                </>
              );
              return isCurrent ? (
                <div key={j.id} className="series-visit-row is-current" aria-current="true">
                  {body}<span className="series-visit-current">Viewing</span>
                </div>
              ) : (
                <Link key={j.id} to={`/schedule/${j.id}`} state={nav} className="series-visit-row">{body}</Link>
              );
            })}
          </div>
          {seriesJobs.length > seriesVisits.length && (
            <div className="text-xs text-muted" style={{ marginTop: 8 }}>
              Showing {seriesVisits.length} of {seriesJobs.length} visits — open one to page further through the series.
            </div>
          )}
        </div>
      )}

      {/* Who clocked in to THIS clean, right on the clean — full width BELOW the
          2fr/1fr grid (inside it, the punch table landed in the narrow column and
          pushed Service instructions down a row). Manager-only: the component
          self-gates on time.view; crew see nothing extra here. */}
      <TimeClockHistory jobIds={[job.id]} title="Time clock" hide={['location']} allTime />

      {/* Recurring series: ONE choice prompt (shared SeriesScopeModal). Cancel / X
          aborts entirely. No chained second dialog, so dismissing never re-prompts. */}
      {/* 🔴 NO WHOLE-SERIES OPERATION AGAINST A PARTIAL JOB SET — EDIT *OR* DELETE.
          Both UPDATE_JOB_SERIES and DELETE_JOB_SERIES build their target set with
          `state.jobs.filter(...)` and locate the recurrence master with
          `state.jobs.find(...)`. Since E6 that array is a ~-45/+100 day WINDOW, so both
          reads are partial until the detached backfill lands:
            · occurrences beyond +100 days are never edited or deleted, and the backfill
              then merges them straight back;
            · a series older than 45 days has its master outside the window, so
              UPDATE skips the recurrence re-sync and DELETE skips the endDate CAP. 
              and without that cap TOP_UP re-materialises the entire deleted tail, which
              is exactly what the comment on DELETE_JOB_SERIES warns about.

          I previously gated only the EDIT scope here, on the reasoning that "deletes
          need no recurrence re-sync". That was wrong: the delete path performs a MASTER
          WRITE of its own (the cap), and it fails the same way. Hence one gate for both.

          The precondition is FULL HYDRATION, not merely a visible master: even with the
          master loaded, occurrences past +100 days are outside the set. Schedule already
          gates TOP_UP on exactly this flag, for exactly this reason. */}
      <SeriesScopeModal
        open={!!showSeriesChoice}
        intent={showSeriesChoice === 'delete' ? 'delete' : 'edit'}
        // Delete is NOT gated on seriesRunsTwiceInADay: it removes materialized rows and
        // never touches the recurrence model, so a twice-in-a-day series deletes cleanly.
        // Only the EDIT path has to be closed for it.
        disableFuture={!!job?.seriesId && (
          !jobsHydrated || !seriesMaster || (showSeriesChoice === 'edit' && seriesRunsTwiceInADay)
        )}
        // The copy must say WHY, or the disabled state reads as "series edits are
        // broken" (the shipped circular-copy bug — see SeriesScopeModal). 'loading'
        // is transient: jobsHydrated flipping re-renders this modal in place and
        // the "all future" button appears while it's open.
        disableReason={!jobsHydrated ? 'loading'
          : (!seriesMaster ? 'no-master'
            : (showSeriesChoice === 'edit' && seriesRunsTwiceInADay ? 'twice-in-a-day' : null))}
        summary={showSeriesChoice === 'delete' && deleteSummary ? (
          <div className="series-delete-summary">
            <div className="series-delete-head">“This &amp; all future” deletes:</div>
            <div className="series-delete-where">
              {client?.name || 'This account'}
            </div>
            {/* Crew sits on its own line rather than inline: the scope modal is `sm`,
                and a 3-name effective crew wrapped mid-row there. Orphaning the
                separator at the end of the time. Stacking is deliberate, not a fallback. */}
            {deleteSummary.groups.map((g, i) => (
              <div key={i} className="series-delete-block">
                <div className="series-block-line">
                  <span className="series-block-days">{blockDayLabel(g.days)}</span>
                  <span className="series-block-sep">·</span>
                  <span>{blockTimeLabel(g)}</span>
                </div>
                <div className="series-delete-crew">{g.crew.length ? g.crew.join(', ') : 'No named crew'}</div>
              </div>
            ))}
            <div className="series-delete-count">
              {deleteSummary.count} job{deleteSummary.count !== 1 ? 's' : ''} · {fmtDate(deleteSummary.first)} → {deleteSummary.ongoing ? 'ongoing' : fmtDate(deleteSummary.last)}
            </div>
          </div>
        ) : null}
        onClose={() => setShowSeriesChoice(null)}
        onPick={(scope) => {
          const intent = showSeriesChoice;
          setShowSeriesChoice(null);
          if (intent === 'delete') { del(scope); return; }
          setEditScope(scope);
          // Deep-copy the reconstructed blocks so edits never mutate the memo's arrays,
          // and keep a second, untouched copy as the save's baseline.
          const copyBlocks = () => seriesBlocks.map((b) => ({ ...b, days: [...b.days], crewIds: [...(b.crewIds || [])] }));
          const blocksMode = scope === 'future' && seriesBlocks;
          setEditBlocks(blocksMode ? copyBlocks() : null);
          setOpeningBlocks(blocksMode ? copyBlocks() : null);
          beginEdit();
        }}
      />

      {/* Cancel with a crew member on the clock: confirm, then clock them out + pay
          actual before cancelling (handleCancelClick / cancelJob). */}
      <ConfirmDialog
        open={!!cancelPrompt}
        title="Someone is clocked in"
        message={cancelPrompt
          ? `${cancelPrompt.names.length ? cancelPrompt.names.join(', ') : (cancelPrompt.count === 1 ? 'A crew member' : `${cancelPrompt.count} crew members`)} ${cancelPrompt.count === 1 ? 'is' : 'are'} on the clock on this clean right now. Cancelling clocks them out at the current time and pays the minutes worked, flagged as cancelled-clean labor for your review. Continue?`
          : ''}
        confirmLabel="Cancel clean & clock out"
        variant="danger"
        onConfirm={() => cancelJob(true)}
        onClose={() => setCancelPrompt(null)}
      />

      {/* Single (non-recurring) job delete confirm. */}
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this job?"
        message="This can't be undone. Related data (client, invoices) is untouched."
        confirmLabel="Delete Job"
        variant="danger"
        onConfirm={() => del('single')}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}
