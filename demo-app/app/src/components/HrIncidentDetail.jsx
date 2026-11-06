// One incident report (task #258 from Clean Corner's queue): the read view, and the moves the
// record allows. ONE component for every place a report opens — HR → Incidents and the HR card of
// each employee involved (HR → Employees → the person, Team → member → HR) — so they cannot
// disagree about what a report says or what may be done to it.
//
// It reads as MATT'S OWN FORM: his seven sections and their numbers, his questions as the labels,
// his tick boxes shown as ticks (every option, the ticked ones marked), section 07 filled by the
// review. The people's own words (what happened, the injury, the names) are shown as typed
// (LANG-7).
//
// 🔴 LOCKED ONCE FILED (Daniel's pick, 2026-10-27): there is no Edit here, by design. The moves:
//   · Add files   (hr.edit) — photos and documents that come in later; never removed, never on a
//                 voided report (an upload it never took — the step cancelled — comes back out);
//   · Mark reviewed (hr.edit) — section 07, once: who received and reviewed it (PICKED, the team
//                 shares one login), today as the date received;
//   · Void        (the Super Admin) — with a reason; it stays on file, marked;
//   · Print / Save as PDF — his two pages (lib/hrIncidentDocument).
// Each control shows only to someone the server will let do it (UI_RULES §118).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';
import { english } from '../i18n/core';
import { fmtDate } from '../lib/dates';
import { SUPERVISOR_ROLES, compareUsersByName } from '../lib/roles';
import {
  INCIDENT_FORM_KEYS, INCIDENT_TYPES, INCIDENT_TYPE_KEYS, INCIDENT_TYPE, ANSWERS, POLICE_ANSWERS,
  ANSWER_KEYS, TREATMENTS, TREATMENT_KEYS, PERSON_KIND_KEYS, PERSON_KIND, NOTIFIED_LIST, NOTIFIED_KEYS, NOTIFIED,
  DOC_KINDS, DOC_KIND_KEYS, DOC_KIND, INCIDENT_STATUS, INCIDENT_STATUS_KEYS, INCIDENT_STATUS_VARIANTS,
  INCIDENT_TEXT_MAX, INCIDENT_REFUSAL_KEYS, INCIDENT_FILE_MIME, MAX_FILE_BYTES, MAX_FILES,
  normalizePeople, docKindsOf, incidentCaseNo, incidentFileOwner, timeAmPm,
} from '../lib/hrIncidents';
import { buildIncidentDocumentHtml } from '../lib/hrIncidentDocument';
import * as hrIncidentsApi from '../lib/hrIncidentsApi';
import { getHrFile, formatBytes } from '../lib/hrFiles';
import { IDENTITY } from '../brand/identity.generated';
import Badge from './Badge';
import FormField from './FormField';
import FilterSelect from './FilterSelect';
import Select from './Select';
import Icon from './Icon';
import { useToast } from './Toast';
import { incidentErrorText, SectionTitle, uploadRows, dropUploads } from './HrIncidentForm';

