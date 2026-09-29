import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import Modal from './Modal';
import FormField from './FormField';
import Icon from './Icon';
import ClientPicker from './ClientPicker';
import CrewPicker from './CrewPicker';
import AutoGrowTextarea from './AutoGrowTextarea';
import ScheduleBlocksEditor from './ScheduleBlocksEditor';
import { useDispatch, useStore, useJobsHydrated } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectSitesForClient, selectActiveUsers, selectCrewConflicts, selectClientById, selectIsJobUnassigned } from '../store/selectors';
import { useToast } from './Toast';
import { composeIso, composeEndIso, splitIso, todayKey, addDaysKey, dayOfWeekKey, diffDaysKey, fmtTimeRange, fmtDate, normalizeHm, isStrictHm } from '../lib/dates';
import { draftEffectiveCrewIds } from '../store/timeOffRules';
import { seriesFromDate, STARTED_SERIES_NOTE, STARTED_SERIES_MOVE_BLOCK } from '../lib/seriesScope';
import { newId } from '../lib/ids';

// A "same shape" series: same site (or same account when siteless), same
// frequency + weekday set, same start time — the signature the office reads as
// "the schedule I already set up." Used to require an explicit second submit
// before creating a look-alike (the 2026-07-30 ×5/×8 duplicate stacks).
function findSameShapeSeries(jobs, siteId, clientId, startAt, recurrence) {
  if (!recurrence) return null;
  const time = splitIso(startAt).time;
  const days = [...(recurrence.daysOfWeek || [])].sort().join(',');
  return (jobs || []).find((m) => {
    if (!m.recurrence || m.status === 'cancelled') return false;
    if (siteId ? m.siteId !== siteId : m.clientId !== clientId) return false;
    if (m.recurrence.frequency !== recurrence.frequency) return false;
    const mDays = [...(m.recurrence.daysOfWeek || [])].sort().join(',');
    return mDays === days && splitIso(m.startAt).time === time;
  }) || null;
}
import { RECURRENCE_DEFAULTS, expandRecurrence, HORIZON_DAYS } from '../lib/recurrence';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Required-field labels for the missing-fields summary.
const FIELD_LABELS = { clientId: 'Company', siteId: 'Location', date: 'Date', startTime: 'Start time', endTime: 'End time', days: 'Repeat days', blocks: 'Schedule blocks', endDate: 'End date' };

function buildEmpty(state, preset = {}) {
  const clientId = preset.clientId || '';
  return {
    clientId,
    siteId: preset.siteId || '',
    // Service is no longer picked in the modal. A job inherits the account's
    // default service so schedule cards, the dashboard and the invoice line
    // pre-fill keep resolving a name. Empty (a company with no default) means
    // null, which every consumer already tolerates. Re-resolved on company change.
    serviceId: preset.serviceId || (clientId ? selectClientById(state, clientId)?.serviceId || '' : ''),
    date: preset.date || todayKey(),
    startTime: preset.startTime || '09:00',
    endTime: preset.endTime || '10:30',
    crewIds: preset.crewIds || [],
    notes: preset.notes || '',
    repeat: 'none',
    blocks: null,
    endType: 'count',
    endCount: 12,
    endDate: '',
  };
}

