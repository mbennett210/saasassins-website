// One HR warning: the read view, and the moves the record allows (Matt's HR-1..HR-5).
// ONE component for every place a warning opens — HR → Warnings, the employee's HR card,
// Team → member → HR, and the employee's own My Day — so they cannot disagree about what a
// warning says or what may be done to it.
//
//   mode 'office'   the supervisor's / HR's view: Print, Sign in person, Refused to sign
//                   (HR-3), and Void for the Super Admin. Each control shows only to someone
//                   the server will let do it (UI_RULES §118).
//   mode 'employee' the employee's own warning: read it, Translate it, comment and sign.
//
// 🔴 LOCKED ONCE ISSUED: there is no Edit here, by design. A mistake is voided with a reason
// and stays on file. The supervisor and the HR manager are PICKED (the team shares one
// login), never inferred from who is signed in.
//
// It reads as MATT'S OWN FORM (HR-1 b): his questions as the labels, his ticked reasons, and
// his Note above every signature the employee gives — "Your signature on this form means
// that we have discussed the situation…" — word for word, in the reader's language (his
// team's Spanish for a Spanish reader). The HR manager's refusal step keeps its own lead: the
// Note speaks to the employee, and the HR manager is not the one being warned.
//
// Words: the catalog, in the reader's language (UI_RULES §140). The supervisor's own words
// (the details, the corrective action, "Other") are shown as written (LANG-7), with Translate
// for the employee — Google, on demand, never stored.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';
import { english } from '../i18n/core';
import { ensureCatalog } from '../i18n/runtime';
import { fmtDate } from '../lib/dates';
import { SUPERVISOR_ROLES, compareUsersByName } from '../lib/roles';
import {
  WARNING_STATUS, WARNING_LEVEL_KEYS, WARNING_REASON_KEYS, WARNING_STATUS_KEYS, WARNING_STATUS_VARIANTS,
  WARNING_LEVEL_VARIANTS, WARNING_REASON, WARNING_REFUSAL_KEYS, WARNING_TEXT_MAX, WARNING_FORM_KEYS,
  normalizeReasons,
} from '../lib/hrWarnings';
import { buildWarningDocumentHtml, WARNING_DOCUMENT_LANGUAGES } from '../lib/hrWarningDocument';
import * as hrWarningsApi from '../lib/hrWarningsApi';
import Badge from './Badge';
import FormField from './FormField';
import FilterSelect from './FilterSelect';
import SignatureCapture from './SignatureCapture';
import { useToast } from './Toast';

const day = (key) => (key ? fmtDate(`${key}T12:00:00`, { month: 'short', day: 'numeric', year: 'numeric' }) : '');

// The pad's own words, in the reader's language.
export function useSignatureWords() {
  const t = useT();
  return useMemo(() => ({
    draw: t('hrWarn.pad.draw'), type: t('hrWarn.pad.type'), clear: t('hrWarn.pad.clear'),
    drawHint: t('hrWarn.pad.drawHint'), signed: t('hrWarn.pad.signed'), typePlaceholder: t('hrWarn.pad.typePlaceholder'),
  }), [t]);
}

// A refusal the server or the stub named by code, in the reader's language.
export function warningErrorText(t, err) {
  return errorText(t, err, 'hrWarn.saveFailed', WARNING_REFUSAL_KEYS);
}

// The ticked reasons, in his form's order, in the reader's language — "Other" with its words.
export function reasonsText(t, w, otherWords = w && w.reasonOther) {
  return normalizeReasons(w && w.reasons)
    .map((r) => (r === WARNING_REASON.other && otherWords ? `${t(WARNING_REASON_KEYS[r])}: ${otherWords}` : t(WARNING_REASON_KEYS[r])))
    .join(', ');
}

// Hand his form — the English page, then the Spanish page — to the browser's print dialog
// ("Save as PDF"). The window opens FIRST, inside the click, or a pop-up blocker refuses it;
// the Spanish catalog loads before the document is built, or page two would be English.
async function printWarning(w, t, toast) {
  const win = window.open('', '_blank');
  if (!win) { toast.error(t('hrWarn.printBlocked')); return; }
  await Promise.all(WARNING_DOCUMENT_LANGUAGES.map((lang) => ensureCatalog(lang)));
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${english(WARNING_FORM_KEYS.title)}</title></head><body>${buildWarningDocumentHtml(w)}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}

