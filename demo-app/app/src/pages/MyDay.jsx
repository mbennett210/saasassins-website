// The cleaner's HOME (`/my-day`) — the Cleaner Hub's Main board (Matt, 2026-10-13; plan
// docs/plans/2026-10-13-cleaner-hub.md, brief A §2, UI_RULES §165). A phone app: no tab bar (D6),
// so this page is the hub — the header carries Messages, the bell and the account menu, and every
// other screen is one tap from here and has its own way back.
//
//   header      the brand mark + the product's name (src/brand), Messages with its unread count,
//               the bell, the account menu
//   greeting    "Hey, {first name}" + "{n} stops today / tonight" (the ORG's 5 PM, lib/crewHome)
//   the hero    ONE clear action (Matt: "Clock In / Clock Out first and biggest"), by the pure rule
//               lib/crewHome currentStop: an open punch anywhere → Clock out (locked by the checklist
//               when it is unfinished, and then the card opens the checklist); else the first clean
//               whose clock-in window is open → Clock in; else the next → "Opens at …"; all done;
//               or no stops today
//   the stops   Today's Stops, in the order a cleaner works them → My Stops Today
//   the AM      Message / Call the account manager of the hero clean's customer
//   the scan    → the QR scanner (Builder D's screen)
//   the tiles   My Checklist · My Hours · Request Supplies (supplies.request only; its line names the
//               cleaner's newest supply order, "#SO-1047 · Partially fulfilled") · Client Requests
//
// Nothing that used to be on My Day is lost: the offline-punch banners, the HR warning card, the
// stranded-punch recovery, the booked-off notice (CS-693) and the "still listed" note when the
// clock status could not be read all render here; a clean's instructions, photos and access notes
// are its own page (/schedule/:jobId, "Details" on My Stops Today) and the clock is its screen.
//
// The owner's View-as a cleaner is a PREVIEW (D8): the punches read are the viewed cleaner's
// (through the office's time read, time.view), and every control that writes is off.
//
// ── §8 0.4: this page subscribes per-value, not to the whole snapshot ──────────────────────────
// It is the CREW HOME SCREEN and the jobs realtime stream dispatches constantly. Each selector is
// wrapped in useCallback (a stable identity for useSelector's cache) and given the comparer its
// RETURN value needs: an existing element or a number → Object.is; a .filter()/.sort() or a built
// object → shallowEqual (verified per selector by scripts/test-selector-benefit.mjs).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '../components/Icon';
import Avatar from '../components/Avatar';
import PopMenu from '../components/PopMenu';
import UserSwitcher from '../components/UserSwitcher';
import NotificationsBell from '../components/NotificationsBell';
import StubRecoveryBanner from '../components/StubRecoveryBanner';
import MyWarningsCard from '../components/MyWarningsCard';
import { useFromHere } from '../hooks/useFromHere';
import { useAuth } from '../hooks/useAuth';
import { usePermission } from '../hooks/usePermission';
import { useCrewPreview } from '../hooks/useCrewPreview';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useClockOutGate } from '../hooks/useCleanChecklist';
import { useGeoPresence } from '../hooks/useGeoPresence';
import { useCrewPunches, useNowTick, useCrewDay, UPCOMING_DAYS } from '../hooks/useCrewDay';
import { useMyHoursSummary } from '../hooks/useMyHours';
import { useMyRequestsCount } from '../hooks/useMyRequests';
import { useMyLastSupplyOrder } from '../hooks/useMySupplyOrders';
import { readChecklistDraft } from '../lib/checklistDraft';
import { supplyOrderLabelKey } from '../lib/supplies';
import { useSelector, useDispatch, useGetState } from '../store';
import { ACTIONS } from '../store/reducer';
import {
  selectSiteById, selectClientById, selectJobById,
  selectCompany, selectUsers, selectUnreadCountForInbox, selectDmConversationBetween,
} from '../store/selectors';
import { timeOffEntryFor } from '../store/timeOffRules';
import { crewPaths } from '../lib/crewPaths';
import { checklistFor, GATE } from '../lib/crewChecklist';
import {
  currentStop, stopRows, openPunch, isTonight, accountManager, siteLine, checklistProgress,
  HERO, STOP, SITE_LINE, SITE_LINE_KEYS, SITE_LINE_TONE, AM_REASON,
} from '../lib/crewHome';
import { fmtTimeRange, fmtDate, fmtDuration, fmtTime, getOrgTimezone } from '../lib/dates';
import { newId } from '../lib/ids';
import { IDENTITY } from '../brand/identity.generated.js';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';

