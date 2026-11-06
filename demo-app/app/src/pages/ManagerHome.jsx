// The manager's Home (the manager view redesign, Daniel's D1, 2026-10-09; UI_RULES §152) — Matt's
// "Account Manager Hub" boards mobile-01-home and web-01-dashboard, on what the app already knows.
//
//   • A MANAGER lands here (App.jsx HomeRoute). The OWNER reaches it through the "Owner cockpit ·
//     Manager view" switch (pages/OwnerHome), with the Manager filter (`?mgr=`, "All managers" by
//     default) — how Matt uses it on the one shared owner login. "View as" a manager shows it too.
//   • The header greets whoever is signed in (with the shared login that is the owner, so the
//     line under it names the MANAGER in view, never as if it named the person at the keyboard).
//     The bell is the app's own (AppLayout's floater), so it sits where it sits on every page.
//   • The shift band (who is not checked in), then the tiles in the boards' order: Schedule,
//     Inspections, Hours Approval, Client Requests, Checklists, Supplies, Property P&L — with
//     Customer messages after Client Requests: the customer messages waiting for the office's
//     reply are their own figure, never requests (HUB-24 (c), Matt 2026-10-12). On a phone a "+"
//     starts a new inspection (mobile-01).
//   • Every figure is an answered rule read through its owner (lib/managerHome, and the opened
//     page's own helpers) over a read that already exists, scoped to the manager in view. No new
//     endpoint. The reads are SHARED (lib/sharedRead): the manager nav's count pills and these
//     tiles are one read per figure, and the today figures are the today engine's one read
//     (hooks/useManagerToday) that Shift check-in, Checklists today and the Schedule's Today share.
//   • Each tile reads on its own: its own loading, its own error with Try again, its own offline
//     line (and it reads again by itself when the signal comes back). One failed read never
//     blanks the page.
import { useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useSelector } from '../store';
import { useAuth } from '../hooks/useAuth';
import { usePermissionChecker } from '../hooks/usePermission';
import { useFromHere } from '../hooks/useFromHere';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useManagerToday } from '../hooks/useManagerToday';
import {
  useInspectionsRead, useHoursRead, useRequestsRead, useMessagesRead, useSuppliesRead,
} from '../hooks/useManagerHomeReads';
import { useMgrParam } from '../components/ManagerTodayKit';
import EmptyState from '../components/EmptyState';
import FilterSelect from '../components/FilterSelect';
import FormField from '../components/FormField';
import Icon from '../components/Icon';
import Avatar from '../components/Avatar';
import { SUPERVISOR_ROLES, compareUsersByName } from '../lib/roles';
import { isActiveOpsManager, teamAccountManagers } from '../lib/teamScope';
import { isOfflineError } from '../lib/netError';
import { OFFICE_SCAN_PATH } from '../lib/scanLanding';
import { startOfDayKey } from '../lib/dates';
import {
  homeScope, homeTiles, holdsGate, inspectionsDueCount, inspectionTrend, hoursFigures, requestFigures,
  messageFigures, suppliesFigures, shiftBand, scheduleFigures, checklistsFigures, greetingPart, tileHref,
  accountManagerSignals,
} from '../lib/managerHome';
import { useT } from '../i18n/react';

// The greeting's lines, as literal keys (a key is never built at run time).
const GREETING = {
  morning: ['mgrHome.greet.morning', 'mgrHome.greet.morningName'],
  afternoon: ['mgrHome.greet.afternoon', 'mgrHome.greet.afternoonName'],
  evening: ['mgrHome.greet.evening', 'mgrHome.greet.eveningName'],
};
const MINUTES_PER_DAY = 24 * 60;
// The band's title per state (lib/managerHome shiftBand), as literal keys.
const BAND_TITLE = {
  allIn: 'mgrHome.band.allIn',
  notYet: 'mgrHome.band.notYet',
  finished: 'mgrHome.band.finished',
  none: 'mgrHome.band.none',
};

