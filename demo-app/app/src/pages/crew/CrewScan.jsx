// SCAN SITE QR CODE — the cleaner's camera (the Cleaner Hub, D5, 2026-10-13; Matt's QRScan board and
// his note: "The QR code posted on site is a shortcut straight into that site's checklist").
// `/my-day/scan` (crewPaths.scan()), reached from Home's dashed "Scan site QR code".
//
//   camera (components/QrScanner, one scanner) → the code's URL → its token (lib/areaScan
//   scanTokenFromText; anything else is "That isn't a site code") → WHERE it is (EP-386, GET
//   /api/scan-codes/resolve: any live code, for a cleaner too) → their clean there TODAY
//   (lib/scanCodes crewCleanAtLocation) and their checklist on it (lib/crewChecklist checklistFor,
//   covers included) → that checklist (crewPaths.checklist, with the scanned area so the page can
//   bring its section into view). No signal: says so, and points at Today's Stops.
//
// THE CLEANER'S SCAN WHERE THE CHECKLIST ISN'T THE ANSWER (QR Wave 2, 2026-10-17; UI_RULES §176 —
// Matt's QR-14: "sometimes we might send cleaners as a filler … they also have to be able to scan
// and do the checklist"; QR-12's note: "all I see is my checklist for that area (if there is any),
// or the last inspection done, or any open tickets"). The page asks the server what this cleaner
// finds there today (EP-420, lib/scanCodesApi crewAreaForScan) and lib/scanLanding
// crewAreaDestination decides:
//   · on a clean there with a checklist → the checklist (the phone adopts the clean the server
//     hands back, if it lacked it);
//   · on a clean there with none → the cleaner's view of the area: the building's last inspection
//     and its open tickets;
//   · not on one → "Filling in for someone?" with the scheduled cleaners who haven't clocked in, one
//     tap each (EP-419, fillInFromScan: the server makes the filler that person's cover on today's
//     clean, R8). The clean it answers with is adopted at once (the store's jobs loader,
//     adoptServerJobs, rescoping a crew login's projection: a building they never cleaned joins
//     it), then the covered cleaner's checklist opens ("Covering for …"), unlocked once they clock
//     in from their own clock (CS-690). Nobody left to cover, no clean today, today's done, or only
//     a series' template visit waiting: says which, with "Open this area's public page".
// A scan is not presence (QR-13, "GPS only"): nothing here writes a punch.
//
// "Last scan" (the board's bottom sheet): the last code that opened a checklist TODAY, kept on this
// phone (try/catch — a private window or a full disk only loses the shortcut) with Open Checklist.
// The owner's View-as scans as the office (the server sees the owner) and lands where the viewed
// cleaner would; the fill-in's taps are off in the preview (the server would record the owner).
//
// ONE PRINTED CODE, A VIEW PER PERSON (QR Wave 1, 2026-10-16, UI_RULES §172): a printed code opened
// by a signed-in staff member arrives as `?code=<token>` (the public page sends them here) and is
// resolved at once, exactly as a camera read, once. Both roads end at ONE rule
// (lib/scanLanding staffScanDestination): a cleaner at today's checklist there (not on today's
// clean there, the offer to fill in; with no checklist, the building's last inspection and open
// tickets — QR Wave 2, §176), an OFFICE login (the effective user's role) at the area's page (QR-17)
// and a Supply Manager at that building's supply orders (QR-19) — or, without the page's key, the
// public page (an office login's camera road is the office's own scanner now, /areas/scan). A code
// refused for this person says so with "Open this area's public page" one tap away; a dead code
// says so alone.
//
// Every word is a catalog line (`qrScan.*`), the scanner's included (passed in as `words`).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import Icon from '../../components/Icon';
import Avatar from '../../components/Avatar';
import Badge from '../../components/Badge';
import QrScanner from '../../components/QrScanner';
import { useT } from '../../i18n/react';
import { timeAgoLong } from '../../i18n/relative';
import { useBackTarget } from '../../hooks/useBackTarget';
import { useFromHere } from '../../hooks/useFromHere';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { usePermission } from '../../hooks/usePermission';
import { useCrewPreview } from '../../hooks/useCrewPreview';
import { useGetState, useSelector, shallowEqual, useJobsHydrated, useJobsLoader } from '../../store';
import { selectCurrentUser, selectTodayCleansForUser, selectClientById, selectJobById, selectSiteById, selectUserById } from '../../store/selectors';
import { crewPaths } from '../../lib/crewPaths';
import { isOfficeRole } from '../../lib/roles';
import { isSupplyRole } from '../../lib/navData';
import { scanTokenFromText, SCAN_INACTIVE_CODE } from '../../lib/areaScan';
import { crewCleanAtLocation } from '../../lib/scanCodes';
import { checklistFor } from '../../lib/crewChecklist';
import { FILL_IN_STATE, FILL_IN_REFUSAL } from '../../lib/scanFillIn';
import { WO_TYPE_META } from '../../lib/workOrders';
import { staffScanDestination, crewAreaDestination, publicScanPath, SCAN_CODE_PARAM, SCAN_VIEW_PUBLIC } from '../../lib/scanLanding';
import { resolveScanCode, crewAreaForScan, fillInFromScan } from '../../lib/scanCodesApi';
import { dayKey } from '../../lib/dates';

