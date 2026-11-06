// Checklists today (/checklists) — Matt's "Checklists" board (Account Manager Hub, 2026-10-07):
// today's visits that owe a checklist, in two groups (Day / Evening, plan S1), each with where
// its checklist stands. Plan docs/plans/2026-10-09-manager-view-redesign.md §1 and S9.
//
// THE RULES ARE NOT THIS SCREEN'S:
//   • the state comes from lib/managerToday: Not started (no clock-in) · In progress (clocked
//     in, nothing saved yet) · Complete / Not finished (a SAVED checklist, judged by the clock-
//     out gate's own rule, crewChecklist.isChecklistComplete). A checklist counts once it is
//     saved, so an in-progress one shows NO count (Daniel's hub ruling, 2026-10-08, plan S9);
//     a saved one shows its stored "7 of 9" with a bar.
//   • the banner says the clock-out rule as it works: per cleaner, and the office can turn it
//     off for one cleaner in their profile (user.clockRules.checklistBlockOff, R6). A row only
//     says "can't clock out" when someone owing that checklist still has the block on.
//   • who owes which checklist is the crewChecklist resolver's answer (per cleaner, covers included).
// A row opens the saved checklist (ChecklistResultModal, read in full by its clean) or the
// visit. "All checklists" is the Quality hub's Checklists tab. Gate: qc.view, office only.
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Badge from '../components/Badge';
import ChecklistResultModal from '../components/ChecklistResultModal';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';
import ListPager from '../components/ListPager';
import { useToast } from '../components/Toast';
import { StatCard } from './reports/reportKit';
import {
  ManagerScopeFilter, TodayGate, TodayHead, useMgrParam, visitLabel, shortName,
} from '../components/ManagerTodayKit';
import { useManagerToday } from '../hooks/useManagerToday';
import { usePagedRows } from '../hooks/usePagedRows';
import { useFromHere } from '../hooks/useFromHere';
import { useSelector } from '../store';
import * as qcApi from '../lib/qcApi';
import { CHECKLIST_STATE, VISIT_GROUP, VISIT_STATUS, countVisits } from '../lib/managerToday';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';

const selUsers = (s) => s.users;
// The Day group's one line when every checklist in it is complete (Matt's board).
const ALL_DAY_DONE_KEY = 'cklToday.allDayComplete';

const STATE_WORDS = {
  [CHECKLIST_STATE.COMPLETE]: ['green', 'cklToday.state.complete'],
  [CHECKLIST_STATE.NOT_FINISHED]: ['red', 'cklToday.state.notFinished'],
  [CHECKLIST_STATE.IN_PROGRESS]: ['blue', 'cklToday.state.inProgress'],
  [CHECKLIST_STATE.NOT_STARTED]: ['slate', 'cklToday.state.notStarted'],
};

// The line under a row, from the VISIT's status (Matt's board: "crew arrived late — blocked
// from clock-out", "crew not checked in — checklist can't start").
function noteFor(t, v) {
  if (v.status === VISIT_STATUS.NO_CHECK_IN) return ['danger', t('cklToday.note.noCheckIn')];
  if (v.status === VISIT_STATUS.LATE) return ['warn', t('cklToday.note.late')];
  if (v.status === VISIT_STATUS.UPCOMING) return [null, t('cklToday.note.upcoming', { time: v.startAt })];
  if (v.checklist === CHECKLIST_STATE.NOT_FINISHED && !v.results.length) return ['danger', t('cklToday.note.leftUnsaved')];
  if (v.status === VISIT_STATUS.IN_PROGRESS && v.arrivedLateMins > 0 && v.checklist !== CHECKLIST_STATE.COMPLETE) {
    return ['warn', v.blocksClockOut
      ? t('cklToday.note.arrivedLateBlocked', { count: v.arrivedLateMins })
      : t('cklToday.note.arrivedLate', { count: v.arrivedLateMins })];
  }
  return null;
}

// The row's tint: a problem with the visit (nobody in, late) first; then a checklist the crew
// LEFT short (red); a late arrival still working (amber); a visit not started yet (quiet).
// A short save while the crew is still on the clock is progress, not yet a miss.
function toneFor(v, note) {
  if (v.status === VISIT_STATUS.NO_CHECK_IN) return 'is-missing';
  if (v.status === VISIT_STATUS.LATE) return 'is-late';
  if (v.checklist === CHECKLIST_STATE.NOT_FINISHED && v.status !== VISIT_STATUS.IN_PROGRESS) return 'is-missing';
  if (note?.[0] === 'warn') return 'is-late';
  if (v.checklist === CHECKLIST_STATE.NOT_STARTED) return 'is-quiet';
  return '';
}