// A shared read (hooks/useSharedRead) as a tile's state: { phase: 'loading' | 'ok' | 'error' |
// 'offline', data, retry }. An answer on screen stays on screen while a re-read runs or fails.
function tileState(r, online) {
  if (r.data !== undefined) return { phase: 'ok', data: r.data, retry: r.refresh };
  if (!online || (r.error && isOfflineError(r.error))) return { phase: 'offline', data: null, retry: r.refresh };
  if (r.error) return { phase: 'error', data: null, retry: r.refresh };
  return { phase: 'loading', data: null, retry: r.refresh };
}
// The today engine's answer as a tile's state.
function todayState(today) {
  if (today.visits) return { phase: 'ok', data: today, retry: today.retry };
  if (today.offline) return { phase: 'offline', data: null, retry: today.retry };
  if (today.error) return { phase: 'error', data: null, retry: today.retry };
  return { phase: 'loading', data: null, retry: today.retry };
}

// What a tile shows before its figures: loading, offline, or an error with Try again.
function TileStatus({ read }) {
  const t = useT();
  if (read.phase === 'loading') return <span className="text-muted">{t('common.loading')}</span>;
  if (read.phase === 'offline') return <span className="mgrh-note">{t('mgrHome.tile.offline')}</span>;
  return (
    <span className="mgrh-note">
      {t('mgrHome.tile.error')}{' '}
      <button type="button" className="linklike mgrh-retry" onClick={read.retry}>{t('mgrHome.tile.retry')}</button>
    </span>
  );
}

// A Home tile: a tinted icon chip (a Badge variant's colours), the title, the figures, and the
// action that opens the page. The whole card is the link (the action stretches over it), the way
// Matt's phone board taps; on a phone a WIDE tile is a row with a chevron, as drawn.
function HomeTile({ icon, tone, title, to, cta, read, wide, children }) {
  const nav = useFromHere();
  return (
    <div className={`mgrh-slot${wide ? ' is-wide-phone' : ''}`}>
      <div className="card mgrh-tile">
        <span className={`mgrh-ic is-${tone}`} aria-hidden><Icon name={icon} size={20} /></span>
        <div className="mgrh-text">
          <h2 className="mgrh-tile-title">{title}</h2>
          <div className="mgrh-body text-sm">{read.phase === 'ok' ? children : <TileStatus read={read} />}</div>
        </div>
        <Link className="mgrh-cta text-sm" to={to} state={nav}>
          <span className="mgrh-cta-text">{cta}</span>
          <span className="mgrh-cta-chev" aria-hidden><Icon name="chevronRight" size={20} /></span>
        </Link>
      </div>
    </div>
  );
}

// The figures of a tile, each its own line part, with a quiet dot between them.
function Facts({ parts }) {
  const shown = parts.filter(Boolean);
  return (
    <span className="mgrh-facts">
      {shown.map((p, i) => (
        <span key={i}>{i > 0 && <span className="mgrh-dot" aria-hidden> · </span>}{p}</span>
      ))}
    </span>
  );
}