// The customer of a clean (one location per customer since S23: the customer name is the place).
const clientOfJob = (s, job) => (job
  ? (job.clientId ? selectClientById(s, job.clientId) : (job.siteId ? selectClientById(s, selectSiteById(s, job.siteId)?.clientId) : null))
  : null);
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

// ── the header ───────────────────────────────────────────────────────────────────────────────
function HomeHeader({ userId }) {
  const t = useT();
  const navigate = useNavigate();
  const nav = useFromHere();
  const company = useSelector(selectCompany);
  const canViewExternalInbox = usePermission('messaging.startConversation');
  const currentUser = useSelector(useCallback((s) => (s.users || []).find((u) => u.id === userId) || null, [userId]));
  // The inboxes this person has (Messaging's own rule: crew see Channels and DMs).
  const unread = useSelector(useCallback((s) => (
    selectUnreadCountForInbox(s, 'internal', currentUser) + selectUnreadCountForInbox(s, 'dm', currentUser)
    + (canViewExternalInbox ? selectUnreadCountForInbox(s, 'inbox', currentUser) : 0)
  ), [currentUser, canViewExternalInbox]));
  return (
    <header className="crew-home-head">
      <div className="crew-home-brand">
        <span className="crew-home-mark" aria-hidden="true">
          {company?.logoMark ? <img src={company.logoMark} alt="" /> : IDENTITY.monogram}
        </span>
        <span className="crew-home-name">{IDENTITY.product.name}</span>
      </div>
      <div className="crew-home-actions">
        <button
          type="button"
          className="btn-icon crew-home-iconbtn"
          onClick={() => navigate('/messaging', { state: nav })}
          aria-label={unread > 0 ? t('crewHome.messagesUnread', { count: unread }) : t('crewHome.messages')}
        >
          <Icon name="messaging" size={20} />
          {unread > 0 && <span className="crew-home-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
        </button>
        <NotificationsBell className="crew-home-bell" />
        <AccountMenu user={currentUser} />
      </div>
    </header>
  );
}

// The account menu (the avatar): the cleaner's own pages, Report an issue, Sign out. The sidebar's
// user switcher is not drawn in the crew shell, so the login-free demo's sandbox switch rides here
// too (local mode only); the owner's preview has its own way back on the shell's preview line.
function AccountMenu({ user }) {
  const t = useT();
  const navigate = useNavigate();
  const nav = useFromHere();
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const { signOut, authConfigured } = useAuth();
  const canKeys = usePermission('keys.view');
  const canDeliver = usePermission('supplies.deliver');
  const go = (to) => { setOpen(false); navigate(to, { state: nav }); };
  return (
    <div className="crew-home-account" ref={ref}>
      <button
        type="button"
        className="crew-home-avatar"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('crewHome.menu.open')}
      >
        <Avatar user={user} size="sm" />
      </button>
      <PopMenu open={open} onClose={() => setOpen(false)} anchorRef={ref} className="user-menu crew-home-menu" role="menu" sheetTitle={t('userMenu.account')}>
        {user && (
          <div className="user-menu-header">
            <span className="user-menu-item-name">{user.name}</span>
          </div>
        )}
        <button type="button" className="menu-option" role="menuitem" onClick={() => go('/settings/account')}>
          <Icon name="user" size={16} /> <span className="user-menu-item-name">{t('crewHome.menu.account')}</span>
        </button>
        {canKeys && (
          <button type="button" className="menu-option" role="menuitem" onClick={() => go('/keys')}>
            <Icon name="lock" size={16} /> <span className="user-menu-item-name">{t('crewHome.menu.keys')}</span>
          </button>
        )}
        {canDeliver && (
          <button type="button" className="menu-option" role="menuitem" onClick={() => go('/deliveries')}>
            <Icon name="mapPin" size={16} /> <span className="user-menu-item-name">{t('nav.deliveries')}</span>
          </button>
        )}
        <button
          type="button"
          className="menu-option"
          role="menuitem"
          style={{ display: 'none' }} // polishpoint-demo: no Report an issue
          onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('cs:open-report')); }}
        >
          <Icon name="warning" size={16} /> <span className="user-menu-item-name">{t('nav.reportIssue')}</span>
        </button>
        {!authConfigured && (
          <>
            <div className="user-menu-divider" role="separator" />
            <div className="crew-home-switcher"><UserSwitcher /></div>
          </>
        )}
        {authConfigured && (
          <>
            <div className="user-menu-divider" role="separator" />
            <button
              type="button"
              className="menu-option user-menu-signout"
              role="menuitem"
              disabled={signingOut}
              onClick={async () => {
                if (signingOut) return;
                setSigningOut(true);
                try { await signOut(); } finally { setSigningOut(false); setOpen(false); }
              }}
            >
              <Icon name="logout" size={16} />
              <span className="user-menu-item-name">{signingOut ? t('userMenu.signingOut') : t('userMenu.signOut')}</span>
            </button>
          </>
        )}
      </PopMenu>
    </div>
  );
}