function ChecklistRow({ visit: v, usersById, onOpen, opening }) {
  const t = useT();
  const nav = useFromHere();
  const [variant, key] = STATE_WORDS[v.checklist] || STATE_WORDS[CHECKLIST_STATE.NOT_STARTED];
  const counted = v.total > 0 && (v.checklist === CHECKLIST_STATE.COMPLETE || v.checklist === CHECKLIST_STATE.NOT_FINISHED);
  const pct = counted ? Math.min(100, Math.round((v.completed / v.total) * 100)) : 0;
  const note = noteFor(t, v);
  const tone = toneFor(v, note);
  // The bar and count: green when complete, red when the crew left it short, else the
  // in-progress blue (a save part-way through a visit still under way).
  const barVariant = v.checklist === CHECKLIST_STATE.COMPLETE ? 'green'
    : (v.status === VISIT_STATUS.IN_PROGRESS ? 'blue' : 'red');
  return (
    <li className={`mgt-ck-row ${tone}`}>
      <div className="mgt-ck-head">
        <Link to={`/schedule/${v.jobId}`} state={nav} className="mgt-ck-name">{visitLabel(t, v)}</Link>
        {counted
          ? <span className={`mgt-ck-count is-${barVariant}`}>{t('cklToday.ofTotal', { done: v.completed, total: v.total })}</span>
          : <Badge variant={variant}>{t(key)}</Badge>}
      </div>
      {counted && (
        <span className={`mgt-bar is-${barVariant}`} role="img" aria-label={t('cklToday.ofTotal', { done: v.completed, total: v.total })}>
          <span style={{ width: `${pct}%` }} />
        </span>
      )}
      {counted && v.checklist === CHECKLIST_STATE.NOT_FINISHED && <Badge variant="red">{t('cklToday.state.notFinished')}</Badge>}
      {note && (
        <p className={`mgt-ck-note text-xs${note[0] ? ` is-${note[0]}` : ''}`}>
          {note[0] && <Icon name="lock" size={12} />}
          <span>{note[1]}</span>
        </p>
      )}
      {v.results.length > 0 && (
        <div className="mgt-ck-actions">
          {v.results.map((r) => {
            const who = shortName(usersById.get(r.userId)?.name) || '';
            const label = v.results.length > 1 ? t('cklToday.openFor', { name: who }) : t('cklToday.open');
            return (
              <button key={r.id || r.userId} type="button" className="btn btn-link" disabled={opening === r.id} onClick={() => onOpen(r)}>
                {label}
              </button>
            );
          })}
        </div>
      )}
    </li>
  );
}

function Group({ title, visits, param, allDoneKey, usersById, onOpen, opening }) {
  const t = useT();
  const pager = usePagedRows(visits, { param });
  const allDone = visits.length > 0 && visits.every((v) => v.checklist === CHECKLIST_STATE.COMPLETE);
  return (
    <section className="card mgt-group">
      <h2 className="mgt-group-title">{title}</h2>
      {visits.length === 0 ? (
        <p className="text-sm text-muted">{t('mgrToday.groupEmpty')}</p>
      ) : allDone && allDoneKey ? (
        <p className="mgt-all-done"><Icon name="check" size={16} /><span>{t(allDoneKey, { count: visits.length })}</span></p>
      ) : (
        <>
          <ul className="mgt-ck-list">
            {pager.pageRows.map((v) => <ChecklistRow key={v.jobId} visit={v} usersById={usersById} onOpen={onOpen} opening={opening} />)}
          </ul>
          <ListPager pager={pager} noun={t('pager.noun.visits')} />
        </>
      )}
    </section>
  );
}