// The shift band (mobile-01's amber card): who is not checked in yet, and how many crews due on
// site are there. With nobody missing it CALMS to a quiet card ("All crews checked in", or what
// today holds) and is never hidden, so the manager sees it was checked, not that it vanished.
function ShiftBand({ read, band, asOf, to }) {
  const t = useT();
  const nav = useFromHere();
  const attention = read.phase === 'ok' && band.state === 'attention';
  let title;
  let sub = null;
  if (read.phase !== 'ok') title = <TileStatus read={read} />;
  else {
    title = attention ? t('mgrHome.band.missing', { count: band.missing }) : t(BAND_TITLE[band.state]);
    const asOfLine = t('mgrHome.band.asOf', { time: asOf });
    sub = band.due
      ? <Facts parts={[t('mgrHome.band.onSite', { onSite: band.onSite, due: band.due }), asOfLine]} />
      : <Facts parts={[band.total ? t('mgrHome.band.visits', { count: band.total }) : null, asOfLine]} />;
  }
  return (
    <section className={`card mgrh-band${attention ? ' is-attention' : ''}`} aria-label={t('mgrHome.band.label')}>
      <span className="mgrh-band-ic" aria-hidden><Icon name={attention ? 'clock' : 'check'} size={22} /></span>
      <div className="mgrh-band-text">
        <span className="mgrh-band-label text-xs">{attention ? t('mgrHome.band.labelAttention') : t('mgrHome.band.label')}</span>
        <span className="mgrh-band-title">{title}</span>
        {sub && <span className="mgrh-band-sub text-sm">{sub}</span>}
      </div>
      <Link className="mgrh-cta mgrh-band-cta text-sm" to={to} state={nav}>
        <span className="mgrh-cta-text">{t('mgrHome.band.cta')}</span>
        <span className="mgrh-cta-chev" aria-hidden><Icon name="chevronRight" size={20} /></span>
      </Link>
    </section>
  );
}

