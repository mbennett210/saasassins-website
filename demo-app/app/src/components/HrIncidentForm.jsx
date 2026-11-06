// The "New incident report" form — MATT'S OWN FORM (task #258: "ACCIDENT / INCIDENT REPORT"), his
// seven sections, his questions in his order and his words. The words are catalog lines
// (lib/hrIncidents INCIDENT_FORM_KEYS and the option lists), and the rules are lib/hrIncidents
// `incidentDraftRefusal`, which the server runs too, so the form can never accept what the server
// refuses.
//
//   01  the day it was completed (today, stamped by the server — shown, not editable); who
//       reported it — a team member PICKED (cleaners included) or a typed name for someone not on
//       the team; their job title, filled from their role and changeable.
//   02  the incident's day (never the future) and time; the property — a customer PICKED, or
//       "Somewhere else" and typed (Matt: people "get injured in the streets"); the exact spot; the
//       city / state, filled from the customer and changeable; his eight types (tick any, Other
//       with words); what happened.
//   03  one row per person involved: an employee PICKED (that is what puts the report on their HR
//       card), a visitor or other typed; was anyone injured — and only on Yes, the injury, the
//       treatment and the provider.
//   04  witnesses (on Yes, their names and contact); police (on Yes, the agency and report
//       number); who was notified (tick any, Other with words).
//   05  the actions taken; photos and PDFs, each marked as one of his four kinds — uploaded into
//       this report's own folder in the private hr-files bucket only when the report is filed.
//       An upload the report never takes (a row taken off, the form cancelled) is taken back out;
//       the server refuses that for any file a report already holds.
//   06  the office member submitting it (PICKED: the team shares one login), their signature,
//       "Date signed" (the filing day) and their phone / email, filled from their record.
//   07  is the office's, after filing (Mark reviewed on the report), so the form only says so.
//
// Once filed it is locked (Daniel's pick, 2026-10-27): the form says so at its top. A retried
// filing whose first try landed (its answer lost) gets the report as it was first sent: the files
// picked since go on it, and the notice says nothing else changed.
//
// A tick, pick or answer that opens a box to type in puts the cursor in it (the Shift rule).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';
import { fmtDate, todayKey } from '../lib/dates';
import { SUPERVISOR_ROLES, compareUsersByName, memberRoleEnglish } from '../lib/roles';
import {
  INCIDENT_FORM_KEYS, INCIDENT_SECTIONS, INCIDENT_TYPES, INCIDENT_TYPE_KEYS, INCIDENT_TYPE, ANSWERS, POLICE_ANSWERS,
  ANSWER_KEYS, ANSWER, TREATMENTS, TREATMENT_KEYS, PERSON_KINDS, PERSON_KIND_KEYS, PERSON_KIND, NOTIFIED_LIST,
  NOTIFIED_KEYS, NOTIFIED, DOC_KINDS, DOC_KIND_KEYS, DOC_KIND, INCIDENT_TEXT_MAX, INCIDENT_REFUSAL_KEYS,
  INCIDENT_FILE_MIME, MAX_FILE_BYTES, MAX_FILES, MAX_PEOPLE, INCIDENT_STATUS, incidentDraftRefusal, incidentFileOwner,
  normalizeTypes, normalizeNotified, isIncidentProperty, filesNotOn,
} from '../lib/hrIncidents';
import * as hrIncidentsApi from '../lib/hrIncidentsApi';
import { saveHrFile, removeHrFile, formatBytes } from '../lib/hrFiles';
import Modal from './Modal';
import FormField from './FormField';
import FilterSelect from './FilterSelect';
import Select from './Select';
import Icon from './Icon';
import SignatureCapture from './SignatureCapture';
import { useSignatureWords } from './HrWarningDetail';
import { IDENTITY } from '../brand/identity.generated';