// ── the hero: ONE clear action ───────────────────────────────────────────────────────────────
// The hero's chip: the server's verdict once punched, else the phone's live read. Nothing for a
// location with no ring.
function HeroChip({ job, entry }) {
  const t = useT();
  const presence = useGeoPresence(entry ? null : job);
  const line = siteLine({ entry, presence: entry ? null : presence });
  if (!line || line === SITE_LINE.UNKNOWN) return null;
  const key = line === SITE_LINE.INSIDE || line === SITE_LINE.ON_SITE ? 'myDay.chip.onSite'
    : line === SITE_LINE.OUTSIDE_HELD ? 'crewHome.chip.notOnSite' : SITE_LINE_KEYS[line];
  return (
    <span className={`crew-home-hero-chip ${SITE_LINE_TONE[line] || ''}`}>
      <Icon name="mapPin" size={14} /> {t(key)}
    </span>
  );
}

// `progress` = lib/crewHome checklistProgress: the stored submission, else the unsaved draft on the
// phone. A FINISHED draft unlocks the card — the Clock out screen saves it as it clocks out.
function HeroCard({ hero, gate, progress, place, now, onOpen }) {
  const t = useT();
  if (hero.kind === HERO.CLOCK_OUT) {
    const ready = !!progress?.ready;
    const locked = !ready && !!gate && (gate.state === GATE.BLOCKED || gate.state === GATE.UNKNOWN);
    const left = progress && progress.total > 0 ? Math.max(0, progress.total - progress.done) : 0;
    const mins = Math.max(0, Math.round((now - Date.parse(hero.entry.clock_in_at)) / 60000));
    return (
      <button type="button" className="crew-home-hero is-out" onClick={() => onOpen(locked ? 'checklist' : 'clock')}>
        <span className="crew-home-hero-top">
          <span className="crew-home-hero-place">{place}</span>
          <HeroChip job={hero.job} entry={hero.entry} />
        </span>
        <span className="crew-home-hero-main">
          <span className="crew-home-hero-icon" aria-hidden="true"><Icon name={locked ? 'lock' : 'clock'} size={24} /></span>
          <span className="crew-home-hero-text">
            <span className="crew-home-hero-title">{t('clock.out')}</span>
            {locked && (
              <span className="crew-home-hero-sub">
                {left > 0 ? t('crewHome.hero.finishTasks', { count: left }) : t('crewHome.hero.finishChecklist')}
              </span>
            )}
            {ready && <span className="crew-home-hero-sub">{t('crewHome.hero.readyToSave')}</span>}
          </span>
          <Icon name="chevronRight" size={22} />
        </span>
        <span className="crew-home-hero-foot">
          {t('crewHome.hero.clockedInFor', { time: fmtTime(hero.entry.clock_in_at), duration: fmtDuration(mins) })}
        </span>
      </button>
    );
  }
  if (hero.kind === HERO.CLOCK_IN || hero.kind === HERO.NOT_YET) {
    const notYet = hero.kind === HERO.NOT_YET;
    return (
      <button type="button" className={`crew-home-hero is-in${notYet ? ' is-waiting' : ''}`} onClick={() => onOpen('clock')}>
        <span className="crew-home-hero-top">
          <span className="crew-home-hero-place">{place}</span>
          {!notYet && <HeroChip job={hero.job} entry={null} />}
        </span>
        <span className="crew-home-hero-main">
          <span className="crew-home-hero-icon" aria-hidden="true"><Icon name="clock" size={24} /></span>
          <span className="crew-home-hero-text">
            <span className="crew-home-hero-title">{t('clock.in')}</span>
            <span className="crew-home-hero-sub">
              {notYet && hero.opensAt ? t('crewHome.hero.opensAt', { time: fmtTime(new Date(hero.opensAt).toISOString()) }) : fmtTimeRange(hero.job.startAt, hero.job.endAt)}
            </span>
          </span>
          <Icon name="chevronRight" size={22} />
        </span>
      </button>
    );
  }
  if (hero.kind === HERO.ALL_DONE) {
    return (
      <div className="crew-home-hero is-rest" role="status">
        <span className="crew-home-hero-main">
          <span className="crew-home-hero-icon" aria-hidden="true"><Icon name="check" size={24} /></span>
          <span className="crew-home-hero-text">
            <span className="crew-home-hero-title">{t('crewHome.hero.allDone')}</span>
            <span className="crew-home-hero-sub">
              {hero.done === hero.total ? t('crewHome.hero.allDoneCount', { count: hero.total }) : t('crewHome.hero.someDone', { done: hero.done, total: hero.total })}
            </span>
          </span>
        </span>
      </div>
    );
  }
  return (
    <div className="crew-home-hero is-rest" role="status">
      <span className="crew-home-hero-main">
        <span className="crew-home-hero-icon" aria-hidden="true"><Icon name="schedule" size={24} /></span>
        <span className="crew-home-hero-text">
          <span className="crew-home-hero-title">{t('crewHome.hero.none')}</span>
          <span className="crew-home-hero-sub">
            {hero.next
              ? t('crewHome.hero.next', { place: place || t('myDay.cleanFallback'), day: fmtDate(hero.next.startAt, { weekday: 'short', month: 'short', day: 'numeric' }), time: fmtTime(hero.next.startAt) })
              : t('myDay.noUpcoming', { days: UPCOMING_DAYS })}
          </span>
        </span>
      </span>
    </div>
  );
}