// `opsView`: the owner's (or an admin's) Operations view (OwnerHome ?view=ops, S131) — this Home
// as the Operations Manager picked in `?om=` (the first one by name when none is), acting as the
// owner: the OM's team, their account managers' section, the owner's own nav.
export default function ManagerHome({ opsView = false }) {
  const t = useT();
  const { currentUser } = useAuth();
  const check = usePermissionChecker();
  const online = useOnlineStatus();
  const [mgrParam, setManager] = useMgrParam();
  const [params, setParams] = useSearchParams();
  const clients = useSelector(useCallback((s) => s.clients, []));
  const users = useSelector(useCallback((s) => s.users, []));
  const opsSettings = useSelector(useCallback((s) => s.opsSettings, []));
  const tz = useSelector(useCallback((s) => s.company?.timezone, []));

  // The Operations view's OM: ?om= when it names an active Operations Manager, else the first.
  const opsManagers = useMemo(() => (users || []).filter(isActiveOpsManager).slice().sort(compareUsersByName), [users]);
  const omParam = params.get('om') || '';
  const opsManagerId = opsView ? (opsManagers.some((u) => u.id === omParam) ? omParam : (opsManagers[0]?.id || null)) : null;
  const setOpsManager = (id) => setParams((prev) => {
    const p = new URLSearchParams(prev);
    if (id) p.set('om', id); else p.delete('om');
    p.delete('mgr'); // another team: its account manager pick goes
    return p;
  }, { replace: true });

  const scope = useMemo(
    () => homeScope({ viewer: currentUser, mgrParam, clients: clients || [], users: users || [], opsManagerId }),
    [currentUser, mgrParam, clients, users, opsManagerId],
  );
  const empty = scope.clientIds !== null && scope.clientIds.size === 0;
  // The team in view (an OM's own Home, or the Operations view): its lead and account managers.
  const teamLead = scope.teamOf ? (users || []).find((u) => u.id === scope.teamOf) || null : null;
  const teamAms = useMemo(() => (scope.teamOf ? teamAccountManagers(users || [], scope.teamOf) : []), [users, scope.teamOf]);
  const ownTeam = !!scope.teamOf && scope.teamOf === currentUser?.id;
  const tiles = homeTiles(check);
  const show = (k) => !empty && tiles.includes(k);
  const showBand = !empty && holdsGate(check, 'band');

  // ── the header ──
  const firstName = currentUser?.name?.split(' ')[0] || '';
  const [plainKey, namedKey] = GREETING[greetingPart(new Date().getHours())];
  const greeting = firstName ? t(namedKey, { name: firstName }) : t(plainKey);
  const managers = useMemo(() => (users || [])
    .filter((u) => u.status === 'active' && SUPERVISOR_ROLES.includes(u.role) && (clients || []).some((c) => c.supervisorId === u.id))
    .slice().sort(compareUsersByName), [users, clients]);
  const picked = scope.mgrId ? (users || []).find((u) => u.id === scope.mgrId) : null;
  let subtitle;
  if (!scope.picker) subtitle = t('mgrHome.sub.self', { count: scope.propertyCount });
  else if (scope.mgrId) subtitle = t('mgrHome.sub.named', { name: picked?.name || '—', count: scope.propertyCount });
  else if (scope.pickerKind === 'team') {
    subtitle = ownTeam ? t('mgrTeam.sub.team', { count: scope.propertyCount })
      : t('mgrTeam.sub.ops', { name: teamLead?.name || '—', count: scope.propertyCount });
  } else subtitle = t('mgrHome.sub.all', { count: scope.propertyCount });
  // The team picker (an OM's Home, the Operations view): all of the team, or one member of it.
  const teamOptions = useMemo(() => (!scope.teamOf ? [] : [
    { value: '', label: t('mgrTeam.allMyTeam') },
    ...[teamLead, ...teamAms].filter(Boolean).map((m) => ({ value: m.id, label: m.id === currentUser?.id ? t('mgrToday.me', { name: m.name }) : m.name })),
  ]), [scope.teamOf, teamLead, teamAms, currentUser, t]);
  const opsOptions = useMemo(() => opsManagers.map((m) => ({ value: m.id, label: m.name })), [opsManagers]);
  const managerOptions = useMemo(() => [
    { value: '', label: t('mgrHome.allManagers') },
    ...managers.map((m) => ({ value: m.id, label: m.name })),
    // A link to a manager no longer on the list still shows whose figures these are.
    ...(picked && !managers.some((m) => m.id === picked.id) ? [{ value: picked.id, label: picked.name }] : []),
  ], [managers, picked, t]);
  // Each tile's page, carrying the scope the Home counted into every page that scopes by manager
  // (CS-702; lib/managerHome tileHref — the band, Schedule, Hours, Requests, Messages, Checklists,
  // Supplies): one picked manager, or a whole team — `team`, and whose when it is not the viewer's.
  const linkTo = (key) => tileHref(key, scope, currentUser);

  // ── today: the shift band, Schedule, Checklists (Builder A's engine, one shared read) ──
  // The account managers' section reads the same answers as the tiles, so it keeps the team-wide
  // reads on whenever it is on screen (the whole team in view).
  const showAms = !!scope.teamOf && !scope.mgrId && !empty;
  const today = useManagerToday({ mgrId: scope.mgrId, opsManagerId, enabled: showBand || show('schedule') || show('checklists') || showAms });
  const todayRead = todayState(today);
  const band = useMemo(() => (today.counts ? shiftBand(today.counts) : null), [today.counts]);
  const sched = useMemo(() => scheduleFigures(today.visits, today.asOf || Date.now()), [today.visits, today.asOf]);
  const ckl = useMemo(() => checklistsFigures(today.visits), [today.visits]);

  // ── Inspections: "N due · last 92% Sep 27" (+ the desktop's four-bar trend) ──
  const insp = tileState(useInspectionsRead(scope, show('inspections')), online);
  const inspFigures = useMemo(() => (insp.phase !== 'ok' ? null : {
    due: inspectionsDueCount({ clients: clients || [], latest: insp.data.latest, scope, now: Date.now(), settings: opsSettings || {} }),
    ...inspectionTrend(insp.data.history),
  }), [insp.phase, insp.data, clients, scope, opsSettings]);

  // ── Hours Approval: "N pending · due <day>" (+ "N flagged for overtime"), the page's own figures ──
  const hours = tileState(useHoursRead(scope, show('hours') || (showAms && holdsGate(check, 'hours'))), online);
  const hoursFig = useMemo(() => {
    if (hours.phase !== 'ok') return null;
    // `scope`: the Operations view reads the owner's (unscoped) answer, kept to the team here.
    const f = hoursFigures(hours.data, { user: currentUser, opsSettings, now: new Date(), tz: tz || undefined, scope });
    return { ...f, dueIso: startOfDayKey(f.dueKey, tz || undefined).toISOString() };
  }, [hours.phase, hours.data, currentUser, opsSettings, tz, scope]);

  // ── Client Requests: "N open · M urgent · K overdue", the page's own queue and counts ──
  const reqs = tileState(useRequestsRead(scope, show('requests') || (showAms && holdsGate(check, 'requests'))), online);
  const reqFigures = useMemo(
    () => (reqs.phase === 'ok' ? requestFigures(reqs.data, { scope, clients: clients || [], settings: opsSettings || {} }) : null),
    [reqs.phase, reqs.data, scope, clients, opsSettings],
  );

  // ── Customer messages: "N messages waiting · longest T", the waiting threads (their own figure) ──
  const msgs = tileState(useMessagesRead(scope, show('messages')), online);
  const msgFigures = useMemo(() => (msgs.phase === 'ok' ? messageFigures(msgs.data, { scope }) : null), [msgs.phase, msgs.data, scope]);
  const longestText = (mins) => {
    if (mins == null || mins < 1) return null;
    return mins < MINUTES_PER_DAY
      ? t('mgrHome.msg.longest', { time: mins })
      : t('mgrHome.msg.longestDays', { count: Math.floor(mins / MINUTES_PER_DAY) });
  };

  // ── Supplies: "N properties need attention · M orders placed", Supplies → By building's counts ──
  const sup = tileState(useSuppliesRead(scope, show('supplies') || (showAms && holdsGate(check, 'supplies'))), online);
  // `scope`: a team is counted from the complete By building rows (the read is every building).
  const supFigures = useMemo(() => (sup.phase === 'ok' ? suppliesFigures(sup.data, scope) : null), [sup.phase, sup.data, scope]);

  // ── "Your account managers": each AM's day, partitioned out of the reads above (no read per AM) ──
  const amSignals = useMemo(() => (!showAms ? [] : accountManagerSignals({
    ams: teamAms, clients: clients || [], visits: today.visits || null,
    problems: reqs.phase === 'ok' ? reqs.data.problems : null,
    approvals: hours.phase === 'ok' ? hours.data : null,
    supplies: sup.phase === 'ok' ? sup.data : null,
    settings: opsSettings || {}, user: currentUser,
  })), [showAms, teamAms, clients, today.visits, reqs.phase, reqs.data, hours.phase, hours.data, sup.phase, sup.data, opsSettings, currentUser]);

  const STATIC = { phase: 'ok', data: null, retry: () => {} };
  // On a phone the board draws two tiles a row (Schedule, Inspections, Hours Approval, Client
  // Requests) and the rest as full-width rows; an odd one out of the two-up tiles becomes a row
  // too, so no tile stands alone at half width.
  const halves = ['schedule', 'inspections', 'hours', 'requests'].filter(show);
  const wide = (k) => !halves.includes(k) || (halves.length % 2 === 1 && halves[halves.length - 1] === k);
  const fab = !empty && check('qc.inspect');

  return (
    <div className={`page mgrh${fab ? ' has-fab' : ''}`}>
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-head-title">{greeting}</h1>
          <p className="page-sub">{subtitle}</p>
        </div>
      </div>

      {scope.pickerKind === 'managers' && (
        <div className="filter-bar mgrh-filters">
          <FormField label={t('mgrHome.manager')}>
            <FilterSelect ariaLabel={t('mgrHome.manager')} value={scope.mgrId || ''} onChange={setManager} options={managerOptions} />
          </FormField>
        </div>
      )}
      {(scope.pickerKind === 'team' || opsView) && (
        <div className="filter-bar mgrh-filters">
          {opsView && opsOptions.length > 0 && (
            <FormField label={t('mgrTeam.opsPicker')}>
              <FilterSelect ariaLabel={t('mgrTeam.opsPicker')} value={opsManagerId || ''} onChange={setOpsManager} options={opsOptions} />
            </FormField>
          )}
          {scope.pickerKind === 'team' && (
            <FormField label={t('mgrTeam.picker')}>
              <FilterSelect ariaLabel={t('mgrTeam.picker')} value={scope.mgrId || ''} onChange={setManager} options={teamOptions} />
            </FormField>
          )}
        </div>
      )}

      {/* QR-21 (Matt, 2026-10-16: "Yes"): the office's Scan button, as the cleaner's and the customer's
          Homes have theirs — the camera, then the scanned area's page (UI_RULES §172, §175). */}
      <ScanButton />

      {opsView && !opsManagerId ? (
        <EmptyState icon={<Icon name="clients" size={22} />} title={t('mgrTeam.noOps.title')} message={t('mgrTeam.noOps.body')} />
      ) : empty ? (
        <EmptyState
          icon={<Icon name="building" size={22} />}
          title={t('mgrHome.noProps.title')}
          message={scope.picker ? t('mgrHome.noProps.named') : t('mgrHome.noProps.self')}
        />
      ) : (
        <>
          {showBand && <ShiftBand read={todayRead} band={band} asOf={today.asOf} to={linkTo('band')} />}

          <div className="mgrh-tiles">
            {show('schedule') && (
              <HomeTile icon="schedule" tone="blue" title={t('mgrHome.sched.title')} read={todayRead} wide={wide('schedule')}
                to={linkTo('schedule')} cta={t('mgrHome.sched.cta')}>
                {sched && (
                  <>
                    <Facts parts={[t('mgrHome.sched.visits', { count: sched.total }), t('mgrHome.sched.properties', { count: sched.properties })]} />
                    {sched.next.length > 0 && (
                      <span className="mgrh-extra mgrh-next text-xs">
                        {sched.next.map((v) => (
                          <span key={v.jobId} className="mgrh-next-row">{t('mgrHome.sched.next', { time: v.startAt, customer: v.customerLabel || t('mgrToday.noCustomer') })}</span>
                        ))}
                      </span>
                    )}
                  </>
                )}
              </HomeTile>
            )}

            {show('inspections') && (
              <HomeTile
                icon="shield" tone="green" title={t('mgrHome.insp.title')} read={insp} wide={wide('inspections')}
                to={linkTo(check('qc.inspect') ? 'inspect' : 'inspections')}
                cta={check('qc.inspect') ? t('mgrHome.insp.start') : t('mgrHome.insp.view')}
              >
                {inspFigures && (
                  <>
                    <Facts parts={[
                      t('mgrHome.insp.due', { count: inspFigures.due }),
                      inspFigures.last ? t('mgrHome.insp.last', { score: inspFigures.last.score, date: inspFigures.last.at }) : t('mgrHome.insp.none'),
                    ]} />
                    {inspFigures.trend.length > 1 && (
                      <span className="mgrh-trend" role="img" aria-label={t('mgrHome.insp.trendAria', { count: inspFigures.trend.length, scores: inspFigures.trend.map((s) => `${s}%`) })}>
                        <span className="mgrh-trend-bars" aria-hidden>
                          {inspFigures.trend.map((s, n) => (
                            <span key={n} className={`mgrh-trend-bar${n === inspFigures.trend.length - 1 ? ' is-last' : ''}`} style={{ height: `${Math.max(12, Math.min(100, s))}%` }} />
                          ))}
                        </span>
                        <span className="mgrh-trend-label text-xs">{t('mgrHome.insp.trend', { count: inspFigures.trend.length })}</span>
                      </span>
                    )}
                  </>
                )}
              </HomeTile>
            )}

            {show('hours') && (
              <HomeTile icon="clock" tone="purple" title={t('mgrHome.hours.title')} read={hours} wide={wide('hours')}
                to={linkTo('hours')} cta={t('mgrHome.hours.cta')}>
                {hoursFig && (
                  <>
                    <Facts parts={[
                      t('mgrHome.hours.pending', { count: hoursFig.pending }),
                      t('mgrHome.hours.due', { date: hoursFig.dueIso }),
                    ]} />
                    {hoursFig.overtime > 0 && (
                      <span className="mgrh-extra text-xs">{t('mgrHome.hours.ot', { count: hoursFig.overtime })}</span>
                    )}
                  </>
                )}
              </HomeTile>
            )}

            {show('requests') && (
              <HomeTile icon="forms" tone="amber" title={t('mgrHome.req.title')} read={reqs} wide={wide('requests')}
                to={linkTo('requests')} cta={t('mgrHome.req.cta')}>
                {reqFigures && (
                  <Facts parts={[
                    t('mgrHome.req.open', { count: reqFigures.open }),
                    t('mgrHome.req.urgent', { count: reqFigures.urgent }),
                    reqFigures.overdue > 0 ? t('mgrHome.req.overdue', { count: reqFigures.overdue }) : null,
                  ]} />
                )}
              </HomeTile>
            )}

            {show('messages') && (
              <HomeTile icon="messaging" tone="purple" title={t('mgrHome.msg.title')} read={msgs} wide={wide('messages')}
                to={linkTo('messages')} cta={t('mgrHome.msg.cta')}>
                {msgFigures && (
                  <Facts parts={[
                    t('mgrHome.msg.waiting', { count: msgFigures.waiting }),
                    msgFigures.waiting > 0 ? longestText(msgFigures.longestMins) : null,
                  ]} />
                )}
              </HomeTile>
            )}

            {show('checklists') && (
              <HomeTile icon="check" tone="green" title={t('mgrHome.ckl.title')} read={todayRead} wide={wide('checklists')}
                to={linkTo('checklists')} cta={t('mgrHome.ckl.cta')}>
                {ckl && (ckl.owed
                  ? <Facts parts={[t('mgrHome.ckl.complete', { done: ckl.complete, count: ckl.owed }), t('mgrHome.ckl.inProgress', { count: ckl.inProgress })]} />
                  : <span>{t('mgrHome.ckl.none')}</span>)}
              </HomeTile>
            )}

            {show('supplies') && (
              <HomeTile icon="box" tone="blue" title={t('mgrHome.sup.title')} read={sup} wide={wide('supplies')}
                to={linkTo('supplies')} cta={t('mgrHome.sup.cta')}>
                {supFigures && (
                  <Facts parts={[t('mgrHome.sup.attention', { count: supFigures.attention }), t('mgrHome.sup.placed', { count: supFigures.placed })]} />
                )}
              </HomeTile>
            )}

            {show('pnl') && (
              <HomeTile icon="dollarCircle" tone="slate" title={t('mgrHome.pnl.title')} read={STATIC} wide={wide('pnl')}
                to={linkTo('pnl')} cta={t('mgrHome.pnl.cta')}>
                <span>{t('mgrHome.pnl.body')}</span>
              </HomeTile>
            )}
          </div>

          {showAms && (
            <AccountManagersSection
              ams={teamAms} signals={amSignals} ownTeam={ownTeam} lead={teamLead} onPick={(id) => setManager(id)}
            />
          )}
        </>
      )}

      {/* The phone's "+" (mobile-01): a new inspection, for whoever may make one. Phones only, clear
          of the bottom bar and its menu button (CSS); the desktop starts one from the tile. */}
      {fab && <NewInspectionFab />}
    </div>
  );
}

