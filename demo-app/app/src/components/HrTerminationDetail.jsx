// One termination (Super Clippy's idea #513 from Clean Corner's queue): the read view, and the
// moves the record allows. ONE component for every place a termination opens — HR → Terminations
// and the HR card of the person (HR → Employees → the person, Team → member → HR) — so they cannot
// disagree about what it says or what may be done to it.
//
// It reads as MATT'S FORM: his lines in his order, his sixteen reasons as ticks in his two columns
// (the ticked ones marked), "Other:" with its words as typed (LANG-7), then what happened to the
// login and who filed it.
//
// 🔴 LOCKED ONCE FILED (Daniel's pick, 2026-11-05: "Locked; a void undoes it"): there is no Edit
// here, by design. The moves:
//   · Void (the Super Admin) — with a reason; it stays on file, marked. Before the date the login
//     never turns off; after it, the login comes back on only if this termination turned it off;
//   · Print / Save as PDF — his form (lib/hrTerminationDocument).
// Each control shows only to someone the server will let do it (UI_RULES §118).
//
// "STILL ON" (Daniel's pick, 2026-11-05: "Access only, list what's left"): a termination turns
// the login off and nothing else, so while it stands the view lists what the person is still on
// for the office to reassign: the customers they are Account Manager of or Work at, and their
// cleans in the 60 days from the termination day (or from today, once it has passed), each a link.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelector, useJobsDays } from '../store';
import { usePermission } from '../hooks/usePermission';
import { useFromHere } from '../hooks/useFromHere';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';
import { english } from '../i18n/core';
import { fmtDate, todayKey, addDaysKey } from '../lib/dates';
import { worksAtOf } from '../lib/worksAt';
import { isArchivedCustomer } from '../lib/customerStatus';
import { isUserJobCrew } from '../lib/crewResolve';
import { jobsCoveredByTimeOff } from '../store/timeOffRules';
import {
  TERMINATION_FORM_KEYS, TERMINATION_REASONS, TERMINATION_REASON_KEYS, TERMINATION_REASON, TERMINATION_STATUS,
  TERMINATION_STANDING_KEYS, TERMINATION_STANDING_VARIANTS, TERMINATION_TEXT_MAX, TERMINATION_REFUSAL_KEYS, ACCESS_STATE,
  terminationStanding, normalizeReasons,
} from '../lib/hrTerminations';
import { buildTerminationDocumentHtml } from '../lib/hrTerminationDocument';
import * as hrTerminationsApi from '../lib/hrTerminationsApi';
import { IDENTITY } from '../brand/identity.generated';
import Badge from './Badge';
import FormField from './FormField';
import Icon from './Icon';
import { useToast } from './Toast';
import { terminationErrorText } from './HrTerminationForm';