// One row of the Today's Stops card: a dot, the place, and its state or start time.
function StopLine({ row }) {
  const t = useT();
  const name = useSelector(useCallback((s) => {
    const c = clientOfJob(s, row.job);
    return c?.name || (row.job?.siteId ? selectSiteById(s, row.job.siteId)?.name : null) || row.entry?.client_name || row.entry?.site_name || null;
  }, [row.job, row.entry]));
  const right = row.state === STOP.NOW ? t('crewStops.state.inProgress')
    : row.state === STOP.DONE ? t('myDay.chip.done')
      : row.state === STOP.MISSED ? t('myDay.chip.missed')
        : (row.job?.startAt ? fmtTime(row.job.startAt) : '');
  return (
    <li className={`crew-home-stop is-${row.state}`}>
      <span className="crew-home-stop-dot" aria-hidden="true" />
      <span className="crew-home-stop-name">{name || t('myDay.cleanFallback')}</span>
      <span className="crew-home-stop-state">{right}</span>
    </li>
  );
}

// "Message AM" / "Call AM". The AM is the hero clean's customer's supervisor; a button that cannot
// work is off and says why underneath (UI_RULES §118). Off while previewing (D8): a DM would be
// created as the owner.
function AmButtons({ client, previewing, userId }) {
  const t = useT();
  const navigate = useNavigate();
  const nav = useFromHere();
  const dispatch = useDispatch();
  const getState = useGetState();
  const users = useSelector(selectUsers);
  const am = useMemo(() => accountManager(client, users), [client, users]);
  // Find the existing DM with the account manager or start one — exactly as NewDmModal does (the
  // reducer dedupes the pair too; crew may create a DM they are in, api/_lib/crewMerge.js).
  const openDm = () => {
    if (previewing || !am.user || !userId) return;
    const existing = selectDmConversationBetween(getState(), userId, am.user.id);
    if (existing) { navigate(`/messaging/${existing.id}?inbox=dm`, { state: nav }); return; }
    const id = newId('cv');
    dispatch({ type: ACTIONS.ADD_DM_CONVERSATION, id, participantUserIds: [userId, am.user.id] });
    navigate(`/messaging/${id}?inbox=dm`, { state: nav });
  };
  const why = am.reason === AM_REASON.NO_STOP ? t('crewHome.am.noStop')
    : am.reason === AM_REASON.NO_MANAGER ? t('crewHome.am.noManager', { place: client?.name || t('myDay.thisLocation') })
      : am.reason === AM_REASON.NO_PHONE ? t('crewHome.am.noPhone', { name: am.user?.name || '' })
        : null;
  return (
    <div className="crew-home-am">
      <div className="crew-home-am-row">
        <button type="button" className="btn btn-outline crew-shell-tap" disabled={previewing || !am.user} onClick={openDm}>
          <Icon name="messaging" size={18} /> {t('crewHome.am.message')}
        </button>
        {am.phone && !previewing ? (
          <a className="btn btn-outline crew-shell-tap" href={`tel:${am.phone.replace(/[^\d+]/g, '')}`}>
            <Icon name="phone" size={18} /> {t('crewHome.am.call')}
          </a>
        ) : (
          <button type="button" className="btn btn-outline crew-shell-tap" disabled>
            <Icon name="phone" size={18} /> {t('crewHome.am.call')}
          </button>
        )}
      </div>
      {why && <p className="crew-home-am-why text-xs">{why}</p>}
    </div>
  );
}