// "Your account managers" (S131, plan 2026-10-14 §0; UI_RULES §169): an Operations Manager's team,
// one card per account manager — their buildings and today's signals, each figure partitioned out
// of the team-wide reads above (lib/managerHome accountManagerSignals: no read per AM). A figure
// not read yet (or unreadable) says nothing. A tap narrows this Home to that account manager.
function AccountManagersSection({ ams, signals, ownTeam, lead, onPick }) {
  const t = useT();
  const byId = new Map((signals || []).map((x) => [x.id, x]));
  const first = (lead?.name || '').split(' ')[0] || lead?.name || '';
  return (
    <section className="mgrteam-ams" aria-label={ownTeam ? t('mgrTeam.ams.title') : t('mgrTeam.ams.titleNamed', { name: first })}>
      <div className="mgrteam-ams-head">
        <h2 className="mgrteam-ams-title">{ownTeam ? t('mgrTeam.ams.title') : t('mgrTeam.ams.titleNamed', { name: first })}</h2>
        {ams.length > 0 && <p className="text-sm text-muted">{t('mgrTeam.ams.hint')}</p>}
      </div>
      {ams.length === 0 ? (
        <EmptyState icon={<Icon name="clients" size={22} />} title={t('mgrTeam.ams.none')} message={t('mgrTeam.ams.noneHint')} />
      ) : (
        <div className="mgrteam-ams-grid">
          {ams.map((am) => {
            const sig = byId.get(am.id) || {};
            const parts = [
              sig.notIn > 0 ? t('mgrTeam.ams.notIn', { count: sig.notIn }) : null,
              sig.open > 0 ? t('mgrTeam.ams.requests', { count: sig.open }) : null,
              sig.overdue > 0 ? t('mgrTeam.ams.overdue', { count: sig.overdue }) : null,
              sig.hours > 0 ? t('mgrTeam.ams.hours', { count: sig.hours }) : null,
              sig.supplyApprovals > 0 ? t('mgrTeam.ams.supplies', { count: sig.supplyApprovals }) : null,
            ];
            const known = [sig.notIn, sig.open, sig.hours, sig.supplyApprovals].some((v) => v != null);
            const attention = (sig.notIn || 0) + (sig.overdue || 0) > 0;
            return (
              <button
                key={am.id}
                type="button"
                className={`card mgrteam-am${attention ? ' is-attention' : ''}`}
                onClick={() => onPick(am.id)}
                aria-label={t('mgrTeam.ams.open', { name: am.name })}
              >
                <Avatar user={am} size="md" />
                <span className="mgrteam-am-text">
                  <span className="mgrteam-am-name">{am.name}</span>
                  <span className="mgrteam-am-sub text-xs text-muted">{t('mgrTeam.card.buildings', { count: sig.buildings || 0 })}</span>
                  <span className="mgrteam-am-signals text-sm">
                    {parts.some(Boolean) ? <Facts parts={parts} /> : (known ? <span className="text-muted">{t('mgrTeam.ams.allClear')}</span> : <span className="text-muted">{t('common.loading')}</span>)}
                  </span>
                </span>
                <span className="mgrh-cta-chev" aria-hidden><Icon name="chevronRight" size={20} /></span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

// The dashed "Scan a site QR code" (QR-21): the kit's one dashed slot (UI_RULES §125), the way the
// cleaner's and the customer's Homes draw theirs. The office's scanner lands each code by the ONE rule
// (lib/scanLanding staffScanDestination).
function ScanButton() {
  const t = useT();
  const nav = useFromHere();
  return (
    <Link className="add-tile mgrh-scan" to={OFFICE_SCAN_PATH} state={nav}>
      <Icon name="camera" size={18} />
      <span>{t('officeScan.button')}</span>
    </Link>
  );
}

function NewInspectionFab() {
  const t = useT();
  const nav = useFromHere();
  return (
    <Link className="mgrh-fab" to={tileHref('inspect')} state={nav} aria-label={t('mgrHome.fab')} title={t('mgrHome.fab')}>
      <Icon name="plus" size={26} />
    </Link>
  );
}