export default function ChecklistsToday() {
  const t = useT();
  const toast = useToast();
  const nav = useFromHere();
  const users = useSelector(selUsers);
  const usersById = useMemo(() => new Map((users || []).map((u) => [u.id, u])), [users]);
  // The owner's pick of an Operations Manager's team rides in too (the Operations view's tile).
  const [mgrId, setMgrId, opsManagerId] = useMgrParam({ teamPick: true });
  const today = useManagerToday({ mgrId, opsManagerId });

  // Only the visits that owe a checklist are this page's rows; the rest are counted below.
  const owed = useMemo(() => (today.visits || []).filter((v) => v.checklist !== CHECKLIST_STATE.NONE), [today.visits]);
  const counts = useMemo(() => countVisits(owed), [owed]);
  const without = (today.visits?.length || 0) - owed.length;
  const day = useMemo(() => owed.filter((v) => v.group === VISIT_GROUP.DAY), [owed]);
  const evening = useMemo(() => owed.filter((v) => v.group === VISIT_GROUP.EVENING), [owed]);
  // How many cleaners owing a checklist today have the office's override on (R6).
  const exempt = useMemo(() => {
    const ids = new Set();
    for (const v of owed) for (const c of v.crew) if (usersById.get(c.userId)?.clockRules?.checklistBlockOff === true) ids.add(c.userId);
    return ids.size;
  }, [owed, usersById]);

  // The saved checklist in full: the window read carries counts, not items, so a row reads its
  // clean's own checklists (the Quality hub's list read, crew-scoped on the server) and opens
  // the one it counted.
  const [result, setResult] = useState(null);
  const [opening, setOpening] = useState(null);
  const guard = useRef(0);
  const openResult = async (r) => {
    const token = ++guard.current;
    setOpening(r.id);
    try {
      const v = (today.visits || []).find((x) => x.results.some((y) => y.id === r.id));
      const rows = r.jobId ? await qcApi.listChecklists({ jobId: r.jobId }) : await qcApi.listChecklists({ siteId: v?.siteId });
      const row = (rows || []).find((x) => x.id === r.id);
      if (token !== guard.current) return;
      if (row) setResult(row); else toast.error(t('cklToday.openFailed'));
    } catch (e) {
      if (token === guard.current) toast.error(errorText(t, e, 'cklToday.openFailed'));
    } finally {
      if (token === guard.current) setOpening(null);
    }
  };

  const sub = today.visits
    ? [t('mgrToday.visitCount', { count: counts.total }), t('mgrToday.propertyCount', { count: counts.properties })].join(' · ') // i18n-ok: a separator between two catalog lines
    : null;

  return (
    <div className="page mgt-page">
      <TodayHead title={t('cklToday.title')} sub={sub}>
        <Link to="/inspections?tab=checklists" state={nav} className="btn btn-secondary">{t('cklToday.all')}</Link>
      </TodayHead>
      <ManagerScopeFilter value={mgrId} onChange={setMgrId} opsManagerId={opsManagerId} />
      <TodayGate today={today}>{() => (<>
        <div className="callout callout-info text-sm mgt-rule" role="note">
          <p>{t('cklToday.rule')}</p>
          {exempt > 0 && <p className="text-muted">{t('cklToday.ruleOff', { count: exempt })}</p>}
        </div>
        {owed.length === 0 ? (
          <EmptyState icon={<Icon name="check" size={28} />} title={t('cklToday.noneOwed')} message={t('cklToday.noneOwedHint')} />
        ) : (
          <>
            <div className="stat-grid mgt-tiles">
              <StatCard label={t('cklToday.tile.complete')} value={counts.checklists.complete} tone={counts.checklists.complete > 0 ? 'success' : null} />
              <StatCard label={t('cklToday.tile.inProgress')} value={counts.checklists.inProgress} />
              <StatCard label={t('cklToday.tile.notStarted')} value={counts.checklists.notStarted} />
              {counts.checklists.notFinished > 0 && (
                <StatCard label={t('cklToday.tile.notFinished')} value={counts.checklists.notFinished} tone="danger" />
              )}
            </div>
            <div className="mgt-groups">
              <Group title={t('mgrToday.group.day')} visits={day} param="dpage" allDoneKey={ALL_DAY_DONE_KEY} usersById={usersById} onOpen={openResult} opening={opening} />
              <Group title={t('mgrToday.group.evening')} visits={evening} param="epage" allDoneKey={null} usersById={usersById} onOpen={openResult} opening={opening} />
            </div>
          </>
        )}
        {without > 0 && <p className="text-sm text-muted mgt-footnote">{t('cklToday.withoutChecklist', { count: without })}</p>}
      </>)}</TodayGate>
      <ChecklistResultModal open={!!result} result={result} onClose={() => setResult(null)} />
    </div>
  );
}