// The last scan that opened a checklist, per person, on this phone. One entry each, overwritten.
const LAST_SCAN_KEY = 'crew.lastScan.v1';
function readLastScan(userId) {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_SCAN_KEY) || '{}');
    const e = all && typeof all === 'object' ? all[userId] : null;
    return e && typeof e === 'object' && typeof e.jobId === 'string' ? e : null;
  } catch { return null; }
}
function writeLastScan(userId, entry) {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_SCAN_KEY) || '{}');
    const next = all && typeof all === 'object' ? all : {};
    next[userId] = entry;
    localStorage.setItem(LAST_SCAN_KEY, JSON.stringify(next));
  } catch { /* private mode or quota: the shortcut is simply not kept */ }
}

// A refusal → its sentence key. No signal (a fetch that never reached the server) is the offline line.
function refusalKey(err) {
  if (!err || err.status == null) return 'qrScan.offline';
  if (err.code === SCAN_INACTIVE_CODE) return 'qrScan.inactive';
  if (err.status === 429) return 'qrScan.rateLimited';
  return 'qrScan.failedCheck';
}
// A fill-in the server refused because today's clean moved under the cleaner (someone clocked in,
// the office changed the crew) is "it changed — scan again"; anything else is "try again".
const FILL_IN_CHANGED = new Set(Object.values(FILL_IN_REFUSAL));

// Each state's sentence (lib/scanFillIn FILL_IN_STATE), a map of literal keys (§140).
const FILL_IN_LINES = {
  [FILL_IN_STATE.OFFER]: 'qrScan.fillIn.offer',
  [FILL_IN_STATE.EVERYONE_IN]: 'qrScan.fillIn.everyoneIn',
  [FILL_IN_STATE.NO_CLEAN]: 'qrScan.fillIn.noClean',
  [FILL_IN_STATE.DONE]: 'qrScan.fillIn.done',
  [FILL_IN_STATE.ASK_MANAGER]: 'qrScan.fillIn.askManager',
};
const RESULT_LINES = { pass: 'qrScan.area.result.pass', fail: 'qrScan.area.result.fail', needs_follow_up: 'qrScan.area.result.needsFollowUp' };
const RESULT_TONE = { pass: 'green', fail: 'red', needs_follow_up: 'amber' };
const TYPE_LINES = {
  complaint: 'qrScan.area.type.complaint', request: 'qrScan.area.type.request',
  issue: 'qrScan.area.type.issue', failed_inspection: 'qrScan.area.type.failedInspection',
};