export default function NewJobModal({ open, onClose, mode = 'create', initialData = null, presetClientId = null, presetSiteId = null, seriesScope = null }) {
  const state = useStore();
  const dispatch = useDispatch();
  const jobsHydrated = useJobsHydrated();
  const toast = useToast();
  const nav = useFromHere();
  const crewPool = selectActiveUsers(state);

  const [form, setForm] = useState(() => buildEmpty(state, { clientId: presetClientId, siteId: presetSiteId }));
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState('');
  // One-shot override for the same-shape duplicate warning; re-arms on any
  // form edit so a changed shape gets a fresh check.
  const [dupOverride, setDupOverride] = useState(false);
  // Same confirm-once shape as dupOverride: saving a clean nobody will do warns
  // first, and only goes through on a second click (Sept 1 — cleans silently
  // saved unassigned, nobody scheduled). Re-armed whenever the form changes.

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setSubmitError('');
    if (mode === 'edit' && initialData) {
      const s = splitIso(initialData.startAt);
      const e = splitIso(initialData.endAt);
      setForm({
        clientId: initialData.clientId,
        siteId: initialData.siteId || '',
        serviceId: initialData.serviceId,
        date: s.date,
        startTime: s.time,
        endTime: e.time,
        crewIds: initialData.crewIds || [],
        notes: initialData.notes || '',
        repeat: 'none',
        blocks: null,
        endType: 'count',
        endCount: 12,
        endDate: '',
      });
    } else {
      setForm(buildEmpty(state, { clientId: presetClientId, siteId: presetSiteId }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialData, mode]);

  // Every customer has exactly one location; pin siteId to it (no picker). This
  // covers a preset clientId that arrives without a preset siteId; a user changing
  // the company sets it in the ClientPicker onChange below.
  const locationId = form.clientId ? (selectSitesForClient(state, form.clientId)[0]?.id || '') : '';
  useEffect(() => {
    if (locationId && form.siteId !== locationId) setForm((f) => ({ ...f, siteId: locationId }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.clientId, locationId]);

  // Patch the form and clear any error(s) tied to the changed field(s).
  const update = (patch, clearKeys = []) => {
    setForm((f) => ({ ...f, ...patch }));
    if (clearKeys.length) setErrors((e) => { const n = { ...e }; clearKeys.forEach((k) => delete n[k]); return n; });
    setSubmitError('');
    setDupOverride(false); // shape may have changed — re-arm the duplicate check
  };

  // Seed the anchor day into block 1 when weekly and no day is selected anywhere
  // (mirrors the old auto-set of daysOfWeek on date change).
  useEffect(() => {
    if (form.repeat !== 'weekly' || !form.blocks || !form.date) return;
    if (form.blocks.some((b) => b.days.length)) return;
    const dow = dayOfWeekKey(form.date);
    setForm((f) => {
      if (!f.blocks || f.blocks.some((b) => b.days.length)) return f;
      return { ...f, blocks: f.blocks.map((b, i) => (i === 0 ? { ...b, days: [dow] } : b)) };
    });
  }, [form.date, form.repeat, form.blocks]);

  // Auto-set default endCount when frequency changes
  useEffect(() => {
    if (form.repeat !== 'none' && form.endType === 'count') {
      const defaults = RECURRENCE_DEFAULTS[form.repeat];
      if (defaults) setForm((f) => ({ ...f, endCount: defaults.endCount }));
    }
  }, [form.repeat, form.endType]);

  // Weekly (schedule blocks): the first scheduled day on/after the picked date is
  // the series anchor. The block holding it is the series DEFAULT — the master job
  // carries its time + crew; every day in the other blocks becomes a full
  // dayOverrides entry (times + crew), which is what the engine + reducers resolve.
  const weeklyPlan = useMemo(() => {
    if (form.repeat !== 'weekly' || !form.date || !form.blocks) return null;
    const blocks = form.blocks.filter((b) => b.days.length && b.startTime && b.endTime);
    if (!blocks.length) return null;
    const union = [...new Set(blocks.flatMap((b) => b.days))].sort((a, z) => a - z);
    // Walk forward on calendar-day strings. This used to hop a Date built from
    // `form.date + 'T12:00'` — correct only because noon absorbs the device's offset.
    // Keys carry no offset to absorb, so the anchor can't be dropped by accident.
    for (let i = 0; i < 7; i++) {
      const key = addDaysKey(form.date, i);
      const owner = blocks.find((b) => b.days.includes(dayOfWeekKey(key)));
      if (owner) {
        const dayOverrides = {};
        for (const b of blocks) {
          if (b === owner) continue;
          for (const dow of b.days) dayOverrides[dow] = { startTime: b.startTime, endTime: b.endTime, crewIds: b.crewIds || [] };
        }
        return { blocks, union, owner, anchorDate: key, dayOverrides: Object.keys(dayOverrides).length ? dayOverrides : null };
      }
    }
    return null;
  }, [form.repeat, form.date, form.blocks]);

  const startAt = form.repeat === 'weekly'
    ? (weeklyPlan ? composeIso(weeklyPlan.anchorDate, weeklyPlan.owner.startTime) : null)
    : (form.date && form.startTime ? composeIso(form.date, form.startTime) : null);
  // composeEndIso rolls to the next day when end <= start (overnight cleans) —
  // same-day composition stored endAt < startAt and inverted conflict math.
  const endAt = form.repeat === 'weekly'
    ? (weeklyPlan ? composeEndIso(weeklyPlan.anchorDate, weeklyPlan.owner.startTime, weeklyPlan.owner.endTime) : null)
    : (form.date && form.endTime ? composeEndIso(form.date, form.startTime, form.endTime) : null);

  // Conflicts: weekly checks each block's first occurrence with that block's crew
  // (grouped by the block's days for the warning); single jobs keep the old check.
  const conflictGroups = useMemo(() => {
    // The draft's crew for conflict / time-off checks = the named crew (crewResolve),
    // so creation-time warnings match the row that gets written.
    const effIds = (crewIds) => draftEffectiveCrewIds(state, { crewIds: crewIds || [] });
    if (form.repeat === 'weekly') {
      if (!weeklyPlan || !form.date) return [];
      const groups = [];
      for (const b of weeklyPlan.blocks) {
        const ids = effIds(b.crewIds);
        if (!ids.length) continue;
        let firstDate = null;
        for (let i = 0; i < 7 && !firstDate; i++) {
          const key = addDaysKey(form.date, i);
          if (b.days.includes(dayOfWeekKey(key))) firstDate = key;
        }
        if (!firstDate) continue;
        const cs = selectCrewConflicts(state, ids, composeIso(firstDate, b.startTime), composeIso(firstDate, b.endTime), initialData?.id || null);
        if (cs.length) groups.push({ label: b.days.map((d) => DAY_LABELS[d]).join(' & '), conflicts: cs });
      }
      return groups;
    }
    if (!startAt || !endAt) return [];
    const ids = effIds(form.crewIds);
    if (!ids.length) return [];
    const cs = selectCrewConflicts(state, ids, startAt, endAt, initialData?.id || null);
    return cs.length ? [{ label: null, conflicts: cs }] : [];
  }, [state, form.repeat, form.date, form.crewIds, form.clientId, form.siteId, weeklyPlan, startAt, endAt, initialData?.id]);

  const recurrence = useMemo(() => {
    if (form.repeat === 'none' || mode === 'edit') return null;
    const end = {
      endType: form.endType,
      endCount: form.endType === 'count' ? (Number(form.endCount) || 12) : null,
      endDate: form.endType === 'date' && form.endDate ? composeIso(form.endDate, '23:59') : null,
    };
    if (form.repeat === 'weekly') {
      if (!weeklyPlan) return null;
      return {
        frequency: 'weekly',
        daysOfWeek: weeklyPlan.union,
        ...end,
        ...(weeklyPlan.dayOverrides ? { dayOverrides: weeklyPlan.dayOverrides } : {}),
      };
    }
    return { frequency: form.repeat, daysOfWeek: null, ...end };
  }, [form.repeat, weeklyPlan, form.endType, form.endCount, form.endDate, mode]);

  const validate = () => {
    const e = {};
    if (!form.clientId) e.clientId = 'Select a company';
    if (!form.siteId) e.siteId = 'Select a location';
    if (!form.date) e.date = 'Pick a date';
    if (form.repeat === 'weekly' && mode !== 'edit') {
      const blockErrs = {};
      let anyDays = false;
      for (const b of form.blocks || []) {
        const be = {};
        // A day-less block: distinguish ABANDONED from CONFIGURED-but-forgot-days.
        // An untouched "Add schedule block" click is simply ignored — it used to
        // hard-block submit with an error the scheduler had no reason to connect
        // to a blank extra block. But a block the scheduler DID configure still
        // errors: silently dropping it would erase a planned recurring clean,
        // discovered by a crew no-show — the exact hazard JobDetail's sibling
        // guard names. "Configured" = crew picked OR times changed from the
        // clone source (addBlock copies block 1's times; standing-crew accounts
        // deliberately leave crewIds empty, so times are their only signal).
        if (!b.days.length) {
          const firstBlock = (form.blocks || [])[0];
          const configured = (b.crewIds || []).length > 0
            || (b !== firstBlock && firstBlock
              && (b.startTime !== firstBlock.startTime || b.endTime !== firstBlock.endTime));
          if (configured) blockErrs[b.key] = { days: 'Pick at least one day for this block (or remove it)' };
          continue;
        }
        anyDays = true;
        if (!b.startTime) be.startTime = 'Required';
        else if (!isStrictHm(b.startTime)) be.startTime = 'Enter a valid time';
        if (!b.endTime) be.endTime = 'Required';
        else if (!isStrictHm(b.endTime)) be.endTime = 'Enter a valid time';
        if (Object.keys(be).length) blockErrs[b.key] = be;
      }
      if (!anyDays) e.days = 'Pick at least one day';
      if (Object.keys(blockErrs).length) e.blocks = blockErrs;
    } else {
      // Strict HH:MM only — a native type=time field always satisfies this; a
      // text-degraded field (no type=time support) can hold whatever was typed,
      // and composeIso silently composes a WRONG instant from a malformed time
      // ("1800" reads as hour 1800 → a date +75 days out). normalizeHm on blur
      // auto-corrects the recognizable forms; what's left is a hard stop.
      if (!form.startTime) e.startTime = 'Required';
      else if (!isStrictHm(form.startTime)) e.startTime = 'Enter a valid time';
      if (!form.endTime) e.endTime = 'Required';
      else if (!isStrictHm(form.endTime)) e.endTime = 'Enter a valid time';
    }
    if (form.repeat !== 'none' && form.endType === 'date' && !form.endDate) e.endDate = 'Pick an end date';
    // An end date BEFORE the start silently produced a one-row "series" (the
    // expansion cutoff sat behind the start) — the schedule looked empty and
    // the office re-created it. Same for a typed count past the 52 hard cap,
    // which used to clamp silently.
    if (form.repeat !== 'none' && form.endType === 'date' && form.endDate && form.endDate < form.date) e.endDate = 'End date is before the start date';
    if (form.repeat !== 'none' && form.endType === 'count' && Number(form.endCount) > 52) e.endCount = 'Maximum 52 occurrences';
    return e;
  };

  const submit = (e) => {
    e.preventDefault();
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length) {
      setSubmitError(`Please complete: ${Object.keys(errs).map((k) => FIELD_LABELS[k]).filter(Boolean).join(', ')}.`);
      return;
    }
    setSubmitError('');
    const payload = {
      clientId: form.clientId,
      siteId: form.siteId || null,
      serviceId: form.serviceId,
      crewIds: form.repeat === 'weekly' && weeklyPlan ? (weeklyPlan.owner.crewIds || []) : form.crewIds,
      startAt, endAt,
      notes: form.notes,
    };
    // Any job create/update dispatched before the FULL set hydrates cannot be mirrored
    // to public.jobs (mirrorJobs no-ops while !jobsReady) — it lives only in RAM and is
    // lost on reload (the "nothing saves" report, 2026-08-12, on a slow link). This used
    // to guard only the series-create path below; EVERY mutation here needs it.
    if (!jobsHydrated) {
      setSubmitError('Still loading the full schedule. Try again in a few seconds.');
      return;
    }
    // Save-time crew guard: a clean must name at least one active cleaner or it shows
    // on no one's schedule and can't be clocked in. HARD BLOCK. Weekly: blocked only
    // when EVERY weekday block is empty.
    const draftUnassigned = (crewIds) => selectIsJobUnassigned(state, {
      crewIds: crewIds || [],
      siteId: form.siteId || null,
      clientId: form.clientId,
    });
    const isUnassigned = form.repeat === 'weekly'
      ? (!weeklyPlan || weeklyPlan.blocks.every((b) => draftUnassigned(b.crewIds)))
      : draftUnassigned(form.crewIds);
    if (isUnassigned) {
      setSubmitError('Assign at least one cleaner. A clean can’t be saved with no one on it.');
      return;
    }
    if (mode === 'edit' && initialData) {
      if (seriesScope === 'future' && initialData.seriesId) {
        // "This & all future": non-time fields ride the uniform patch; the day move
        // rides dayShift and the time move rides timePatch — never startAt/endAt in
        // the patch (the reducer spreads it onto every occurrence). fromDate pins the
        // change to this occurrence forward, so past/completed cleans are untouched.
        const orig = splitIso(initialData.startAt);
        const origEnd = splitIso(initialData.endAt);
        const dayShift = diffDaysKey(orig.date, form.date);
        const timeChanged = form.startTime !== orig.time || form.endTime !== origEnd.time;
        // ⚠️ ONLY THE FIELDS THE USER ACTUALLY CHANGED ride the uniform patch.
        //
        // `crewIds` was included unconditionally, and the reducer spreads this patch onto
        // EVERY future occurrence — so editing just the notes on a multi-day weekly series
        // flattened one occurrence's crew across all of them, destroying the per-day
        // assignments held in recurrence.dayOverrides. The user never touched crew and got
        // no indication it had been rewritten.
        //
        // Same coupling fixed in TimeEntryModal and ClientDetail: a form must not write a
        // field the user did not edit. Here the baseline is `initialData`, which is the
        // occurrence the modal opened on, so the comparison is direct.
        const sameCrew = (a, b) => {
          const x = [...(a || [])].sort().join(',');
          const y = [...(b || [])].sort().join(',');
          return x === y;
        };
        // Never reach an occurrence that has already STARTED (Sept 2: tonight's
        // in-progress clean was rewritten/deleted by a "this & future" edit). A day
        // move anchors on the opened occurrence, so a started one can't move with
        // the series at all; other edits apply from the next occurrence.
        const scope = seriesFromDate(initialData);
        if (scope.started && dayShift) {
          setSubmitError(STARTED_SERIES_MOVE_BLOCK);
          return;
        }
        const seriesPatch = {};
        if (form.clientId !== initialData.clientId) seriesPatch.clientId = form.clientId;
        if ((form.siteId || null) !== (initialData.siteId || null)) seriesPatch.siteId = form.siteId || null;
        if (form.serviceId !== initialData.serviceId) seriesPatch.serviceId = form.serviceId;
        if (!sameCrew(form.crewIds, initialData.crewIds)) seriesPatch.crewIds = form.crewIds;
        if ((form.notes || '') !== (initialData.notes || '')) seriesPatch.notes = form.notes;

        dispatch({
          type: ACTIONS.UPDATE_JOB_SERIES,
          seriesId: initialData.seriesId,
          fromDate: scope.fromDate,
          patch: seriesPatch,
          // "This & all future" includes this visit even if it was changed on its own.
          anchorId: initialData.id,
          // Absolute target, not a relative shift: adoptRemote replays recorded
          // actions after any peer's save, and a replayed relative dayShift
          // DOUBLE-moved the series. The reducer derives the shift from where
          // the anchor sits NOW and no-ops once the move has applied.
          ...(dayShift ? { targetDayKey: form.date } : {}),
          ...(timeChanged ? { timePatch: { startTime: form.startTime, endTime: form.endTime } } : {}),
        });
        toast.success(scope.started ? `Updated future occurrences. ${STARTED_SERIES_NOTE}` : 'Updated all future jobs in series');
      } else {
        dispatch({ type: ACTIONS.UPDATE_JOB, id: initialData.id, patch: payload });
        toast.success('Job updated');
      }
    } else if (recurrence) {
      // Windowed-jobs law: materializing a series against a partial job set can't be
      // checked for duplicates (hydration is gated above, so the full set is present here).
      // Same-shape guard: the 2026-07-30 incident stacked 5-8 identical series
      // per site because each create LOOKED like it did nothing, so the office
      // kept clicking. A series at this site with the same weekday pattern and
      // start time requires an explicit second submit.
      const dup = findSameShapeSeries(state.jobs, payload.siteId, payload.clientId, startAt, recurrence);
      if (dup && !dupOverride) {
        setDupOverride(true);
        setSubmitError('A matching repeating schedule already exists for this location at this time. Click again to create another anyway.');
        return;
      }
      // Ids minted at DISPATCH so the recorded action replays as a no-op (the
      // reducer skips a seriesId that already exists) — the duplicate machine.
      dispatch({ type: ACTIONS.ADD_JOB_SERIES, seriesId: newId('ser'), baseJob: payload, recurrence });
      // HONEST feedback: say exactly what materialized and through when — a
      // vague success toast over an (apparently) empty calendar is what drove
      // the repeat-create loop. Mirrors the reducer's expansion inputs.
      const preview = expandRecurrence({
        startAt, endAt, recurrence,
        until: new Date(startAt).getTime() + HORIZON_DAYS * 86400000,
      });
      const total = preview.length + 1;
      const lastAt = preview.length ? preview[preview.length - 1].startAt : startAt;
      toast.success(`Scheduled ${total} visit${total === 1 ? '' : 's'} through ${fmtDate(lastAt)}${recurrence.endType === 'never' ? ' (more generate as dates approach)' : ''}`);
      if (total === 1) toast.error('Only the first visit was created. Double-check the repeat settings and end date.');
    } else {
      dispatch({ type: ACTIONS.ADD_JOB, job: { id: newId('j'), ...payload } });
      toast.success('Job created');
    }
    onClose();
  };

  const onRepeatChange = (value) => {
    if (value === 'weekly') {
      const blocks = form.blocks?.length ? form.blocks : [{
        key: 1,
        days: form.date ? [dayOfWeekKey(form.date)] : [],
        startTime: form.startTime,
        endTime: form.endTime,
        crewIds: [...form.crewIds],
      }];
      update({ repeat: value, blocks }, ['days', 'blocks', 'endDate']);
    } else {
      update({ repeat: value }, ['days', 'blocks', 'endDate']);
    }
  };

  // null (not 'Unknown') for an id with no matching user — callers filter it out rather
  // than rendering a phantom teammate. See the block-summary note below.
  const crewName = (id) => crewPool.find((u) => u.id === id)?.name || null;
  // Human summary of a weekly blocks plan, e.g.
  // "Weekly, ongoing · Tue & Thu 6:00–9:00 PM — Ana Reyes · Sat 8:00–11:00 AM — Marcus Cole"
  const weeklySummary = form.repeat === 'weekly' && weeklyPlan && recurrence ? (() => {
    const multi = weeklyPlan.blocks.length > 1;
    const bits = weeklyPlan.blocks.map((b) => {
      const days = b.days.map((d) => DAY_LABELS[d]).join(' & ');
      const times = fmtTimeRange(composeIso(weeklyPlan.anchorDate, b.startTime), composeIso(weeklyPlan.anchorDate, b.endTime));
      // Resolve then DROP unknowns, rather than printing "Unknown" for each. A crew id
      // can outlive its user: DELETE_USER scrubs ids out of `state.jobs`, but that array
      // is only the boot window since E6, so an out-of-window series master keeps the
      // departed id in its recurrence.dayOverrides — and TOP_UP then carries it into
      // every occurrence it materialises. Every other surface already resolves crew
      // through selectEffectiveCrewForJob, which drops ids with no active user; this
      // summary was the one place a dangling id surfaced, as a phantom "Unknown"
      // teammate on the block line. The underlying residue is logged in LOOP_REVIEW —
      // it is invisible everywhere else and not worth gating user deletion on.
      const named = (b.crewIds || []).map(crewName).filter(Boolean);
      const crew = named.length ? named.join(', ') : 'no named crew';
      return `${days} ${times}${multi ? `. ${crew}` : ''}`;
    });
    const endBit = recurrence.endType === 'count' ? `${recurrence.endCount} times`
      : recurrence.endType === 'date' && form.endDate ? `until ${new Date(form.endDate + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
      : 'ongoing';
    return `Weekly, ${endBit} · ${bits.join(' · ')}`;
  })() : null;

  // Crew is exactly whoever the office names on the clean — every clean must name at
  // least one cleaner to save (enforced in submit and the reducer). No account or
  // site default fills it in.

  return (
    <Modal open={open} onClose={onClose} title={mode === 'edit' ? 'Edit Job' : 'New Job'} size="wide">
      {/* noValidate: time inputs carry step=900 for 15-min picker increments, but a
          hand-typed odd minute must still submit. Validate() is the real gate. */}
      <form onSubmit={submit} noValidate>
        {mode === 'edit' && seriesScope === 'future' && (
          <div className="series-info-bar" style={{ marginBottom: 12 }}>
            <Icon name="repeat" size={14} />
            <span>Rescheduling all future jobs in this series. Date, time, crew &amp; details apply to every upcoming job. Past cleans are untouched.</span>
          </div>
        )}
        <div className="newjob-2col">
          <div className="newjob-col">
            <div className="newjob-colhd"><span className="newjob-colhd-n">1</span> Details</div>
            <FormField label="Company" required error={errors.clientId}>
              <ClientPicker
                value={form.clientId}
                onChange={(id) => update({ clientId: id, siteId: selectSitesForClient(state, id)[0]?.id || '', serviceId: selectClientById(state, id)?.serviceId || '', crewIds: [] }, ['clientId', 'siteId'])}
                placeholder="Select a company"
              />
            </FormField>
            {mode !== 'edit' && form.clientId && (
              // Signpost: durable service material doesn't attach to a job. Access
              // notes and door codes live per site; the checklist and reference link
              // live on the account. Say so where an admin would look for those fields.
              <div className="text-xs text-muted" style={{ marginTop: -6, marginBottom: 13 }}>
                Access notes, door codes &amp; expected time live on the customer&apos;s location; the clean checklist &amp; reference link on the account. Cleaners see them on every clean automatically.{' '}
                <Link className="linklike" to={`/clients/${form.clientId}?tab=access`} state={nav} onClick={onClose}>Open the account</Link>
              </div>
            )}
            {form.repeat !== 'weekly' && (
              <FormField label="Crew" required help="Type to search and pick who works this clean. Everyone named can clock in; at least one is required.">
                <CrewPicker
                  value={form.crewIds}
                  onChange={(ids) => update({ crewIds: ids })}
                  pool={crewPool}
                  placeholder="Add crew…"
                />
              </FormField>
            )}
            <FormField label="Notes">
              {/* Grows downward as you type; a very long note makes the column
                  (desktop) or the card (mobile) scroll — see AutoGrowTextarea. */}
              <AutoGrowTextarea rows={2} value={form.notes} onChange={(e) => update({ notes: e.target.value })} placeholder="Optional notes…" />
            </FormField>
          </div>

          <div className="newjob-col">
            <div className="newjob-colhd"><span className="newjob-colhd-n">2</span> When</div>
            <FormField
              label="Date" type="date" required error={errors.date} value={form.date}
              onChange={(e) => update({ date: e.target.value }, ['date'])}
              help={form.repeat === 'weekly' && mode !== 'edit' ? 'The series starts on the first scheduled day on or after this date.' : undefined}
            />
            {form.repeat !== 'weekly' && (
              <div className="form-row">
                {/* onBlur: on browsers where type=time degrades to free text, typed
                    military/12-hour forms ("1800", "6:00 PM") auto-correct to the
                    internal HH:MM on leaving the field; native inputs never trip it.
                    Anything unrecognizable is left for validate() to hard-reject.
                    composeIso must never see a non-HH:MM string (see normalizeHm). */}
                <FormField label="Start" type="time" step={900} required error={errors.startTime} value={form.startTime}
                  onChange={(e) => update({ startTime: e.target.value }, ['startTime'])}
                  onBlur={() => { const n = normalizeHm(form.startTime); if (n && n !== form.startTime) update({ startTime: n }, ['startTime']); }} />
                <FormField label="End" type="time" step={900} required error={errors.endTime} value={form.endTime}
                  onChange={(e) => update({ endTime: e.target.value }, ['endTime'])}
                  onBlur={() => { const n = normalizeHm(form.endTime); if (n && n !== form.endTime) update({ endTime: n }, ['endTime']); }} />
              </div>
            )}

            {mode !== 'edit' && (
              <div className="recurrence-section">
                <FormField label="Repeat" as="select" value={form.repeat}
                  onChange={(e) => onRepeatChange(e.target.value)}
                  options={[
                    { value: 'none', label: 'Does not repeat' },
                    { value: 'daily', label: 'Daily' },
                    { value: 'weekly', label: 'Weekly' },
                    { value: 'biweekly', label: 'Every 2 weeks' },
                    { value: 'monthly', label: 'Monthly' },
                  ]}
                  help={form.repeat === 'weekly' ? 'Days can run at different times with different crew. Split them across schedule blocks.' : undefined}
                />
                {form.repeat === 'weekly' && form.blocks && (
                  <>
                    <ScheduleBlocksEditor
                      blocks={form.blocks}
                      onChange={(blocks) => update({ blocks }, ['days', 'blocks'])}
                      crewPool={crewPool}
                      errors={errors.blocks || {}}
                    />
                    {errors.days && <div className="form-error" style={{ marginBottom: 8 }}>{errors.days}</div>}
                  </>
                )}
                {form.repeat !== 'none' && (
                  <div className="form-row" style={{ alignItems: 'flex-end' }}>
                    <FormField label="Ends" as="select" value={form.endType}
                      onChange={(e) => update({ endType: e.target.value }, ['endDate'])}
                      options={[
                        { value: 'count', label: 'After N occurrences' },
                        { value: 'date', label: 'On a specific date' },
                        { value: 'never', label: 'Never (ongoing)' },
                      ]}
                    />
                    {form.endType === 'count' && (
                      <FormField label="Times" type="number" min={1} max={52} value={form.endCount}
                        onChange={(e) => update({ endCount: e.target.value })} />
                    )}
                    {form.endType === 'date' && (
                      <FormField label="Until" type="date" error={errors.endDate} value={form.endDate}
                        onChange={(e) => update({ endDate: e.target.value }, ['endDate'])} />
                    )}
                  </div>
                )}
                {(weeklySummary || (form.repeat !== 'weekly' && recurrence)) && (
                  <div className="text-xs text-muted" style={{ marginTop: 4, marginBottom: 8 }}>
                    <Icon name="repeat" size={12} /> {weeklySummary || (() => {
                      const freqLabel = form.repeat === 'biweekly' ? 'Every 2 weeks' : form.repeat.charAt(0).toUpperCase() + form.repeat.slice(1);
                      const endBit = recurrence.endType === 'count' ? ` (${recurrence.endCount} times)`
                        : recurrence.endType === 'date' && form.endDate ? ` until ${new Date(form.endDate + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
                        : '. Ongoing';
                      return freqLabel + endBit;
                    })()}
                    {recurrence?.endType === 'never' && ' (schedules keep generating into the future)'}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {conflictGroups.length > 0 && (
          <div className="conflict-warning">
            <Icon name="warning" size={14} />
            <div>
              <strong>Scheduling conflict{(conflictGroups.length > 1 || conflictGroups[0].conflicts.length > 1) ? 's' : ''}</strong>
              {conflictGroups.map((g, gi) => (
                <div key={gi}>
                  {g.label && <div className="text-xs" style={{ fontWeight: 600, marginTop: 2 }}>{g.label}</div>}
                  {g.conflicts.map((c, i) => {
                    if (c.timeOff) {
                      return (
                        <div key={i} className="text-xs">
                          {c.userName} has time off that day{c.timeOff.reason ? ` (${c.timeOff.reason})` : ''}
                        </div>
                      );
                    }
                    const cl = selectClientById(state, c.job.clientId);
                    return (
                      <div key={i} className="text-xs">
                        {c.userName} is assigned to {cl?.name || 'another job'} {fmtTimeRange(c.job.startAt, c.job.endAt)}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}

        {submitError && (
          <div className="conflict-warning" style={{ marginTop: 4 }}>
            <Icon name="warning" size={14} />
            <span>{submitError}</span>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">{mode === 'edit' ? 'Save Changes' : 'Create Job'}</button>
        </div>
      </form>
    </Modal>
  );
}