// One tile of the 2 × 2 grid. `strong` sets the line apart when it is news (a supply order's status).
function Tile({ icon, tone, title, sub, strong = false, action, onOpen }) {
  return (
    <button type="button" className="crew-home-tile" onClick={onOpen}>
      <span className={`crew-home-tile-icon ${tone}`} aria-hidden="true"><Icon name={icon} size={20} /></span>
      <span className="crew-home-tile-title">{title}</span>
      <span className={`crew-home-tile-sub${strong ? ' is-strong' : ''}`}>{sub}</span>
      <span className="crew-home-tile-go">{action} →</span>
    </button>
  );
}

export default function MyDay() {
  const t = useT();
  const navigate = useNavigate();
  const nav = useFromHere();
  const { currentUser } = useAuth();
  const userId = currentUser?.id;
  const { previewing } = useCrewPreview();
  const online = useOnlineStatus();
  const canRequestSupplies = usePermission('supplies.request');
  const now = useNowTick();
  const { entries, error, pending, load } = useCrewPunches(userId);
  const { cleans, upcoming } = useCrewDay(userId, now);
  const graceMins = useSelector(useCallback((s) => s.opsSettings?.autoCloseGraceMins, []));

  // 🔴 Booked off today (CS-693): a call-out or time off on the ORG's today. Their cleans stay on the
  // list (the office may not have reassigned them) — but it says so, and each Clock in asks first.
  const offToday = useSelector(useCallback(
    (s) => (userId ? timeOffEntryFor(s.timeOff, userId, new Date(now).toISOString()) : null),
    [userId, now],
  ));

  // An open punch whose clean is not on today's list (last night's) is looked up by id.
  const openJobId = openPunch(entries || [])?.job_id || null;
  const openJob = useSelector(useCallback((s) => (openJobId ? selectJobById(s, openJobId) : null), [openJobId]));
  const findJob = useCallback((id) => (id && id === openJobId ? openJob : null), [openJobId, openJob]);

  const hero = useMemo(
    () => currentStop({ cleans, entries: entries || [], now, graceMins, upcoming, findJob }),
    [cleans, entries, now, graceMins, upcoming, findJob],
  );
  const rows = useMemo(
    () => stopRows({ cleans, entries: entries || [], now, graceMins, findJob }),
    [cleans, entries, now, graceMins, findJob],
  );

  // The hero clean (or the next one) — its customer names the place, owns the AM and the checklist.
  const heroJob = hero.job || hero.next || null;
  const heroClient = useSelector(useCallback((s) => clientOfJob(s, heroJob), [heroJob]));
  const place = heroClient?.name || hero.entry?.client_name || hero.entry?.site_name || null;

  // ONE read of the hero clean's checklist, for the hero's lock and the My Checklist tile: the shared
  // clock-out gate (hooks/useCleanChecklist), judged for THIS cleaner — on their open punch, or (not
  // clocked in yet) as it would be.
  const gateJob = hero.kind === HERO.CLOCK_OUT || hero.kind === HERO.CLOCK_IN || hero.kind === HERO.NOT_YET ? hero.job : null;
  const gateEntry = useMemo(() => (gateJob ? (hero.entry || { user_id: userId }) : null), [gateJob, hero.entry, userId]);
  const { gate } = useClockOutGate({ job: gateJob, entry: gateEntry, online });
  const heroChecklist = gateJob && heroClient ? checklistFor({ client: heroClient, job: gateJob, userId }) : null;
  // The work kept on the phone and not saved yet (the checklist page's draft, lib/checklistDraft) —
  // read again whenever Home comes back into view, since the checklist page writes it.
  const [draftTick, setDraftTick] = useState(0);
  useEffect(() => {
    const again = () => setDraftTick((n) => n + 1);
    const onVisible = () => { if (document.visibilityState === 'visible') again(); };
    window.addEventListener('focus', again);
    window.addEventListener('storage', again);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', again);
      window.removeEventListener('storage', again);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  const draftUserId = hero.entry?.user_id || userId;
  const draft = useMemo(
    () => (gateJob?.id && heroChecklist ? readChecklistDraft({ jobId: gateJob.id, templateId: heroChecklist, userId: draftUserId }) : null),
    [gateJob?.id, heroChecklist, draftUserId, draftTick], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const progress = heroChecklist ? checklistProgress({ gate, draft }) : null;
  // The live tiles (Builder C's shared reads; under View-as they read the viewed cleaner): each keeps
  // its quiet line until its answer is known, so no tile shows a number it does not have.
  const hours = useMyHoursSummary();
  const requests = useMyRequestsCount();
  // S131 Builder C (Matt's board: "#SO-1047 partial"): the cleaner's newest supply order, from ONE light
  // shared read (hooks/useMySupplyOrders, EP-401); "Order supplies" with none, before it is known, or
  // when the read failed.
  const lastOrder = useMyLastSupplyOrder({ enabled: canRequestSupplies });

  const tonight = isTonight(now, getOrgTimezone());
  const count = cleans.filter((j) => j.status !== 'cancelled').length;

  const openHero = (target) => {
    const id = hero.jobId;
    if (!id) return;
    navigate(target === 'checklist' ? crewPaths.checklist(id) : crewPaths.clock(id), { state: nav });
  };

  return (
    <div className="crew-home">
      <HomeHeader userId={userId} />

      <div className="crew-home-greet">
        <h1 className="crew-home-hello">{t('crewHome.greeting', { name: firstName(currentUser?.name) })}</h1>
        <p className="crew-home-count">
          {tonight ? t('crewHome.stopsTonight', { count }) : t('crewHome.stopsToday', { count })}
        </p>
      </div>

      {!online && (
        <div className="callout callout-warning crew-home-note" role="status">{t('crewHome.offline')}</div>
      )}

      {/* Demo-period history stranded on this phone (Sept 1 recovery) */}
      <StubRecoveryBanner />
      {/* An HR warning of theirs waiting for their signature. Own only — the server reads the person
          from the login. Renders nothing otherwise. */}
      <MyWarningsCard userId={userId} />
      {/* Buffered offline punches. FAILED (terminal) ones need a manager — kept on the device (never
          dropped) but they can't auto-replay. Unsynced ones just wait for a signal. Both self-hide. */}
      {pending.failed > 0 && (
        <div className="callout callout-warning crew-home-note" role="alert">
          {t('myDay.punchesFailed', { count: pending.failed })}
        </div>
      )}
      {pending.unsynced > 0 && (
        <div className="callout crew-home-note" role="status">
          <strong>{t('myDay.punchesWaiting', { count: pending.unsynced })}</strong>
          <div className="text-sm">{t('myDay.punchesWaitingNote')}</div>
        </div>
      )}
      {offToday && (
        <div className="callout callout-warning crew-home-note myday-timeoff" role="status">
          <strong>{t('myDay.timeOff.title')}</strong>
          {count > 0 && <div className="text-sm">{t('myDay.timeOff.body')}</div>}
        </div>
      )}
      {/* The clock status could not be read: NON-blocking. The cleans come from the local store and
          stay listed — a signal drop must never read as "no work today" (CREW_AUDIT #3). */}
      {error && (
        <div className="callout callout-warning crew-home-note crew-home-error" role="alert">
          <span className="text-sm">{errorText(t, error, 'myDay.error.clockStatus')} {t('myDay.error.stillListed')}</span>
          <button type="button" className="btn btn-outline crew-shell-tap" onClick={load}>{t('common.retry')}</button>
        </div>
      )}

      {entries === null && !error
        ? <div className="crew-home-hero is-rest" aria-busy="true"><span className="crew-home-hero-sub">{t('common.loading')}</span></div>
        : <HeroCard hero={hero} gate={hero.kind === HERO.CLOCK_OUT ? gate : null} progress={hero.kind === HERO.CLOCK_OUT ? progress : null} place={place} now={now} onOpen={openHero} />}

      {rows.length > 0 && (
        <section className="card crew-home-stops">
          <div className="crew-home-stops-head">
            <h2 className="crew-home-section-title">{t('crewHome.stops.title')}</h2>
            <button type="button" className="btn btn-link" onClick={() => navigate(crewPaths.stops(), { state: nav })}>
              {t('crewHome.stops.viewAll')} →
            </button>
          </div>
          <ul className="crew-home-stop-list">
            {rows.map((row) => <StopLine key={row.key} row={row} />)}
          </ul>
        </section>
      )}

      <AmButtons client={heroClient} previewing={previewing} userId={userId} />

      <button type="button" className="crew-home-scan crew-shell-tap" onClick={() => navigate(crewPaths.scan(), { state: nav })}>
        <Icon name="camera" size={20} /> {t('crewHome.scan')}
      </button>

      <div className="crew-home-tiles">
        <Tile
          icon="check" tone="is-gold"
          title={t('crewHome.tile.checklist')}
          sub={!heroChecklist ? t('crewHome.tile.noChecklist')
            : progress ? t('crewHome.tile.checklistProgress', { place: place || '', done: progress.done, total: progress.total })
              : t('crewHome.tile.checklistNotStarted', { place: place || '' })}
          action={heroChecklist ? t('crewHome.tile.continue') : t('crewHome.tile.view')}
          onOpen={() => (heroChecklist && hero.jobId ? navigate(crewPaths.checklist(hero.jobId), { state: nav }) : navigate(crewPaths.stops(), { state: nav }))}
        />
        <Tile
          icon="clock" tone="is-violet"
          title={t('crewHome.tile.hours')}
          sub={hours.label || t('crewHome.tile.hoursSub')}
          action={t('crewHome.tile.view')}
          onOpen={() => navigate(crewPaths.hours(), { state: nav })}
        />
        {canRequestSupplies && (
          <Tile
            icon="box" tone="is-teal"
            title={t('crewHome.tile.supplies')}
            sub={lastOrder
              ? t('crewHome.tile.suppliesOrder', { no: lastOrder.no, status: t(supplyOrderLabelKey(lastOrder, 'crew')) })
              : t('crewHome.tile.suppliesNone')}
            strong={!!lastOrder}
            action={t('crewHome.tile.request')}
            onOpen={() => navigate(crewPaths.supplies(heroClient?.id || null), { state: nav })}
          />
        )}
        <Tile
          icon="forms" tone="is-amber"
          title={t('crewHome.tile.requests')}
          sub={requests.count == null ? t('crewHome.tile.requestsSub')
            : requests.count > 0 ? t('crewRequests.count', { count: requests.count }) : t('crewHome.tile.requestsNone')}
          action={t('crewHome.tile.view')}
          onOpen={() => navigate(crewPaths.requests(), { state: nav })}
        />
      </div>
    </div>
  );
}