export default function HrWarningDetail({
  warningId, mode = 'office', canEdit = false, canVoid = false, users = [], currentUserId = null,
  initialStep = null, onChanged, onClose,
}) {
  const t = useT();
  const toast = useToast();
  const sigWords = useSignatureWords();
  const [w, setW] = useState(null);
  const [loadError, setLoadError] = useState(null);
  // null | 'sign' | 'refuse' | 'void' — 'sign' straight away when the supervisor chose
  // "in person, now" on the form.
  const [step, setStep] = useState(initialStep);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [comment, setComment] = useState('');
  const [hrManagerId, setHrManagerId] = useState('');
  const [voidReason, setVoidReason] = useState('');
  const [translated, setTranslated] = useState(null); // { whatHappened, … } | null
  const [showTranslated, setShowTranslated] = useState(false);
  const padRef = useRef(null);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      setW(await hrWarningsApi.getWarning(warningId));
    } catch (e) {
      setLoadError(e);
    }
  }, [warningId]);
  useEffect(() => { load(); }, [load]);

  const ctx = { users, currentUserId };
  const managers = useMemo(() => users
    .filter((u) => u.status === 'active' && SUPERVISOR_ROLES.includes(u.role))
    .slice().sort(compareUsersByName), [users]);

  if (loadError) return <div className="callout callout-warning">{errorText(t, loadError, 'hrWarn.loadFailed')}</div>;
  if (!w) return <div className="hrw-loading">{t('common.loading')}</div>;

  const awaiting = w.status === WARNING_STATUS.awaiting;
  const words = showTranslated && translated ? { ...w, ...translated } : w;
  const F = (field) => t(WARNING_FORM_KEYS[field]);

  const run = async (fn, doneKey) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      if (next) setW((prev) => ({ ...prev, ...next }));
      await load();
      setStep(null);
      toast.success(t(doneKey));
      onChanged && onChanged();
    } catch (e) {
      setError(warningErrorText(t, e));
    } finally { setBusy(false); }
  };

  const takeSignature = () => {
    const pad = padRef.current;
    if (!pad || pad.isEmpty()) { setError(t(WARNING_REFUSAL_KEYS['signature-missing'])); return null; }
    return pad.toDataURL();
  };

  const sign = () => {
    const signature = takeSignature();
    if (!signature) return;
    run(() => hrWarningsApi.acknowledgeWarning(w.id, { signature, comment }, ctx), 'hrWarn.sign.signed');
  };
  const refuse = () => {
    if (!hrManagerId) { setError(t(WARNING_REFUSAL_KEYS['hr-manager-missing'])); return; }
    const signature = takeSignature();
    if (!signature) return;
    run(() => hrWarningsApi.refuseWarning(w.id, { hrManagerUserId: hrManagerId, signature }, ctx), 'hrWarn.refuse.done');
  };
  const doVoid = () => {
    if (!voidReason.trim()) { setError(t(WARNING_REFUSAL_KEYS['void-reason-missing'])); return; }
    run(() => hrWarningsApi.voidWarning(w.id, { reason: voidReason }, ctx), 'hrWarn.void.done');
  };

  const translate = async () => {
    if (translated) { setShowTranslated(!showTranslated); return; }
    setBusy(true);
    setError(null);
    try {
      const out = await hrWarningsApi.translateWarning(w.id, t.lang);
      setTranslated(out.texts || {});
      setShowTranslated(true);
    } catch (e) {
      setError(e?.code === 'machine-translation-off' ? t('hrWarn.translate.off') : t('hrWarn.translate.failed'));
    } finally { setBusy(false); }
  };

  const open = (s) => { setError(null); setStep(s); };
  const employee = w.employeeName || t('hrWarn.field.employee');

  return (
    <div className="hrw-detail">
      <div className="hrw-detail-head">
        <Badge variant={WARNING_LEVEL_VARIANTS[w.level] || 'slate'}>{t(WARNING_LEVEL_KEYS[w.level] || 'hrWarn.level.first')}</Badge>
        <Badge variant={WARNING_STATUS_VARIANTS[w.status] || 'slate'}>{t(WARNING_STATUS_KEYS[w.status] || 'hrWarn.status.awaiting')}</Badge>
      </div>

      {w.status === WARNING_STATUS.voided && (
        <div className="callout callout-warning">
          {t('hrWarn.detail.voided', { name: w.voidedByName || '—', when: w.voidedAt, reason: w.voidReason || '' })}
        </div>
      )}

      {/* His form's questions, as the labels. */}
      <dl className="detail-dl hrw-facts">
        <div><dt>{F('employeeName')}</dt><dd>{w.employeeName || '—'}</dd></div>
        <div><dt>{F('date')}</dt><dd>{day(w.issuedOn)}</dd></div>
        <div><dt>{F('supervisorName')}</dt><dd>{w.supervisorName || '—'}</dd></div>
        <div><dt>{F('previousMeeting')}</dt><dd>{w.previousMeetingDate ? day(w.previousMeetingDate) : '—'}</dd></div>
        <div><dt>{F('reasonsHeading')}</dt><dd>{reasonsText(t, w, words.reasonOther) || '—'}</dd></div>
      </dl>

      <section className="hrw-words">
        <h4>{F('details')}</h4>
        <p>{words.whatHappened}</p>
        <h4>{F('corrective')}</h4>
        <p>{words.whatMustChange}</p>
        {showTranslated && <p className="text-xs text-muted">{t('hrWarn.translate.note')}</p>}
      </section>

      {/* What is on file about the signature. */}
      <section className="hrw-signed">
        {w.status === WARNING_STATUS.refused || w.refusedAt ? (
          <>
            <p className="text-sm">{t('hrWarn.detail.refusedBy', { name: w.hrManagerName || '—', when: w.hrManagerSignedAt })}</p>
            {w.hrManagerSignature && <img className="hrw-sig" src={w.hrManagerSignature} alt={t('hrWarn.detail.hrSignatureAlt')} />}
          </>
        ) : w.employeeSignedAt ? (
          <>
            <p className="text-sm">
              {t('hrWarn.detail.signedBy', { name: employee, when: w.employeeSignedAt })}
              {w.signedInPerson ? ` · ${t('hrWarn.detail.signedInPerson')}` : ''}
            </p>
            {w.employeeSignature && <img className="hrw-sig" src={w.employeeSignature} alt={t('hrWarn.detail.employeeSignatureAlt')} />}
            {w.employeeComment && (
              <>
                <h4>{t('hrWarn.detail.comment')}</h4>
                <p>{w.employeeComment}</p>
              </>
            )}
            <p className="text-xs text-muted hrw-note">{F('note')}</p>
          </>
        ) : awaiting ? (
          <p className="text-sm text-muted">{t('hrWarn.detail.awaiting', { name: employee })}</p>
        ) : null}
      </section>

      {error && <div className="callout callout-warning" role="alert">{error}</div>}

      {/* ── the steps ── */}
      {step === 'sign' && (
        <section className="hrw-step card detail-card">
          <h3 className="dash-card-title">{t('hrWarn.sign.title')}</h3>
          {mode === 'office' && <p className="text-sm">{t('hrWarn.sign.inPersonNote', { name: employee })}</p>}
          {/* Matt's Note, word for word, above the employee's signature. */}
          <p className="text-sm hrw-note"><strong>{F('note')}</strong></p>
          <FormField label={t('hrWarn.sign.comment')} as="textarea" rows={3} value={comment}
            maxLength={WARNING_TEXT_MAX.comment} placeholder={t('hrWarn.sign.commentPlaceholder')}
            onChange={(e) => setComment(e.target.value)} />
          <SignatureCapture ref={padRef} words={sigWords} />
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={() => setStep(null)} disabled={busy}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-primary" onClick={sign} disabled={busy}>{t('hrWarn.sign.submit')}</button>
          </div>
        </section>
      )}

      {step === 'refuse' && (
        <section className="hrw-step card detail-card">
          <h3 className="dash-card-title">{t('hrWarn.refuse.title')}</h3>
          <p className="text-sm">{t('hrWarn.refuse.lead')}</p>
          <FormField label={t('hrWarn.refuse.hrManager')} required>
            <FilterSelect ariaLabel={t('hrWarn.refuse.hrManager')} value={hrManagerId}
              options={[{ value: '', label: t('hrWarn.refuse.pickHrManager') }, ...managers.map((u) => ({ value: u.id, label: u.name }))]}
              onChange={setHrManagerId} />
          </FormField>
          <SignatureCapture ref={padRef} words={sigWords} />
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={() => setStep(null)} disabled={busy}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-danger" onClick={refuse} disabled={busy}>{t('hrWarn.refuse.submit')}</button>
          </div>
        </section>
      )}

      {step === 'void' && (
        <section className="hrw-step card detail-card">
          <h3 className="dash-card-title">{t('hrWarn.void.title')}</h3>
          <p className="text-sm">{t('hrWarn.void.lead')}</p>
          <FormField label={t('hrWarn.void.reason')} as="textarea" rows={3} required value={voidReason}
            maxLength={WARNING_TEXT_MAX.voidReason} onChange={(e) => setVoidReason(e.target.value)} />
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={() => setStep(null)} disabled={busy}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-danger" onClick={doVoid} disabled={busy}>{t('hrWarn.void.submit')}</button>
          </div>
        </section>
      )}

      {/* ── the actions ── */}
      {!step && (
        <div className="modal-actions hrw-actions">
          {mode === 'employee' && t.lang !== 'en' && (
            <button type="button" className="btn btn-outline" onClick={translate} disabled={busy}>
              {showTranslated ? t('hrWarn.action.showOriginal') : t('hrWarn.action.translate')}
            </button>
          )}
          {mode === 'office' && (
            <button type="button" className="btn btn-outline" onClick={() => printWarning(w, t, toast)}>{t('hrWarn.action.print')}</button>
          )}
          {mode === 'office' && canVoid && w.status !== WARNING_STATUS.voided && (
            <button type="button" className="btn btn-outline" onClick={() => open('void')}>{t('hrWarn.action.void')}</button>
          )}
          {mode === 'office' && canEdit && awaiting && (
            <button type="button" className="btn btn-outline" onClick={() => open('refuse')}>{t('hrWarn.action.refused')}</button>
          )}
          {awaiting && (mode === 'employee' || canEdit) && (
            <button type="button" className="btn btn-primary" onClick={() => open('sign')}>
              {mode === 'employee' ? t('hrWarn.mine.open') : t('hrWarn.action.signInPerson')}
            </button>
          )}
          {onClose && <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.close')}</button>}
        </div>
      )}
    </div>
  );
}