export default function CrewScan() {
  const t = useT();
  const navigate = useNavigate();
  const nav = useFromHere();
  const online = useOnlineStatus();
  const getState = useGetState();
  const loader = useJobsLoader();
  const me = useSelector(selectCurrentUser);
  const userId = me?.id || null;
  const { previewing, name: previewName } = useCrewPreview();
  const { href, goBack } = useBackTarget(crewPaths.home());
  const [now] = useState(() => Date.now());
  const cleans = useSelector(
    useCallback((s) => selectTodayCleansForUser(s, userId, now), [userId, now]),
    shallowEqual,
  );
  // A printed code opened by a signed-in staff member (lib/scanLanding): `?code=<token>`.
  const [searchParams, setSearchParams] = useSearchParams();
  const codeParam = searchParams.get(SCAN_CODE_PARAM);
  // The EFFECTIVE user's role (the owner's View-as a cleaner is a cleaner here) and whether they may
  // open the customer's page.
  const office = isOfficeRole(me?.role);
  const canSeeCustomer = usePermission('clients.view');
  const canSeeSupplies = usePermission('supplies.view');
  const jobsHydrated = useJobsHydrated();
  const handledCode = useRef(null);
  // null · { busy } · { key, params, home?, publicFor? } (a notice) · { fillIn } (the offer or why
  // there is none) · { area } (the cleaner's view of the area) — `paused` holds the camera while
  // one is shown. A `?code=` arrival starts "busy" with NO camera at all (not even the library): it
  // opens only when the person asks to scan again.
  const [notice, setNotice] = useState(() => (codeParam ? { busy: true } : null));
  const [cameraOn, setCameraOn] = useState(() => !codeParam);
  const [filling, setFilling] = useState(null);
  const [last, setLast] = useState(() => readLastScan(userId));
  const today = dayKey(now);
  const lastToday = last && last.day === today && cleans.some((j) => j.id === last.jobId) ? last : null;

  const words = useMemo(() => ({
    hint: t('qrScan.hint'),
    starting: t('qrScan.starting'),
    noCamera: t('qrScan.noCamera'),
    noCameraHelp: t('qrScan.noCameraHelp'),
    denied: t('qrScan.denied'),
    deniedHelp: t('qrScan.deniedHelp'),
    failed: t('qrScan.failed'),
    failedHelp: t('qrScan.failedHelp'),
    retry: t('qrScan.retry'),
    photo: t('qrScan.photo'),
    reading: t('qrScan.reading'),
    photoNone: t('qrScan.photoNone'),
  }), [t]);

  // Does THIS cleaner have a checklist on this clean, as the store holds it now (covers included)?
  const hasChecklistOn = useCallback((job, loc) => {
    if (!job) return false;
    const st = getState();
    const held = selectJobById(st, job.id) || job;
    const client = selectClientById(st, held.clientId || loc?.clientId || null);
    return !!checklistFor({ client, job: held, userId });
  }, [getState, userId]);

  // Does the store lack what a clean's screens read — the clean itself, its customer (the checklist
  // picks) or its location (the clock's address and ring)? A crew login's projection holds only the
  // customers of its own cleans, so a clean it just joined at a new building lacks both until the
  // projection is read again (`rescope`); a phone that holds them adopts nothing.
  const lacksClean = useCallback((job, loc) => {
    const st = getState();
    return !selectJobById(st, job.id)
      || !selectClientById(st, job.clientId || loc?.clientId || null)
      || !selectSiteById(st, job.siteId || loc?.siteId || null);
  }, [getState]);

  // Go to a checklist (and keep it as the "Last scan"). A link from the phone's camera REPLACES this
  // page and carries no referrer: Back from where it lands is that page's own, never this one
  // (which would resolve the code again).
  const openChecklist = useCallback((to, jobId, loc, link) => {
    const entry = { jobId, areaId: loc?.areaId || null, building: loc?.building || loc?.siteName || '', at: new Date().toISOString(), day: dayKey(Date.now()) };
    writeLastScan(userId, entry);
    setLast(entry);
    navigate(to, link ? { replace: true } : { state: nav });
  }, [nav, navigate, userId]);

  // What this cleaner finds at the code's location today (EP-420), and where that leads.
  const askCrewArea = useCallback(async (token, loc, link) => {
    let answer;
    try {
      answer = await crewAreaForScan(token, { state: getState(), user: me, previewUserId: previewing ? userId : null });
    } catch (err) {
      setNotice({ key: refusalKey(err) });
      return;
    }
    // The server says they ARE on a clean there: adopt it (a phone a minute behind may not hold it,
    // or hold its customer) before asking which checklist is theirs.
    if (answer?.onClean && lacksClean(answer.onClean, loc)) {
      try { await loader.adoptServerJobs([answer.onClean], { rescope: true }); } catch { /* the next poll brings it */ }
    }
    const dest = crewAreaDestination({ loc, answer, hasChecklist: hasChecklistOn(answer?.onClean, loc) });
    if (dest.kind === 'checklist') { openChecklist(dest.to, dest.jobId, loc, link); return; }
    if (dest.kind === 'info') { setNotice({ area: { ...dest, token } }); return; }
    setNotice({ fillIn: { ...dest, token, loc, link } });
  }, [getState, hasChecklistOn, lacksClean, loader, me, openChecklist, previewing, userId]);

  // ONE road for the camera and a `?code=` link: WHERE the code is (EP-386), then WHERE this person
  // goes (staffScanDestination; for a cleaner without their checklist there, the server's answer).
  const resolveToken = useCallback(async (token, { link = false } = {}) => {
    setNotice({ busy: true });
    let loc;
    try {
      loc = await resolveScanCode(token, { state: getState(), user: me });
    } catch (err) {
      setNotice({ key: refusalKey(err) });
      return;
    }
    const clean = office ? null : crewCleanAtLocation({ cleans, siteId: loc.siteId, clientId: loc.clientId });
    const dest = staffScanDestination({ loc, token, office, supply: isSupplyRole(me), canSeeCustomer, canSeeSupplies, clean, hasChecklist: hasChecklistOn(clean, loc) });
    if (dest.kind === 'checklist') { openChecklist(dest.to, clean.id, loc, link); return; }
    if (dest.kind === 'crewArea') { await askCrewArea(token, loc, link); return; }
    // A link from the phone's camera REPLACES this page and carries no referrer: Back from where it
    // lands is that page's own, never this one (which would resolve the code again).
    navigate(dest.to, link ? { replace: true } : { state: nav });
  }, [askCrewArea, canSeeCustomer, canSeeSupplies, cleans, getState, hasChecklistOn, me, nav, navigate, office, openChecklist]);

  // The tap: fill in for this person on that clean (EP-419). The clean the server answers with is
  // adopted at once — rescoping a crew login's projection, since a building it never cleaned now
  // joins it — and the checklist that is now theirs opens (the covered cleaner's: "Covering for …"),
  // or, with none, the building's view.
  const fillIn = useCallback(async (offer, cand) => {
    if (previewing || filling) return;
    setFilling(`${cand.jobId}|${cand.userId}`);
    try {
      const r = await fillInFromScan({ token: offer.token, jobId: cand.jobId, coverFor: cand.userId }, { state: getState(), user: me });
      // The written clean always replaces the phone's copy (it is newer); the projection is read
      // again only when the building is new to this phone.
      if (r?.job) await loader.adoptServerJobs([r.job], { rescope: lacksClean(r.job, offer.loc) });
      if (r?.job && hasChecklistOn(r.job, offer.loc)) {
        openChecklist(crewPaths.checklist(r.job.id, offer.loc?.areaId || null), r.job.id, offer.loc, offer.link);
        return;
      }
      await askCrewArea(offer.token, offer.loc, offer.link);
    } catch (err) {
      if (err?.status == null) setNotice({ key: 'qrScan.offline' });
      else if (FILL_IN_CHANGED.has(err.code)) setNotice({ key: 'qrScan.fillIn.changed', publicFor: offer.token });
      else if (err.status === 429) setNotice({ key: 'qrScan.rateLimited' });
      else setNotice({ key: 'qrScan.fillIn.failed', publicFor: offer.token });
    } finally {
      setFilling(null);
    }
  }, [askCrewArea, filling, getState, hasChecklistOn, lacksClean, loader, me, openChecklist, previewing]);

  const onResult = useCallback(async (text) => {
    const token = scanTokenFromText(text);
    if (!token) { setNotice({ key: 'qrScan.notACode' }); return; }
    await resolveToken(token);
  }, [resolveToken]);

  // `?code=`: resolved at once, ONCE (StrictMode runs an effect twice; the ref holds), and for a
  // cleaner only once their cleans have loaded (the jobs window), so a clean that has not arrived
  // yet is never mistaken for none. The code leaves the address as it is taken, so a reload, a
  // later scan's referrer and Back never resolve it again.
  useEffect(() => {
    if (!codeParam || !online || (!office && !jobsHydrated)) return;
    if (handledCode.current === codeParam) return;
    handledCode.current = codeParam;
    const next = new URLSearchParams(searchParams);
    next.delete(SCAN_CODE_PARAM);
    setSearchParams(next, { replace: true });
    const token = scanTokenFromText(codeParam);
    if (!token) { setNotice({ key: 'qrScan.notACode' }); return; }
    resolveToken(token, { link: true });
  }, [codeParam, jobsHydrated, office, online, resolveToken, searchParams, setSearchParams]);

  const scanAgain = () => { setNotice(null); setCameraOn(true); };
  const scanAgainButton = <button type="button" className="btn btn-outline qr-scan-btn" onClick={scanAgain}>{t('qrScan.scanAgain')}</button>;
  const publicLink = (token) => (
    <Link className="btn btn-outline qr-scan-btn" to={publicScanPath(token, { view: SCAN_VIEW_PUBLIC })}>{t('qrScan.publicPage')}</Link>
  );

  return (
    <div className="qr-scan-screen">
      <header className="qr-scan-head">
        <a href={href} onClick={goBack} className="btn-icon qr-scan-back" aria-label={t('back.back')}>
          <Icon name="chevronLeft" size={20} />
        </a>
        <h1 className="qr-scan-title">{t('qrScan.title')}</h1>
      </header>

      <div className="qr-scan-body">
        {!online ? (
          <div className="qr-scan-notice" role="status">
            <Icon name="warning" size={20} />
            <p className="qr-scan-notice-text">{t('qrScan.offline')}</p>
            <a className="btn btn-outline qr-scan-btn" href={crewPaths.stops()} onClick={(e) => { e.preventDefault(); navigate(crewPaths.stops(), { state: nav }); }}>
              {t('qrScan.openStops')}
            </a>
          </div>
        ) : (
          <>
            {cameraOn && <QrScanner onResult={onResult} paused={!!notice} words={words} />}
            {notice?.fillIn && (
              <FillInOffer offer={notice.fillIn} t={t} filling={filling} previewing={previewing} previewName={previewName} onPick={fillIn}>
                {scanAgainButton}
                {publicLink(notice.fillIn.token)}
              </FillInOffer>
            )}
            {notice?.area && (
              <AreaView view={notice.area} t={t}>
                {scanAgainButton}
              </AreaView>
            )}
            {notice && !notice.fillIn && !notice.area && (
              <div className="qr-scan-notice" role="status">
                {notice.busy ? (
                  <p className="qr-scan-notice-text">{t('qrScan.checking')}</p>
                ) : (
                  <>
                    <p className="qr-scan-notice-text">{t(notice.key, notice.params)}</p>
                    <div className="qr-scan-notice-actions">
                      {scanAgainButton}
                      {notice.publicFor && publicLink(notice.publicFor)}
                      {notice.home && (
                        <a className="btn btn-outline qr-scan-btn" href={crewPaths.stops()} onClick={(e) => { e.preventDefault(); navigate(crewPaths.stops(), { state: nav }); }}>
                          {t('qrScan.openStops')}
                        </a>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {lastToday && !notice?.area && (
        <section className="qr-scan-sheet" aria-labelledby="qr-scan-last">
          <h2 id="qr-scan-last" className="qr-scan-sheet-label">{t('qrScan.lastScan')}</h2>
          <div className="qr-scan-last">
            <span className="qr-scan-last-icon" aria-hidden="true"><Icon name="check" size={20} /></span>
            <span className="qr-scan-last-text">
              <span className="qr-scan-last-name">{lastToday.building}</span>
              <span className="qr-scan-last-when">{t('qrScan.scannedAt', { time: lastToday.at })}</span>
            </span>
          </div>
          <button
            type="button"
            className="btn btn-primary qr-scan-open"
            onClick={() => navigate(crewPaths.checklist(lastToday.jobId, lastToday.areaId), { state: nav })}
          >
            {t('qrScan.openChecklist')}
          </button>
        </section>
      )}
    </div>
  );
}

// "Filling in for someone?" (QR-14) — or why there is no one to fill in for. Each person is the
// one Avatar (photo over initials, §141) and their name from the roster, with their clean's time;
// one tap each, off in the owner's preview.
function FillInOffer({ offer, t, filling, previewing, previewName, onPick, children }) {
  const isOffer = offer.state === FILL_IN_STATE.OFFER && offer.candidates.length > 0;
  return (
    <div className="qr-scan-notice qr-scan-fill" role="status">
      <p className="qr-scan-notice-text">{t(FILL_IN_LINES[offer.state] || FILL_IN_LINES[FILL_IN_STATE.NO_CLEAN], { site: offer.place })}</p>
      {isOffer && (
        <ul className="qr-scan-fill-list">
          {offer.candidates.map((c) => (
            <li key={`${c.jobId}|${c.userId}`}>
              <FillInChoice cand={c} t={t} busy={filling === `${c.jobId}|${c.userId}`} disabled={previewing || !!filling} onPick={() => onPick(offer, c)} />
            </li>
          ))}
        </ul>
      )}
      {isOffer && previewing && <p className="qr-scan-fill-note">{t('qrScan.fillIn.preview', { name: previewName })}</p>}
      <div className="qr-scan-notice-actions">{children}</div>
    </div>
  );
}

function FillInChoice({ cand, t, busy, disabled, onPick }) {
  const person = useSelector(useCallback((s) => selectUserById(s, cand.userId) || null, [cand.userId]));
  const name = person?.name || t('qrScan.fillIn.someone');
  return (
    <button
      type="button"
      className="btn btn-outline crew-shell-tap qr-scan-fill-choice"
      disabled={disabled}
      aria-label={t('qrScan.fillIn.buttonAria', { name })}
      onClick={onPick}
    >
      <Avatar user={person} size="sm" />
      <span className="qr-scan-fill-text">
        <span className="qr-scan-fill-name">{name}</span>
        <span className="qr-scan-fill-when">{busy ? t('qrScan.fillIn.working') : (cand.startAt ? t('qrScan.fillIn.cleanAt', { time: cand.startAt }) : '')}</span>
      </span>
      <Icon name="chevronRight" size={18} />
    </button>
  );
}

// The cleaner's view of an area when they have no checklist there (QR-12's note): the building's
// last inspection and its open tickets, newest first — the server's allowlist (never a visitor's
// name or contact, a description or a note).
function AreaView({ view, t, children }) {
  const info = view.info || {};
  const lastInspection = info.lastInspection || null;
  const tickets = Array.isArray(info.tickets) ? info.tickets : [];
  const total = Number.isFinite(info.ticketsTotal) ? info.ticketsTotal : tickets.length;
  return (
    <section className="qr-scan-view" aria-labelledby="qr-scan-view-title">
      <div className="qr-scan-view-head">
        <h2 id="qr-scan-view-title" className="qr-scan-view-title">{view.area || view.place}</h2>
        {view.area && view.place && <p className="qr-scan-view-place">{view.place}</p>}
        <p className="qr-scan-view-note">{t('qrScan.area.noChecklist')}</p>
      </div>
      <div className="qr-scan-view-block">
        <h3 className="qr-scan-sheet-label">{t('qrScan.area.lastInspection')}</h3>
        {lastInspection?.performedAt ? (
          <p className="qr-scan-view-row">
            <span>{t('qrScan.area.inspectedOn', { at: lastInspection.performedAt })}</span>
            {RESULT_LINES[lastInspection.result] && <Badge variant={RESULT_TONE[lastInspection.result]}>{t(RESULT_LINES[lastInspection.result])}</Badge>}
          </p>
        ) : (
          <p className="qr-scan-view-empty">{t('qrScan.area.noInspection')}</p>
        )}
      </div>
      <div className="qr-scan-view-block">
        <h3 className="qr-scan-sheet-label">{t('qrScan.area.openTickets')}{total ? ` (${total})` : ''}</h3>
        {tickets.length ? (
          <ul className="qr-scan-tickets">
            {tickets.map((tk, i) => (
              <li key={`${tk.openedAt || ''}:${i}`} className="qr-scan-ticket">
                <span className="qr-scan-ticket-title">{tk.title || (TYPE_LINES[tk.type] ? t(TYPE_LINES[tk.type]) : '')}</span>
                <span className="qr-scan-ticket-meta">
                  {TYPE_LINES[tk.type] && <Badge variant={WO_TYPE_META[tk.type]?.badge || 'slate'}>{t(TYPE_LINES[tk.type])}</Badge>}
                  {tk.area && <span>{t('qrScan.area.inArea', { area: tk.area })}</span>}
                  {tk.openedAt && <span>{t('qrScan.area.opened', { ago: timeAgoLong(t, tk.openedAt) })}</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="qr-scan-view-empty">{t('qrScan.area.noTickets')}</p>
        )}
        {total > tickets.length && <p className="qr-scan-view-more">{t('qrScan.area.shown', { shown: tickets.length, total })}</p>}
      </div>
      <div className="qr-scan-view-actions">{children}</div>
    </section>
  );
}