const day = (key) => (key ? fmtDate(`${key}T12:00:00`, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const OTHER_PERSON = '__other';
const ELSEWHERE = '__elsewhere';
let rowSeq = 0;
const rowKey = () => { rowSeq += 1; return `r${rowSeq}`; };

// A refusal the server or the stub named by code, in the reader's language.
export function incidentErrorText(t, err) {
  return errorText(t, err, 'hrInc.saveFailed', INCIDENT_REFUSAL_KEYS);
}

const blankDraft = (presetEmployeeId, submitterId) => ({
  reporterChoice: '',          // a user id, OTHER_PERSON, or '' (none yet)
  reportedByName: '',
  reporterTitle: null,         // null = follow the reporter's role until typed
  incidentDate: todayKey(),
  incidentTime: '',
  propertyChoice: '',          // a customer id, ELSEWHERE, or ''
  propertyName: '',
  exactLocation: '',
  cityState: null,             // null = follow the customer's address until typed
  types: [],
  typeOther: '',
  whatHappened: '',
  people: presetEmployeeId ? [{ key: rowKey(), kind: PERSON_KIND.employee, userId: presetEmployeeId, name: '' }] : [],
  injured: '',
  injuryDescription: '',
  treatment: '',
  treatmentProvider: '',
  witnesses: '',
  witnessNames: '',
  witnessContact: '',
  police: '',
  policeDetails: '',
  notified: [],
  notifiedOther: '',
  actionsTaken: '',
  files: [],                   // [{ key, file, kind }]
  submittedByUserId: submitterId || '',
  submitterContact: null,      // null = follow the submitter's record until typed
});

// A segmented single choice (the warning form's level picker shape).
function Choice({ label, value, options, onChange }) {
  return (
    <div className="tab-container-line hri-choice" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className={`tab-btn ${value === o.value ? 'active' : ''}`} aria-pressed={value === o.value}
          onClick={() => onChange(value === o.value ? '' : o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// One of his numbered section headings (the form and the read view).
export function SectionTitle({ n, t }) {
  const s = INCIDENT_SECTIONS.find((x) => x.n === n);
  return <h3 className="hri-sec-title"><span className="hri-sec-n">{n}</span>{t(s.key)}</h3>;
}

// The picked files ({ key, file, kind }) into the report's own folder, each once: `cache` keeps
// what is already up by row key, so a retry never uploads twice. Answers the files' metadata.
export async function uploadRows(rows, incidentId, cache) {
  const out = [];
  for (const f of rows) {
    let rec = cache.get(f.key);
    if (!rec) {
      rec = await saveHrFile(f.file, { kind: 'document', ownerId: incidentFileOwner(incidentId) });
      cache.set(f.key, rec);
    }
    out.push({ kind: f.kind, fileId: rec.id, name: rec.name, mimeType: rec.mimeType, sizeBytes: rec.sizeBytes, storagePath: rec.storagePath || null });
  }
  return out;
}

// Uploads the report never took (`keys`, or every one in `cache`) back out of the bucket, best
// effort. The server refuses any a report already holds, so this never takes a filed file off.
export function dropUploads(cache, incidentId, keys = [...cache.keys()]) {
  for (const k of keys) {
    const rec = cache.get(k);
    if (!rec) continue;
    cache.delete(k);
    removeHrFile(rec.id, { storagePath: rec.storagePath, ownerId: incidentFileOwner(incidentId) }).catch(() => {});
  }
}

export default function HrIncidentForm({ open, onClose, onFiled, presetEmployeeId = null, users = [], clients = [], currentUserId = null }) {
  const t = useT();
  const F = (field) => t(INCIDENT_FORM_KEYS[field]);
  const sigWords = useSignatureWords();
  const people = useMemo(() => users.filter((u) => u.status === 'active').slice().sort(compareUsersByName), [users]);
  const managers = useMemo(() => people.filter((u) => SUPERVISOR_ROLES.includes(u.role)), [people]);
  const customers = useMemo(() => (clients || []).filter(isIncidentProperty).slice()
    .sort((a, b) => a.name.localeCompare(b.name)), [clients]);
  const byId = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u])), [users]);
  const defaultSubmitter = managers.some((u) => u.id === currentUserId) ? currentUserId : '';
  const [id, setId] = useState(() => hrIncidentsApi.newIncidentId());
  const [d, setD] = useState(() => blankDraft(presetEmployeeId, defaultSubmitter));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // The box a tick, pick or answer just opened, which takes the cursor as it appears.
  const [reveal, setReveal] = useState(null);
  const padRef = useRef(null);
  const fileRef = useRef(null);
  // Files already uploaded for this report (by row key), so a retried filing never uploads twice.
  const uploaded = useRef(new Map());
  const today = todayKey();

  // A fresh form (and a fresh report id) each time it opens, for whoever it was opened for.
  useEffect(() => {
    if (open) {
      setId(hrIncidentsApi.newIncidentId());
      setD(blankDraft(presetEmployeeId, defaultSubmitter));
      setError(null);
      setReveal(null);
      uploaded.current = new Map();
    }
  }, [open, presetEmployeeId, defaultSubmitter]);

  // Closed without filing: what was uploaded for it comes back out (never while a filing runs).
  const cancel = () => {
    if (!busy) dropUploads(uploaded.current, id);
    onClose && onClose();
  };

  const set = (patch) => setD((prev) => ({ ...prev, ...patch }));
  const reporter = d.reporterChoice && d.reporterChoice !== OTHER_PERSON ? byId[d.reporterChoice] : null;
  const reporterTitle = d.reporterTitle ?? (reporter ? memberRoleEnglish(reporter) : '');
  const client = d.propertyChoice && d.propertyChoice !== ELSEWHERE ? customers.find((c) => c.id === d.propertyChoice) : null;
  const clientPlace = client ? [client.city, client.state].filter(Boolean).join(', ') : '';
  const cityState = d.cityState ?? clientPlace;
  const submitter = d.submittedByUserId ? byId[d.submittedByUserId] : null;
  const submitterContact = d.submitterContact ?? (submitter ? (submitter.phone || submitter.email || '') : '');

  const toggle = (field, code, normalize, opens = null) => {
    if (opens && !d[field].includes(code)) setReveal(opens);
    setD((prev) => ({
      ...prev,
      [field]: prev[field].includes(code) ? prev[field].filter((x) => x !== code) : normalize([...prev[field], code]),
    }));
  };
  // A Yes that opens its follow-up box.
  const answer = (field, v, opens) => {
    if (v === ANSWER.yes) setReveal(opens);
    set({ [field]: v });
  };
  const setPerson = (key, patch) => setD((prev) => ({ ...prev, people: prev.people.map((p) => (p.key === key ? { ...p, ...patch } : p)) }));
  const addPerson = () => setD((prev) => (prev.people.length >= MAX_PEOPLE ? prev
    : { ...prev, people: [...prev.people, { key: rowKey(), kind: PERSON_KIND.employee, userId: '', name: '' }] }));
  const removePerson = (key) => setD((prev) => ({ ...prev, people: prev.people.filter((p) => p.key !== key) }));

  const pickFiles = (e) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = '';
    if (!picked.length) return;
    const bad = picked.some((f) => !INCIDENT_FILE_MIME.includes(f.type) || f.size > MAX_FILE_BYTES);
    if (bad) { setError(t(INCIDENT_REFUSAL_KEYS['file-bad'])); return; }
    setError(null);
    setD((prev) => {
      const room = Math.max(0, MAX_FILES - prev.files.length);
      if (picked.length > room) setError(t(INCIDENT_REFUSAL_KEYS['files-too-many']));
      const rows = picked.slice(0, room).map((file) => ({
        key: rowKey(), file, kind: (file.type || '').startsWith('image/') ? DOC_KIND.photos : '',
      }));
      return { ...prev, files: [...prev.files, ...rows] };
    });
  };
  const setFileKind = (key, kind) => setD((prev) => ({ ...prev, files: prev.files.map((f) => (f.key === key ? { ...f, kind } : f)) }));
  const removeFile = (key) => {
    dropUploads(uploaded.current, id, [key]);
    setD((prev) => ({ ...prev, files: prev.files.filter((f) => f.key !== key) }));
  };

  const submit = async () => {
    const pad = padRef.current;
    const signature = pad && !pad.isEmpty() ? pad.toDataURL() : '';
    const payload = {
      id,
      reportedByUserId: reporter ? reporter.id : '',
      reportedByName: d.reporterChoice === OTHER_PERSON ? d.reportedByName : (reporter ? reporter.name : ''),
      reporterTitle,
      incidentDate: d.incidentDate,
      incidentTime: d.incidentTime,
      clientId: client ? client.id : '',
      propertyName: d.propertyChoice === ELSEWHERE ? d.propertyName : (client ? client.name : ''),
      exactLocation: d.exactLocation,
      cityState,
      types: d.types,
      typeOther: d.types.includes(INCIDENT_TYPE.other) ? d.typeOther : '',
      whatHappened: d.whatHappened,
      people: d.people.map((p) => (p.kind === PERSON_KIND.employee
        ? { kind: p.kind, userId: p.userId, name: byId[p.userId]?.name || '' }
        : { kind: p.kind, userId: null, name: p.name })),
      injured: d.injured,
      injuryDescription: d.injuryDescription,
      treatment: d.treatment,
      treatmentProvider: d.treatmentProvider,
      witnesses: d.witnesses,
      witnessNames: d.witnessNames,
      witnessContact: d.witnessContact,
      police: d.police,
      policeDetails: d.policeDetails,
      notified: d.notified,
      notifiedOther: d.notified.includes(NOTIFIED.other) ? d.notifiedOther : '',
      actionsTaken: d.actionsTaken,
      submittedByUserId: d.submittedByUserId,
      submitterContact,
      signature,
    };
    // The answers first (the files are checked once they have their place in the bucket).
    const code = incidentDraftRefusal(payload, today);
    if (code) { setError(t(INCIDENT_REFUSAL_KEYS[code])); return; }
    if (d.files.some((f) => !DOC_KINDS.includes(f.kind))) { setError(t(INCIDENT_REFUSAL_KEYS['file-bad'])); return; }
    setBusy(true);
    setError(null);
    try {
      const ctx = { users, clients, currentUserId };
      const files = await uploadRows(d.files, id, uploaded.current);
      const { incident, created } = await hrIncidentsApi.createIncident({ ...payload, files }, ctx);
      let shown = incident;
      // The first try landed and its answer was lost: the report stands as first sent (locked).
      // The files picked since go on it now; the caller says nothing else was saved.
      const extra = created === false && incident ? filesNotOn(files, incident.files) : [];
      if (extra.length && incident.status !== INCIDENT_STATUS.voided) {
        shown = (await hrIncidentsApi.addIncidentFiles(incident.id, extra, ctx)) || incident;
      }
      uploaded.current = new Map();   // on the report now: never "taken back"
      onFiled && onFiled(shown, { created: created !== false });
    } catch (e) {
      setError(incidentErrorText(t, e));
    } finally { setBusy(false); }
  };

  const answerOptions = (list) => list.map((a) => ({ value: a, label: t(ANSWER_KEYS[a]) }));

  return (
    <Modal open={open} onClose={cancel} title={F('title')} size="lg">
      <div className="hri-form">
        <div className="hri-form-head">
          <p className="hri-form-sub">{t(INCIDENT_FORM_KEYS.subtitle, { company: IDENTITY.name })}</p>
          <p className="text-sm text-muted">{F('lead')}</p>
          <p className="text-sm text-muted">{t('hrInc.form.lockedNote')}</p>
        </div>

        {/* 01 REPORT DETAILS */}
        <section className="hri-sec">
          <SectionTitle n="01" t={t} />
          <div className="hri-row">
            <FormField label={F('reportedOn')}>
              <input className="input" value={day(today)} readOnly aria-readonly="true" />
            </FormField>
            <FormField label={F('reportedBy')} required>
              <FilterSelect ariaLabel={F('reportedBy')} value={d.reporterChoice}
                options={[{ value: '', label: t('hrInc.form.pickPerson') }, ...people.map((u) => ({ value: u.id, label: u.name })),
                  { value: OTHER_PERSON, label: t('hrInc.form.notOnTeam') }]}
                onChange={(v) => { if (v === OTHER_PERSON) setReveal('reporterName'); set({ reporterChoice: v, reporterTitle: null }); }} />
            </FormField>
            <FormField label={F('reporterTitle')} value={reporterTitle} maxLength={INCIDENT_TEXT_MAX.reporterTitle}
              onChange={(e) => set({ reporterTitle: e.target.value })} />
          </div>
          {d.reporterChoice === OTHER_PERSON && (
            <input className="input" value={d.reportedByName} maxLength={INCIDENT_TEXT_MAX.reportedByName}
              aria-label={F('reportedBy')} placeholder={t('hrInc.form.fullName')} autoFocus={reveal === 'reporterName'}
              onChange={(e) => set({ reportedByName: e.target.value })} />
          )}
        </section>

        {/* 02 INCIDENT INFORMATION */}
        <section className="hri-sec">
          <SectionTitle n="02" t={t} />
          <div className="hri-row">
            <FormField label={F('incidentDate')} type="date" required value={d.incidentDate} max={today}
              onChange={(e) => set({ incidentDate: e.target.value })} />
            <FormField label={F('incidentTime')} type="time" value={d.incidentTime}
              onChange={(e) => set({ incidentTime: e.target.value })} />
            <FormField label={F('property')} required>
              <FilterSelect ariaLabel={F('property')} value={d.propertyChoice}
                options={[{ value: '', label: t('hrInc.form.pickProperty') }, ...customers.map((c) => ({ value: c.id, label: c.name })),
                  { value: ELSEWHERE, label: t('hrInc.form.elsewhere') }]}
                onChange={(v) => { if (v === ELSEWHERE) setReveal('placeName'); set({ propertyChoice: v, cityState: null }); }} />
            </FormField>
          </div>
          {d.propertyChoice === ELSEWHERE && (
            <input className="input" value={d.propertyName} maxLength={INCIDENT_TEXT_MAX.propertyName}
              aria-label={F('property')} placeholder={t('hrInc.form.placeName')} autoFocus={reveal === 'placeName'}
              onChange={(e) => set({ propertyName: e.target.value })} />
          )}
          <div className="hri-row hri-row-wide">
            <FormField label={F('exactLocation')} value={d.exactLocation} maxLength={INCIDENT_TEXT_MAX.exactLocation}
              onChange={(e) => set({ exactLocation: e.target.value })} />
            <FormField label={F('cityState')} value={cityState} maxLength={INCIDENT_TEXT_MAX.cityState}
              onChange={(e) => set({ cityState: e.target.value })} />
          </div>
          <fieldset className="hri-ticks">
            <legend className="form-label">{F('types')}<span className="form-required" aria-hidden> *</span></legend>
            {INCIDENT_TYPES.map((x) => (
              <label key={x} className="hri-tick">
                <input type="checkbox" checked={d.types.includes(x)}
                  onChange={() => toggle('types', x, normalizeTypes, x === INCIDENT_TYPE.other ? 'typeOther' : null)} />
                <span>{t(INCIDENT_TYPE_KEYS[x])}</span>
              </label>
            ))}
            {d.types.includes(INCIDENT_TYPE.other) && (
              <input className="input hri-tick-other" value={d.typeOther} maxLength={INCIDENT_TEXT_MAX.typeOther}
                aria-label={t('hrInc.form.typeOtherWords')} placeholder={t('hrInc.form.typeOtherWords')} autoFocus={reveal === 'typeOther'}
                onChange={(e) => set({ typeOther: e.target.value })} />
            )}
          </fieldset>
          <FormField label={F('whatHappened')} as="textarea" rows={4} required value={d.whatHappened}
            maxLength={INCIDENT_TEXT_MAX.whatHappened} onChange={(e) => set({ whatHappened: e.target.value })} />
        </section>

        {/* 03 PEOPLE INVOLVED & INJURIES */}
        <section className="hri-sec">
          <SectionTitle n="03" t={t} />
          <div className="hri-people">
            <p className="form-label hri-label">{F('people')} · {F('personKind')}</p>
            {d.people.length === 0 && <p className="text-sm text-muted">{t('hrInc.form.noPeople')}</p>}
            {d.people.map((p) => (
              <div key={p.key} className="hri-person">
                <Choice label={F('personKind')} value={p.kind}
                  options={PERSON_KINDS.map((k) => ({ value: k, label: t(PERSON_KIND_KEYS[k]) }))}
                  onChange={(k) => {
                    const kind = k || p.kind;
                    if (kind !== PERSON_KIND.employee && p.kind === PERSON_KIND.employee) setReveal(`person:${p.key}`);
                    setPerson(p.key, { kind });
                  }} />
                <div className="hri-person-who">
                  {p.kind === PERSON_KIND.employee ? (
                    <FilterSelect ariaLabel={F('people')} value={p.userId}
                      options={[{ value: '', label: t('hrInc.form.pickPerson') }, ...people.map((u) => ({ value: u.id, label: u.name }))]}
                      onChange={(v) => setPerson(p.key, { userId: v })} />
                  ) : (
                    <input className="input" value={p.name} maxLength={INCIDENT_TEXT_MAX.personName}
                      aria-label={F('people')} placeholder={t('hrInc.form.fullName')} autoFocus={reveal === `person:${p.key}`}
                      onChange={(e) => setPerson(p.key, { name: e.target.value })} />
                  )}
                </div>
                <button type="button" className="btn-icon" aria-label={t('hrInc.form.removePerson')} title={t('hrInc.form.removePerson')}
                  onClick={() => removePerson(p.key)}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
            {d.people.length < MAX_PEOPLE && (
              <button type="button" className="btn btn-outline hri-add" onClick={addPerson}>
                {t('hrInc.form.addPerson')}
              </button>
            )}
          </div>
          <FormField label={F('injured')} required>
            <Choice label={F('injured')} value={d.injured} options={answerOptions(ANSWERS)} onChange={(v) => answer('injured', v, 'injury')} />
          </FormField>
          {d.injured === ANSWER.yes && (
            <>
              <FormField label={F('injury')} as="textarea" rows={2} required value={d.injuryDescription} autoFocus={reveal === 'injury'}
                maxLength={INCIDENT_TEXT_MAX.injuryDescription} onChange={(e) => set({ injuryDescription: e.target.value })} />
              <FormField label={F('treatment')} required>
                <Choice label={F('treatment')} value={d.treatment}
                  options={TREATMENTS.map((x) => ({ value: x, label: t(TREATMENT_KEYS[x]) }))}
                  onChange={(v) => set({ treatment: v })} />
              </FormField>
              <FormField label={F('provider')} value={d.treatmentProvider} maxLength={INCIDENT_TEXT_MAX.treatmentProvider}
                onChange={(e) => set({ treatmentProvider: e.target.value })} />
            </>
          )}
        </section>

        {/* 04 WITNESSES & NOTIFICATIONS */}
        <section className="hri-sec">
          <SectionTitle n="04" t={t} />
          <FormField label={F('witnesses')} required>
            <Choice label={F('witnesses')} value={d.witnesses} options={answerOptions(ANSWERS)} onChange={(v) => answer('witnesses', v, 'witnessNames')} />
          </FormField>
          {d.witnesses === ANSWER.yes && (
            <div className="hri-row hri-row-wide">
              <FormField label={F('witnessNames')} as="textarea" rows={2} required value={d.witnessNames} autoFocus={reveal === 'witnessNames'}
                maxLength={INCIDENT_TEXT_MAX.witnessNames} onChange={(e) => set({ witnessNames: e.target.value })} />
              <FormField label={F('witnessContact')} as="textarea" rows={2} value={d.witnessContact}
                maxLength={INCIDENT_TEXT_MAX.witnessContact} onChange={(e) => set({ witnessContact: e.target.value })} />
            </div>
          )}
          <FormField label={F('police')} required>
            <Choice label={F('police')} value={d.police} options={answerOptions(POLICE_ANSWERS)} onChange={(v) => answer('police', v, 'policeDetails')} />
          </FormField>
          {d.police === ANSWER.yes && (
            <FormField label={F('policeDetails')} value={d.policeDetails} maxLength={INCIDENT_TEXT_MAX.policeDetails} autoFocus={reveal === 'policeDetails'}
              onChange={(e) => set({ policeDetails: e.target.value })} />
          )}
          <fieldset className="hri-ticks">
            <legend className="form-label">{F('notified')}</legend>
            {NOTIFIED_LIST.map((x) => (
              <label key={x} className="hri-tick">
                <input type="checkbox" checked={d.notified.includes(x)}
                  onChange={() => toggle('notified', x, normalizeNotified, x === NOTIFIED.other ? 'notifiedOther' : null)} />
                <span>{t(NOTIFIED_KEYS[x])}</span>
              </label>
            ))}
            {d.notified.includes(NOTIFIED.other) && (
              <input className="input hri-tick-other" value={d.notifiedOther} maxLength={INCIDENT_TEXT_MAX.notifiedOther}
                aria-label={t('hrInc.form.notifiedOtherWords')} placeholder={t('hrInc.form.notifiedOtherWords')} autoFocus={reveal === 'notifiedOther'}
                onChange={(e) => set({ notifiedOther: e.target.value })} />
            )}
          </fieldset>
        </section>

        {/* 05 IMMEDIATE RESPONSE & DOCUMENTATION */}
        <section className="hri-sec">
          <SectionTitle n="05" t={t} />
          <FormField label={F('actions')} as="textarea" rows={3} value={d.actionsTaken}
            maxLength={INCIDENT_TEXT_MAX.actionsTaken} onChange={(e) => set({ actionsTaken: e.target.value })} />
          <div className="hri-files">
            <div className="hri-files-head">
              <p className="form-label hri-label">{F('docs')}</p>
              <input ref={fileRef} type="file" multiple accept=".pdf,image/png,image/jpeg,image/webp" hidden onChange={pickFiles} />
              {d.files.length < MAX_FILES && (
                <button type="button" className="btn btn-outline" onClick={() => fileRef.current && fileRef.current.click()}>
                  <Icon name="upload" size={14} /> {t('hrInc.form.attach')}
                </button>
              )}
            </div>
            <p className="text-xs text-muted">{t('hrInc.form.attachHint')}</p>
            {d.files.map((f) => (
              <div key={f.key} className="hri-file">
                <Icon name="paperclip" size={14} />
                <span className="hri-file-name" title={f.file.name}>{f.file.name}</span>
                <span className="hri-file-meta">{formatBytes(f.file.size)}</span>
                <div className="hri-file-kind">
                  <Select ariaLabel={t('hrInc.form.fileKind')} value={f.kind} placeholder={t('hrInc.form.fileKind')}
                    options={DOC_KINDS.map((k) => ({ value: k, label: t(DOC_KIND_KEYS[k]) }))}
                    onChange={(k) => setFileKind(f.key, k)} />
                </div>
                <button type="button" className="btn-icon" aria-label={t('hrInc.form.removeFile')} title={t('hrInc.form.removeFile')}
                  onClick={() => removeFile(f.key)} disabled={busy}>
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* 06 SUBMITTED BY */}
        <section className="hri-sec">
          <SectionTitle n="06" t={t} />
          {/* His order: Printed name, Signature, then Date signed and Phone / email. */}
          <div className="hri-row">
            <FormField label={F('printedName')} required>
              <FilterSelect ariaLabel={F('printedName')} value={d.submittedByUserId}
                options={[{ value: '', label: t('hrInc.form.pickSubmitter') }, ...managers.map((u) => ({ value: u.id, label: u.name }))]}
                onChange={(v) => set({ submittedByUserId: v, submitterContact: null })} />
            </FormField>
          </div>
          <div className="hri-sign">
            <p className="form-label hri-label">{F('signature')}<span className="form-required" aria-hidden> *</span></p>
            <SignatureCapture ref={padRef} words={sigWords} />
          </div>
          <div className="hri-row">
            <FormField label={F('signedOn')}>
              <input className="input" value={day(today)} readOnly aria-readonly="true" />
            </FormField>
            <FormField label={F('contact')} value={submitterContact} maxLength={INCIDENT_TEXT_MAX.submitterContact}
              onChange={(e) => set({ submitterContact: e.target.value })} />
          </div>
        </section>

        {/* 07 OFFICE USE ONLY / FOLLOW-UP — the office's, after filing */}
        <section className="hri-sec">
          <SectionTitle n="07" t={t} />
          <p className="text-sm text-muted">{t('hrInc.detail.awaitingReview')}</p>
        </section>

        {error && <div className="callout callout-warning" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={cancel} disabled={busy}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? t('hrInc.form.filing') : t('hrInc.form.submit')}</button>
        </div>
      </div>
    </Modal>
  );
}