const day = (key) => (key ? fmtDate(`${key}T12:00:00`, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
let rowSeq = 0;
const rowKey = () => { rowSeq += 1; return `f${rowSeq}`; };

// Hand his form to the browser's print dialog ("Save as PDF"). The window opens FIRST, inside the
// click, or a pop-up blocker refuses it. His form is English only, so the printout is too.
function printIncident(r, t, toast) {
  const win = window.open('', '_blank');
  if (!win) { toast.error(t('hrInc.printBlocked')); return; }
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${english(INCIDENT_FORM_KEYS.title)}</title></head><body>${buildIncidentDocumentHtml(r)}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}

// His tick boxes as he printed them: every option, the ticked ones marked.
function Ticks({ label, all, keys, ticked, t, extra = {} }) {
  const on = new Set(ticked || []);
  return (
    <div className="hri-ticks-read">
      <p className="hri-q">{label}</p>
      <div className="hri-tick-list" role="group" aria-label={label}>
        {all.map((x) => (
          <span key={x} className={on.has(x) ? 'hri-tick-read is-on' : 'hri-tick-read'} role="checkbox" aria-checked={on.has(x)} aria-readonly="true">
            <span className="hri-box" aria-hidden>{on.has(x) && <Icon name="check" size={12} />}</span>
            <span>{t(keys[x])}{on.has(x) && extra[x] ? `: ${extra[x]}` : ''}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Fact({ label, children, wide = false }) {
  return (
    <div className={wide ? 'hri-fact is-wide' : 'hri-fact'}>
      <dt>{label}</dt>
      <dd>{children === null || children === undefined || children === '' ? '—' : children}</dd>
    </div>
  );
}

export default function HrIncidentDetail({
  incidentId, canEdit = false, canVoid = false, users = [], currentUserId = null, onChanged,
}) {
  const t = useT();
  const toast = useToast();
  const [r, setR] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [step, setStep] = useState(null);        // null | 'review' | 'void' | 'files'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reviewerId, setReviewerId] = useState('');
  const [voidReason, setVoidReason] = useState('');
  const [adding, setAdding] = useState([]);      // [{ key, file, kind }]
  const uploaded = useRef(new Map());
  const busyRef = useRef(false);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      setR(await hrIncidentsApi.getIncident(incidentId));
    } catch (e) {
      setLoadError(e);
    }
  }, [incidentId]);
  useEffect(() => { load(); }, [load]);
  // Closed with files uploaded that never went on the report: they come back out of the bucket
  // (never while an add is running; the server refuses any the report holds).
  useEffect(() => {
    const box = uploaded;
    return () => { if (!busyRef.current) dropUploads(box.current, incidentId); };
  }, [incidentId]);

  const ctx = { users, currentUserId };
  const managers = useMemo(() => users
    .filter((u) => u.status === 'active' && SUPERVISOR_ROLES.includes(u.role))
    .slice().sort(compareUsersByName), [users]);
  const nameOf = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u.name])), [users]);

  if (loadError) return <div className="callout callout-warning">{errorText(t, loadError, 'hrInc.loadFailed')}</div>;
  if (!r) return <div className="hrw-loading">{t('hrInc.loading')}</div>;

  const F = (field) => t(INCIDENT_FORM_KEYS[field]);
  const voided = r.status === INCIDENT_STATUS.voided;
  const awaiting = r.status === INCIDENT_STATUS.awaiting;
  const people = normalizePeople(r.people);
  const files = Array.isArray(r.files) ? r.files : [];
  const caseNo = incidentCaseNo(r);

  const run = async (fn, doneKey) => {
    setBusy(true);
    busyRef.current = true;
    setError(null);
    try {
      const next = await fn();
      // The answer is the report as saved (the files answer leaves the signature out: kept).
      if (next) setR((prev) => ({ ...prev, ...next }));
      else await load();
      setStep(null);
      toast.success(t(doneKey));
      onChanged && onChanged();
    } catch (e) {
      setError(incidentErrorText(t, e));
    } finally { setBusy(false); busyRef.current = false; }
  };

  const open = (s) => {
    setError(null);
    if (s === 'review') setReviewerId(managers.some((u) => u.id === currentUserId) ? currentUserId : '');
    if (s === 'files') { setAdding([]); dropUploads(uploaded.current, r.id); }
    setStep(s);
  };

  const review = () => {
    if (!reviewerId) { setError(t(INCIDENT_REFUSAL_KEYS['reviewer-missing'])); return; }
    run(() => hrIncidentsApi.reviewIncident(r.id, { reviewerUserId: reviewerId }, ctx), 'hrInc.review.done');
  };
  const doVoid = () => {
    if (!voidReason.trim()) { setError(t(INCIDENT_REFUSAL_KEYS['void-reason-missing'])); return; }
    run(() => hrIncidentsApi.voidIncident(r.id, { reason: voidReason }, ctx), 'hrInc.void.done');
  };

  const pickFiles = (e) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = '';
    if (!picked.length) return;
    if (picked.some((f) => !INCIDENT_FILE_MIME.includes(f.type) || f.size > MAX_FILE_BYTES)) {
      setError(t(INCIDENT_REFUSAL_KEYS['file-bad'])); return;
    }
    setError(null);
    setAdding((prev) => {
      const room = Math.max(0, MAX_FILES - files.length - prev.length);
      if (picked.length > room) setError(t(INCIDENT_REFUSAL_KEYS['files-too-many']));
      return [...prev, ...picked.slice(0, room).map((file) => ({
        key: rowKey(), file, kind: (file.type || '').startsWith('image/') ? DOC_KIND.photos : '',
      }))];
    });
  };
  const addFiles = () => {
    if (!adding.length) { setError(t(INCIDENT_REFUSAL_KEYS['files-missing'])); return; }
    if (adding.some((f) => !DOC_KINDS.includes(f.kind))) { setError(t(INCIDENT_REFUSAL_KEYS['file-bad'])); return; }
    run(async () => {
      const out = await uploadRows(adding, r.id, uploaded.current);
      const next = await hrIncidentsApi.addIncidentFiles(r.id, out, ctx);
      uploaded.current = new Map();   // on the report now: never "taken back"
      return next;
    }, 'hrInc.addFiles.done');
  };
  const cancelFiles = () => {
    dropUploads(uploaded.current, r.id);
    setAdding([]);
    setStep(null);
  };
  const removeAdding = (key) => {
    dropUploads(uploaded.current, r.id, [key]);
    setAdding((prev) => prev.filter((x) => x.key !== key));
  };

  const openFile = async (f) => {
    const got = await getHrFile(f.fileId, { storagePath: f.storagePath, ownerId: incidentFileOwner(r.id), name: f.name, mimeType: f.mimeType });
    if (!got) { toast.error(t('hrInc.detail.openFailed')); return; }
    const a = document.createElement('a');
    a.href = got.url; a.download = f.name || 'file'; a.target = '_blank'; a.rel = 'noopener';
    a.click();
  };

  return (
    <div className="hri-detail">
      <div className="hri-detail-head">
        {caseNo && <span className="hri-case">{caseNo}</span>}
        <Badge variant={INCIDENT_STATUS_VARIANTS[r.status] || 'slate'}>{t(INCIDENT_STATUS_KEYS[r.status] || 'hrInc.status.awaiting')}</Badge>
        <span className="hri-detail-sub">{t(INCIDENT_FORM_KEYS.subtitle, { company: IDENTITY.name })}</span>
      </div>

      {voided && (
        <div className="callout callout-warning">
          {t('hrInc.detail.voided', { name: r.voidedByName || '—', when: r.voidedAt, reason: r.voidReason || '' })}
        </div>
      )}

      {/* 01 REPORT DETAILS */}
      <section className="hri-sec">
        <SectionTitle n="01" t={t} />
        <dl className="hri-facts">
          <Fact label={F('reportedOn')}>{day(r.reportedOn)}</Fact>
          <Fact label={F('reportedBy')}>{r.reportedByName}</Fact>
          <Fact label={F('reporterTitle')}>{r.reporterTitle}</Fact>
        </dl>
      </section>

      {/* 02 INCIDENT INFORMATION */}
      <section className="hri-sec">
        <SectionTitle n="02" t={t} />
        <dl className="hri-facts">
          <Fact label={F('incidentDate')}>{day(r.incidentDate)}</Fact>
          <Fact label={F('incidentTime')}>{r.incidentTime ? timeAmPm(r.incidentTime) : null}</Fact>
          <Fact label={F('property')}>{r.propertyName}</Fact>
          <Fact label={F('exactLocation')} wide>{r.exactLocation}</Fact>
          <Fact label={F('cityState')}>{r.cityState}</Fact>
        </dl>
        <Ticks label={F('types')} all={INCIDENT_TYPES} keys={INCIDENT_TYPE_KEYS} ticked={r.types} t={t}
          extra={{ [INCIDENT_TYPE.other]: r.typeOther }} />
        <div className="hri-words">
          <p className="hri-q">{F('whatHappened')}</p>
          <p>{r.whatHappened || '—'}</p>
        </div>
      </section>

      {/* 03 PEOPLE INVOLVED & INJURIES */}
      <section className="hri-sec">
        <SectionTitle n="03" t={t} />
        <div className="hri-people-read">
          <p className="hri-q">{F('people')} · {F('personKind')}</p>
          {people.length === 0 ? <p className="text-sm text-muted">—</p> : (
            <ul className="hri-people-list">
              {people.map((p, i) => (
                // Keyed by place: a filed report's list never changes, and one employee may be listed twice.
                <li key={i}>
                  <span>{(p.kind === PERSON_KIND.employee && (p.name || nameOf[p.userId])) || p.name || '—'}</span>
                  <span className="text-muted"> · {t(PERSON_KIND_KEYS[p.kind])}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Ticks label={F('injured')} all={ANSWERS} keys={ANSWER_KEYS} ticked={r.injured ? [r.injured] : []} t={t} />
        <div className="hri-words">
          <p className="hri-q">{F('injury')}</p>
          <p>{r.injuryDescription || '—'}</p>
        </div>
        <Ticks label={F('treatment')} all={TREATMENTS} keys={TREATMENT_KEYS} ticked={r.treatment ? [r.treatment] : []} t={t} />
        <dl className="hri-facts">
          <Fact label={F('provider')} wide>{r.treatmentProvider}</Fact>
        </dl>
      </section>

      {/* 04 WITNESSES & NOTIFICATIONS */}
      <section className="hri-sec">
        <SectionTitle n="04" t={t} />
        <Ticks label={F('witnesses')} all={ANSWERS} keys={ANSWER_KEYS} ticked={r.witnesses ? [r.witnesses] : []} t={t} />
        <dl className="hri-facts">
          <Fact label={F('witnessNames')} wide>{r.witnessNames ? <span className="hri-pre">{r.witnessNames}</span> : null}</Fact>
          <Fact label={F('witnessContact')} wide>{r.witnessContact ? <span className="hri-pre">{r.witnessContact}</span> : null}</Fact>
        </dl>
        <Ticks label={F('police')} all={POLICE_ANSWERS} keys={ANSWER_KEYS} ticked={r.police ? [r.police] : []} t={t} />
        <dl className="hri-facts">
          <Fact label={F('policeDetails')} wide>{r.policeDetails}</Fact>
        </dl>
        <Ticks label={F('notified')} all={NOTIFIED_LIST} keys={NOTIFIED_KEYS} ticked={r.notified} t={t}
          extra={{ [NOTIFIED.other]: r.notifiedOther }} />
      </section>

      {/* 05 IMMEDIATE RESPONSE & DOCUMENTATION */}
      <section className="hri-sec">
        <SectionTitle n="05" t={t} />
        <div className="hri-words">
          <p className="hri-q">{F('actions')}</p>
          <p>{r.actionsTaken || '—'}</p>
        </div>
        <Ticks label={F('docs')} all={DOC_KINDS} keys={DOC_KIND_KEYS} ticked={docKindsOf(files)} t={t} />
        {files.length === 0 ? <p className="text-sm text-muted">{t('hrInc.detail.noFiles')}</p> : (
          <ul className="hri-file-list">
            {files.map((f) => (
              <li key={f.id || f.storagePath || f.fileId} className="hri-file">
                <Icon name="paperclip" size={14} />
                <button type="button" className="linklike hri-file-name" title={f.name} onClick={() => openFile(f)}>{f.name}</button>
                <span className="hri-file-meta">
                  {t(DOC_KIND_KEYS[f.kind] || 'hrInc.doc.other')}
                  {f.sizeBytes ? ` · ${formatBytes(f.sizeBytes)}` : ''}
                  {f.addedAt ? ` · ${t('hrInc.detail.added', { when: f.addedAt })}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 06 SUBMITTED BY */}
      <section className="hri-sec">
        <SectionTitle n="06" t={t} />
        {/* His order: Printed name, Signature, then Date signed and Phone / email. */}
        <dl className="hri-facts">
          <Fact label={F('printedName')}>{r.submittedByName}</Fact>
        </dl>
        <div className="hri-sign-read">
          <p className="hri-q">{F('signature')}</p>
          {r.submitterSignature
            ? <img className="hrw-sig" src={r.submitterSignature} alt={t('hrInc.detail.signatureAlt', { name: r.submittedByName || '—' })} />
            : <p className="text-sm text-muted">—</p>}
        </div>
        <dl className="hri-facts">
          <Fact label={F('signedOn')}>{day(r.signedOn)}</Fact>
          <Fact label={F('contact')}>{r.submitterContact}</Fact>
        </dl>
      </section>

      {/* 07 OFFICE USE ONLY / FOLLOW-UP */}
      <section className="hri-sec">
        <SectionTitle n="07" t={t} />
        <dl className="hri-facts">
          <Fact label={F('reviewedBy')}>{r.reviewedByName || (awaiting ? t('hrInc.detail.awaitingReview') : null)}</Fact>
          <Fact label={F('receivedOn')}>{day(r.receivedOn)}</Fact>
          <Fact label={F('caseNo')}>{caseNo}</Fact>
        </dl>
      </section>

      {error && <div className="callout callout-warning" role="alert">{error}</div>}

      {/* ── the steps ── */}
      {step === 'review' && (
        <section className="hrw-step card detail-card">
          <h3 className="dash-card-title">{t('hrInc.review.title')}</h3>
          <p className="text-sm">{t('hrInc.review.lead')}</p>
          <FormField label={F('reviewedBy')} required>
            <FilterSelect ariaLabel={F('reviewedBy')} value={reviewerId}
              options={[{ value: '', label: t('hrInc.review.pick') }, ...managers.map((u) => ({ value: u.id, label: u.name }))]}
              onChange={setReviewerId} />
          </FormField>
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={() => setStep(null)} disabled={busy}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-primary" onClick={review} disabled={busy}>{t('hrInc.review.submit')}</button>
          </div>
        </section>
      )}

      {step === 'files' && (
        <section className="hrw-step card detail-card">
          <h3 className="dash-card-title">{t('hrInc.addFiles.title')}</h3>
          <p className="text-sm">{t('hrInc.addFiles.lead')}</p>
          <input ref={fileRef} type="file" multiple accept=".pdf,image/png,image/jpeg,image/webp" hidden onChange={pickFiles} />
          <div className="hri-files-head">
            <p className="text-xs text-muted">{t('hrInc.form.attachHint')}</p>
            {files.length + adding.length < MAX_FILES && (
              <button type="button" className="btn btn-outline" onClick={() => fileRef.current && fileRef.current.click()} disabled={busy}>
                <Icon name="upload" size={14} /> {t('hrInc.form.attach')}
              </button>
            )}
          </div>
          {adding.map((f) => (
            <div key={f.key} className="hri-file">
              <Icon name="paperclip" size={14} />
              <span className="hri-file-name" title={f.file.name}>{f.file.name}</span>
              <span className="hri-file-meta">{formatBytes(f.file.size)}</span>
              <div className="hri-file-kind">
                <Select ariaLabel={t('hrInc.form.fileKind')} value={f.kind} placeholder={t('hrInc.form.fileKind')}
                  options={DOC_KINDS.map((k) => ({ value: k, label: t(DOC_KIND_KEYS[k]) }))}
                  onChange={(k) => setAdding((prev) => prev.map((x) => (x.key === f.key ? { ...x, kind: k } : x)))} />
              </div>
              <button type="button" className="btn-icon" aria-label={t('hrInc.form.removeFile')} title={t('hrInc.form.removeFile')}
                onClick={() => removeAdding(f.key)} disabled={busy}>
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={cancelFiles} disabled={busy}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-primary" onClick={addFiles} disabled={busy || !adding.length}>
              {busy ? t('hrInc.addFiles.uploading') : t('hrInc.addFiles.submit')}
            </button>
          </div>
        </section>
      )}

      {step === 'void' && (
        <section className="hrw-step card detail-card">
          <h3 className="dash-card-title">{t('hrInc.void.title')}</h3>
          <p className="text-sm">{t('hrInc.void.lead')}</p>
          <FormField label={t('hrInc.void.reason')} as="textarea" rows={3} required value={voidReason}
            maxLength={INCIDENT_TEXT_MAX.voidReason} onChange={(e) => setVoidReason(e.target.value)} />
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={() => setStep(null)} disabled={busy}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-danger" onClick={doVoid} disabled={busy}>{t('hrInc.void.submit')}</button>
          </div>
        </section>
      )}

      {/* ── the actions ── */}
      {!step && (
        <div className="modal-actions hrw-actions">
          <button type="button" className="btn btn-outline" onClick={() => printIncident(r, t, toast)}>{t('hrInc.action.print')}</button>
          {canVoid && !voided && (
            <button type="button" className="btn btn-outline" onClick={() => open('void')}>{t('hrInc.action.void')}</button>
          )}
          {canEdit && !voided && files.length < MAX_FILES && (
            <button type="button" className="btn btn-outline" onClick={() => open('files')}>{t('hrInc.action.addFiles')}</button>
          )}
          {canEdit && awaiting && (
            <button type="button" className="btn btn-primary" onClick={() => open('review')}>{t('hrInc.action.review')}</button>
          )}
        </div>
      )}
    </div>
  );
}