const day = (key) => (key ? fmtDate(`${key}T12:00:00`, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
// How far "Still on" looks for cleans, and how many it lists before "and N more".
export const STILL_ON_DAYS = 60;
const STILL_ON_CLEANS_SHOWN = 10;

// Hand his form to the browser's print dialog ("Save as PDF"). The window opens FIRST, inside the
// click, or a pop-up blocker refuses it. His form is English only, so the printout is too.
function printTermination(r, t, toast) {
  const win = window.open('', '_blank');
  if (!win) { toast.error(t('hrTerm.printBlocked')); return; }
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${english(TERMINATION_FORM_KEYS.title)}</title></head><body>${buildTerminationDocumentHtml(r)}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}

// The one sentence on what the termination did, or will do, to the login.
export function accessSentence(t, r, today) {
  const brand = IDENTITY.product.name;
  if (r.status === TERMINATION_STATUS.voided) {
    if (r.accessState === ACCESS_STATE.restored) return t('hrTerm.access.restored', { when: r.accessRestoredAt });
    if (r.accessState === ACCESS_STATE.kept) return t('hrTerm.access.kept');
    if (r.accessState === ACCESS_STATE.alreadyOff) return t('hrTerm.access.alreadyOff');
    if (r.accessState === ACCESS_STATE.scheduled) return t('hrTerm.access.neverOff');
    return t('hrTerm.access.restoring');
  }
  if (r.accessState === ACCESS_STATE.ended) return t('hrTerm.access.ended', { brand, when: r.accessEndedAt });
  if (r.accessState === ACCESS_STATE.alreadyOff) return t('hrTerm.access.alreadyOff');
  if (r.terminationDate && r.terminationDate > today) return t('hrTerm.access.scheduled', { brand, date: day(r.terminationDate) });
  return t('hrTerm.access.due', { brand });
}

function Fact({ label, children }) {
  return (
    <div className="hrt-fact">
      <dt>{label}</dt>
      <dd>{children === null || children === undefined || children === '' ? '—' : children}</dd>
    </div>
  );
}

// What the person is still on: their customers, and their cleans from the day on.
function StillOn({ r, today, t }) {
  const nav = useFromHere();
  const canClients = usePermission('clients.view');
  const canSchedule = usePermission('schedule.view');
  const users = useSelector(useCallback((s) => s.users || [], []));
  const clients = useSelector(useCallback((s) => s.clients || [], []));
  const jobs = useSelector(useCallback((s) => s.jobs || [], []));
  const from = r.terminationDate && r.terminationDate > today ? r.terminationDate : today;
  const to = addDaysKey(from, STILL_ON_DAYS - 1);
  const loaded = useJobsDays(from, to);

  const member = users.find((u) => u.id === r.employeeUserId) || null;
  const customers = useMemo(() => {
    const works = new Set(worksAtOf(member));
    return clients
      .filter((c) => c && c.id && !isArchivedCustomer(c) && (c.supervisorId === r.employeeUserId || works.has(c.id)))
      .map((c) => ({ id: c.id, name: c.name || '—', asManager: c.supervisorId === r.employeeUserId, worksAt: works.has(c.id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [clients, member, r.employeeUserId]);
  const cleans = useMemo(() => jobsCoveredByTimeOff(jobs, { startDate: from, endDate: to, isOnCrew: (j) => isUserJobCrew(j, r.employeeUserId) })
    .filter((j) => !j.recurrence)
    .slice().sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)) || String(a.id).localeCompare(String(b.id))),
  [jobs, from, to, r.employeeUserId]);
  const nameOf = useMemo(() => Object.fromEntries(clients.map((c) => [c.id, c.name])), [clients]);

  const none = customers.length === 0 && loaded.ready && cleans.length === 0;
  return (
    <section className="hrt-still card detail-card">
      <h3 className="dash-card-title">{t('hrTerm.detail.stillOnTitle')}</h3>
      {none ? (
        <p className="text-sm text-muted hrt-still-none">{t('hrTerm.detail.noneLeft', { date: day(from) })}</p>
      ) : (
        <>
          <p className="text-sm text-muted hrt-still-lead">{t('hrTerm.detail.stillOnLead')}</p>
          {customers.length > 0 && (
            <div className="hrt-still-group">
              <p className="hrt-still-head">{t('hrTerm.detail.customers')}</p>
              <ul className="hrt-still-list">
                {customers.map((c) => {
                  const role = [c.asManager && t('hrTerm.detail.asManager'), c.worksAt && t('hrTerm.detail.worksAt')].filter(Boolean).join(' · ');
                  return (
                    <li key={c.id} className="hrt-still-row">
                      {canClients
                        ? <Link to={`/clients/${c.id}`} state={nav} className="hrt-still-name">{c.name}</Link>
                        : <span className="hrt-still-name">{c.name}</span>}
                      <span className="hrt-still-sub">{role}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <div className="hrt-still-group">
            <p className="hrt-still-head">{t('hrTerm.detail.cleans', { date: day(from) })}</p>
            {loaded.error ? (
              <p className="text-sm text-muted">
                {t('hrTerm.detail.cleansFailed')} <button type="button" className="linklike" onClick={loaded.retry}>{t('common.retry')}</button>
              </p>
            ) : !loaded.ready ? (
              <p className="text-sm text-muted">{t('hrTerm.detail.cleansLoading')}</p>
            ) : cleans.length === 0 ? (
              <p className="text-sm text-muted">—</p>
            ) : (
              <ul className="hrt-still-list">
                {cleans.slice(0, STILL_ON_CLEANS_SHOWN).map((j) => {
                  const label = fmtDate(j.startAt, { weekday: 'short', month: 'short', day: 'numeric' });
                  const where = nameOf[j.clientId] || '—';
                  return (
                    <li key={j.id} className="hrt-still-row">
                      {canSchedule
                        ? <Link to={`/schedule/${j.id}`} state={nav} className="hrt-still-name">{label}</Link>
                        : <span className="hrt-still-name">{label}</span>}
                      <span className="hrt-still-sub">{where}</span>
                    </li>
                  );
                })}
                {cleans.length > STILL_ON_CLEANS_SHOWN && (
                  <li className="hrt-still-row hrt-still-more">{t('hrTerm.detail.moreCleans', { count: cleans.length - STILL_ON_CLEANS_SHOWN })}</li>
                )}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export default function HrTerminationDetail({
  terminationId, canVoid = false, users = [], currentUserId = null, onChanged, setMemberStatus,
}) {
  const t = useT();
  const toast = useToast();
  const [r, setR] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [step, setStep] = useState(null);        // null | 'void'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [voidReason, setVoidReason] = useState('');
  const today = todayKey();

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      setR(await hrTerminationsApi.getTermination(terminationId));
    } catch (e) {
      setLoadError(e);
    }
  }, [terminationId]);
  useEffect(() => { load(); }, [load]);

  if (loadError) return <div className="callout callout-warning">{errorText(t, loadError, 'hrTerm.loadFailed')}</div>;
  if (!r) return <div className="hrw-loading">{t('hrTerm.loading')}</div>;

  const F = (field) => t(TERMINATION_FORM_KEYS[field]);
  const voided = r.status === TERMINATION_STATUS.voided;
  const standing = terminationStanding(r, today);
  const ticked = new Set(normalizeReasons(r.reasons));

  const doVoid = async () => {
    if (!voidReason.trim()) { setError(t(TERMINATION_REFUSAL_KEYS['void-reason-missing'])); return; }
    setBusy(true);
    setError(null);
    try {
      const out = await hrTerminationsApi.voidTermination(r.id, { reason: voidReason }, { users, currentUserId, setMemberStatus });
      setR(out.termination);
      setStep(null);
      toast.success(t(out.access === ACCESS_STATE.restored ? 'hrTerm.void.doneRestored' : 'hrTerm.void.done'));
      onChanged && onChanged();
    } catch (e) {
      setError(terminationErrorText(t, e));
    } finally { setBusy(false); }
  };

  return (
    <div className="hrt-detail">
      <div className="hrt-detail-head">
        <Badge variant={TERMINATION_STANDING_VARIANTS[standing] || 'slate'}>{t(TERMINATION_STANDING_KEYS[standing] || 'hrTerm.status.scheduled')}</Badge>
        <span className="hrt-detail-sub">{IDENTITY.name}</span>
      </div>

      {voided && (
        <div className="callout callout-warning">
          {t('hrTerm.detail.voided', { name: r.voidedByName || '—', when: r.voidedAt, reason: r.voidReason || '' })}
        </div>
      )}

      <dl className="hrt-facts">
        <Fact label={F('employee')}>{r.employeeName}</Fact>
        <Fact label={F('date')}>{day(r.terminationDate)}</Fact>
      </dl>

      <div className="hrt-ticks-read">
        <p className="hrt-q">{F('reasons')}</p>
        <div className="hrt-tick-list" role="group" aria-label={F('reasons')}>
          {TERMINATION_REASONS.map((x) => {
            const on = ticked.has(x);
            const other = x === TERMINATION_REASON.other;
            return (
              <span key={x} className={on ? 'hrt-tick-read is-on' : 'hrt-tick-read'} role="checkbox" aria-checked={on} aria-readonly="true">
                <span className="hrt-box" aria-hidden>{on && <Icon name="check" size={12} />}</span>
                <span>{t(TERMINATION_REASON_KEYS[x])}{other && on && r.reasonOther ? ` ${r.reasonOther}` : ''}</span>
              </span>
            );
          })}
        </div>
      </div>

      <dl className="hrt-facts">
        <Fact label={F('manager')}>{r.managerName}</Fact>
      </dl>

      <p className="callout callout-info hrt-login">{accessSentence(t, r, today)}</p>
      <p className="text-sm text-muted hrt-filed">{t('hrTerm.detail.filed', { name: r.filedByName || '—', when: r.filedAt })}</p>

      {!voided && <StillOn r={r} today={today} t={t} />}

      {step === 'void' && (
        <section className="hrw-step card detail-card">
          <h3 className="dash-card-title">{t('hrTerm.void.title')}</h3>
          <p className="text-sm">{t('hrTerm.void.lead')}</p>
          <FormField label={t('hrTerm.void.reason')} as="textarea" rows={3} required value={voidReason}
            maxLength={TERMINATION_TEXT_MAX.voidReason} onChange={(e) => setVoidReason(e.target.value)} />
          {error && <div className="callout callout-warning" role="alert">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={() => setStep(null)} disabled={busy}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-danger" onClick={doVoid} disabled={busy}>{t('hrTerm.void.submit')}</button>
          </div>
        </section>
      )}

      {!step && (
        <div className="modal-actions hrw-actions">
          <button type="button" className="btn btn-outline" onClick={() => printTermination(r, t, toast)}>{t('hrTerm.action.print')}</button>
          {canVoid && !voided && (
            <button type="button" className="btn btn-outline" onClick={() => { setError(null); setVoidReason(''); setStep('void'); }}>{t('hrTerm.action.void')}</button>
          )}
        </div>
      )}
    </div>
  );
}
