// HR INCIDENT REPORTS — the pure rules and the printed form (task #258 from Clean Corner's queue,
// 2026-10-27: Matt's "ACCIDENT / INCIDENT REPORT", in HR, set up like warnings). Offline.
//
// What it pins, each against the module's own constants (never a restated literal):
//   1. 🔴 MATT'S OWN FORM. The catalog's English, walked in INCIDENT_FORM_ORDER, IS the text of
//      his PDF, page by page (scripts/fixtures/hr-incident-form.json, pulled out of the PDF with
//      `pdftotext -raw`): every heading and its number, every question, every tick box in his
//      order, the header lines on both pages and the footer.
//   2. every line of his form is USED: the form asks every question of sections 01–06 (07 is the
//      office's, after filing), the read view shows every question of all seven, and the
//      printout carries every line, both pages.
//   3. the rules the form and the server share: what is required, what a Yes makes required,
//      "Other" needs words, no future incident date, the time's shape, the limits, the files.
//   4. what a filed report keeps: a follow-up answer only when its question was Yes, "Other"'s
//      words only when Other is ticked, the people, the employees involved.
//   5. the case number: IR-0001, from the database's number.
//   6. the printout ticks exactly what was ticked, escapes what was typed, prints only a PNG
//      signature, and says when a report was voided.
//   7. a report's files live under their own owner; hr-files never deletes one a report holds,
//      and a retried add attaches nothing twice.
//   8. the property is a customer we clean for (never a supplier, never archived), and a tick,
//      pick or answer that opens a box puts the cursor in it.
//
//   node app/scripts/test-hr-incidents.mjs
let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond) — stated because this repo's suites disagree.
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const { readFileSync } = await import('node:fs');
let I = null;
try { I = await import('../src/lib/hrIncidents.js'); } catch (e) { fails.push(`lib/hrIncidents.js loads (${e.code || e.message})`); }
let D = null;
try { D = await import('../src/lib/hrIncidentDocument.js'); } catch (e) { fails.push(`lib/hrIncidentDocument.js loads (${e.code || e.message})`); }
let catalog = {};
try { catalog = (await import('../src/i18n/catalog/en.js')).default; } catch { fails.push('the English catalog loads'); }
let IDENTITY = null;
try { ({ IDENTITY } = await import('../src/brand/identity.generated.js')); } catch { fails.push('the brand identity loads'); }
const FORM = JSON.parse(readFileSync(new URL('./fixtures/hr-incident-form.json', import.meta.url), 'utf8'));
const src = (rel) => { try { return readFileSync(new URL(rel, import.meta.url), 'utf8'); } catch { return ''; } };

// A catalog line with its {placeholders} filled.
const fill = (key, params = {}) => String(catalog[key] ?? `«missing ${key}»`).replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`));
const squash = (s) => String(s).replace(/\s+/g, ' ').trim();

if (I) {
  const {
    INCIDENT_FORM_KEYS, INCIDENT_FORM_ORDER, INCIDENT_SECTIONS, INCIDENT_TYPES, INCIDENT_TYPE, INCIDENT_TYPE_KEYS,
    ANSWERS, ANSWER, POLICE_ANSWERS, ANSWER_KEYS, TREATMENTS, TREATMENT, TREATMENT_KEYS, PERSON_KINDS, PERSON_KIND,
    PERSON_KIND_KEYS, NOTIFIED_LIST, NOTIFIED, NOTIFIED_KEYS, DOC_KINDS, DOC_KIND, DOC_KIND_KEYS, INCIDENT_STATUSES,
    INCIDENT_STATUS, INCIDENT_STATUS_KEYS, INCIDENT_STATUS_VARIANTS, INCIDENT_TEXT_MAX, INCIDENT_REFUSAL_KEYS,
    MAX_PEOPLE, MAX_FILES, MAX_FILE_BYTES, INCIDENT_FILE_MIME,
    incidentDraftRefusal, incidentAnswers, incidentCaseNo, timeAmPm, normalizeFile, filesRefusal,
    incidentFileOwner, isIncidentFileOwner, isIncidentId, involvedUserIds, docKindsOf, typesText, peopleText,
    incidentIdOfOwner, filesNotOn, isIncidentProperty,
  } = I;

  // ── 1. 🔴 his form, page by page ───────────────────────────────────────────
  ok('the fixture holds his two pages', Array.isArray(FORM.pages) && FORM.pages.length === 2);
  ok('the brand name on his form is the app\'s brand name (IDENTITY.name)', IDENTITY && FORM.company === IDENTITY.name);
  const sectionNo = Object.fromEntries(INCIDENT_SECTIONS.map((s) => [s.key, s.n]));
  const line = (key, page) => {
    if (key === INCIDENT_FORM_KEYS.subtitle) return fill(key, { company: FORM.company });
    if (key === INCIDENT_FORM_KEYS.page) return fill(key, { page, pages: 2 });
    if (key === INCIDENT_FORM_KEYS.footer) return `${fill(key)} ${FORM.company}`;
    return sectionNo[key] ? `${sectionNo[key]} ${fill(key)}` : fill(key);
  };
  const HEADER = [INCIDENT_FORM_KEYS.title, INCIDENT_FORM_KEYS.subtitle, INCIDENT_FORM_KEYS.lead, INCIDENT_FORM_KEYS.page];
  ok('the order starts with his header (title, subtitle, lead, page)', HEADER.every((k, i) => INCIDENT_FORM_ORDER[i] === k));
  const footAt = INCIDENT_FORM_ORDER.indexOf(INCIDENT_FORM_KEYS.footer);
  ok('page one ends at his footer, after section 03', footAt > INCIDENT_FORM_ORDER.indexOf(INCIDENT_FORM_KEYS.s03)
    && footAt < INCIDENT_FORM_ORDER.indexOf(INCIDENT_FORM_KEYS.s04));
  const page1 = [...INCIDENT_FORM_ORDER.slice(0, footAt + 1)];
  const page2 = [...HEADER, ...INCIDENT_FORM_ORDER.slice(footAt + 1), INCIDENT_FORM_KEYS.footer];
  const want1 = squash(page1.map((k) => line(k, 1)).join(' '));
  const want2 = squash(page2.map((k) => line(k, 2)).join(' '));
  const got1 = squash(FORM.pages[0].join(' '));
  const got2 = squash(FORM.pages[1].join(' '));
  ok(`🔴 page 1 of his PDF, word for word, is the catalog in his order${want1 === got1 ? '' : `\n      want: ${want1}\n      got:  ${got1}`}`, want1 === got1);
  ok(`🔴 page 2 of his PDF, word for word, is the catalog in his order${want2 === got2 ? '' : `\n      want: ${want2}\n      got:  ${got2}`}`, want2 === got2);
  ok('every key of his form is a line in the English catalog', Object.values(INCIDENT_FORM_KEYS).every((k) => typeof catalog[k] === 'string'));
  ok('every key of his form is in the order once (the header and footer aside)',
    Object.values(INCIDENT_FORM_KEYS).every((k) => INCIDENT_FORM_ORDER.includes(k))
    && new Set(INCIDENT_FORM_ORDER.filter((k) => !Object.values(ANSWER_KEYS).includes(k))).size
      === INCIDENT_FORM_ORDER.filter((k) => !Object.values(ANSWER_KEYS).includes(k)).length);
  ok('his seven sections, 01 to 07', INCIDENT_SECTIONS.map((s) => s.n).join() === '01,02,03,04,05,06,07');
  ok('his eight incident types, his five notified, his four kinds of documents, his four treatments',
    INCIDENT_TYPES.length === 8 && NOTIFIED_LIST.length === 5 && DOC_KINDS.length === 4 && TREATMENTS.length === 4);
  ok('injured and witnesses: Yes / No / Unknown; police: Yes / No',
    ANSWERS.join() === 'yes,no,unknown' && POLICE_ANSWERS.join() === 'yes,no');
  ok('his "Employee / visitor / other" is three kinds', PERSON_KINDS.join() === 'employee,visitor,other');
  const allKeys = [
    ...Object.values(INCIDENT_TYPE_KEYS), ...Object.values(ANSWER_KEYS), ...Object.values(TREATMENT_KEYS),
    ...Object.values(PERSON_KIND_KEYS), ...Object.values(NOTIFIED_KEYS), ...Object.values(DOC_KIND_KEYS),
    ...Object.values(INCIDENT_STATUS_KEYS), ...Object.values(INCIDENT_REFUSAL_KEYS),
  ];
  const missing = allKeys.filter((k) => typeof catalog[k] !== 'string');
  ok(`every option, status and refusal has its English line${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`, missing.length === 0);
  ok('every status has a badge colour', INCIDENT_STATUSES.every((s) => ['amber', 'green', 'slate', 'red', 'blue', 'purple'].includes(INCIDENT_STATUS_VARIANTS[s])));

  // ── 2. every line is used ───────────────────────────────────────────────────
  const formSrc = src('../src/components/HrIncidentForm.jsx');
  const detailSrc = src('../src/components/HrIncidentDetail.jsx');
  const uses = (code, field) => code.includes(`F('${field}')`) || code.includes(`INCIDENT_FORM_KEYS.${field}`);
  const fields = Object.keys(INCIDENT_FORM_KEYS).filter((f) => !/^s0\d$/.test(f));
  // The form: sections 01–06 (07 is filled after filing; the page and footer are the paper's).
  const notOnForm = ['page', 'footer', 'reviewedBy', 'receivedOn', 'caseNo'];
  const formMiss = fields.filter((f) => !notOnForm.includes(f) && !uses(formSrc, f));
  ok(`the form asks every question of sections 01–06${formMiss.length ? ` (not asked: ${formMiss.join(', ')})` : ''}`, formSrc && formMiss.length === 0);
  // The read view: every question of all seven (the title is its dialog's, set where it opens;
  // the lead, page and footer are for the paper).
  const notOnDetail = ['title', 'lead', 'page', 'footer'];
  const detailMiss = fields.filter((f) => !notOnDetail.includes(f) && !uses(detailSrc, f));
  ok(`the read view shows every question of all seven sections${detailMiss.length ? ` (not shown: ${detailMiss.join(', ')})` : ''}`, detailSrc && detailMiss.length === 0);
  for (const [name, code] of [['form', formSrc], ['read view', detailSrc]]) {
    const sections = ['01', '02', '03', '04', '05', '06', '07'].filter((n) => !code.includes(`<SectionTitle n="${n}"`));
    ok(`the ${name} heads all seven of his sections${sections.length ? ` (missing ${sections.join(', ')})` : ''}`, sections.length === 0);
    ok(`the ${name} offers every tick list in his order (the module's lists, never its own)`,
      ['INCIDENT_TYPES', 'ANSWERS', 'POLICE_ANSWERS', 'TREATMENTS', 'NOTIFIED_LIST', 'DOC_KINDS', 'PERSON_KINDS']
        .every((l) => name === 'read view' && l === 'PERSON_KINDS' ? true : new RegExp(`\\b${l}\\b`).test(code)));
  }
  // 🔴 In HIS order, on all three: each question's first place in the source follows his PDF (the
  // paper's furniture — title, subtitle, lead, page, footer — sits in a header and a footer).
  const docSrc = src('../src/lib/hrIncidentDocument.js');
  const furniture = ['title', 'subtitle', 'lead', 'page', 'footer'];
  const keyToField = Object.fromEntries(Object.entries(INCIDENT_FORM_KEYS).map(([f, k]) => [k, f]));
  const hisOrder = INCIDENT_FORM_ORDER.map((k) => keyToField[k]).filter((f) => f && !/^s0\d$/.test(f) && !furniture.includes(f));
  for (const [name, code] of [['form', formSrc], ['read view', detailSrc], ['printout', docSrc]]) {
    const at = hisOrder.map((f) => [f, code.indexOf(`F('${f}')`)]).filter(([, i]) => i >= 0);
    const outOfOrder = at.filter(([, i], n) => n > 0 && i < at[n - 1][1]).map(([f]) => f);
    ok(`the ${name} asks his questions in his order${outOfOrder.length ? ` (out of order: ${outOfOrder.join(', ')})` : ''}`, at.length > 10 && outOfOrder.length === 0);
  }
  const homes = [src('../src/pages/hr/IncidentsTab.jsx'), src('../src/components/EmployeeIncidentsCard.jsx')];
  ok('🔴 the read view opens under his title, ACCIDENT / INCIDENT REPORT, wherever it opens',
    homes.every((c) => /<Modal open=\{!!openId\}[^\n]{0,120}title=\{t\(INCIDENT_FORM_KEYS\.title\)\}/.test(c)) && /title=\{F\('title'\)\}/.test(formSrc));
  ok('the form checks the server\'s own rule before it files', /incidentDraftRefusal\(/.test(formSrc));
  ok('the form offers "Somewhere else" for a property (Matt: "in the streets")', formSrc.includes("'hrInc.form.elsewhere'"));
  ok('the read view has no Edit and no Delete (locked once filed)', !/hrInc\.action\.(edit|delete)/.test(detailSrc));
  ok('the read view never removes a file it shows', !/removeHrFile/.test(detailSrc));

  // ── 3. the shared rules ─────────────────────────────────────────────────────
  const SIG = `data:image/png;base64,${'A'.repeat(400)}`;
  const today = '2026-10-27';
  const good = {
    reportedByUserId: 'u_1', reportedByName: 'Keisha Brown', reporterTitle: 'Crew',
    incidentDate: '2026-10-26', incidentTime: '21:40', clientId: 'c_1', propertyName: 'Las Olas Tower',
    types: [INCIDENT_TYPE.injury, INCIDENT_TYPE.slip], typeOther: '', whatHappened: 'Slipped on a wet floor.',
    people: [{ kind: PERSON_KIND.employee, userId: 'u_1', name: 'Keisha Brown' }],
    injured: ANSWER.yes, injuryDescription: 'Left wrist', treatment: TREATMENT.firstAid, treatmentProvider: '',
    witnesses: ANSWER.no, witnessNames: '', witnessContact: '', police: ANSWER.no, policeDetails: '',
    notified: [NOTIFIED.supervisor], notifiedOther: '', actionsTaken: 'Area secured.',
    submittedByUserId: 'u_mgr', submitterContact: '555-0100', signature: SIG,
  };
  const refuses = (patch) => incidentDraftRefusal({ ...good, ...patch }, today);
  ok('a complete report can be filed', incidentDraftRefusal(good, today) === null);
  const required = [
    ['reported by (no one picked, no name typed)', { reportedByUserId: '', reportedByName: '  ' }, 'reported-by-missing'],
    ['the incident date', { incidentDate: '' }, 'incident-date-missing'],
    ['the property (no customer, no place typed)', { clientId: '', propertyName: '' }, 'property-missing'],
    ['at least one type', { types: [] }, 'types-missing'],
    ['what happened', { whatHappened: '   ' }, 'what-happened-missing'],
    ['"Was anyone injured?"', { injured: '' }, 'injured-missing'],
    ['"Were there witnesses?"', { witnesses: null }, 'witnesses-missing'],
    ['police Yes or No', { police: '' }, 'police-missing'],
    ['the printed name (the submitter)', { submittedByUserId: '' }, 'submitter-missing'],
    ['the signature', { signature: '' }, 'signature-missing'],
  ];
  for (const [what, patch, code] of required) ok(`required: ${what} → ${code}`, refuses(patch) === code);
  ok('a typed name for someone not on the team will do', refuses({ reportedByUserId: '', reportedByName: 'A passer-by' }) === null);
  ok('a place typed for "Somewhere else" will do', refuses({ clientId: '', propertyName: 'NE 2nd Ave, by the bus stop' }) === null);
  ok('injured Yes needs the injury', refuses({ injuryDescription: '' }) === 'injury-missing');
  ok('injured Yes needs the treatment', refuses({ treatment: '' }) === 'treatment-missing');
  ok('injured No needs neither', refuses({ injured: ANSWER.no, injuryDescription: '', treatment: '' }) === null);
  ok('witnesses Yes needs their names', refuses({ witnesses: ANSWER.yes, witnessNames: '' }) === 'witness-names-missing');
  ok('Unknown is an answer to "Were there witnesses?"', refuses({ witnesses: ANSWER.unknown }) === null);
  ok('Unknown is NOT an answer to the police question (his form has Yes / No)', refuses({ police: ANSWER.unknown }) === 'police-missing');
  ok('Other (type) needs words', refuses({ types: [INCIDENT_TYPE.other], typeOther: ' ' }) === 'type-other-missing');
  ok('Other (notified) needs words', refuses({ notified: [NOTIFIED.other], notifiedOther: '' }) === 'notified-other-missing');
  ok('a type not on his form is refused', refuses({ types: ['flood'] }) === 'type-bad');
  ok('a type ticked twice is refused', refuses({ types: [INCIDENT_TYPE.injury, INCIDENT_TYPE.injury] }) === 'type-bad');
  ok('a notified not on his form is refused', refuses({ notified: ['press'] }) === 'notified-bad');
  ok('🔴 an incident dated in the future is refused', refuses({ incidentDate: '2026-10-28' }) === 'incident-date-in-future');
  ok('an incident today is fine', refuses({ incidentDate: today }) === null);
  ok('the time is optional', refuses({ incidentTime: '' }) === null);
  ok('a time that is not HH:MM is refused', refuses({ incidentTime: '9pm' }) === 'incident-time-bad' && refuses({ incidentTime: '24:00' }) === 'incident-time-bad');
  ok('an employee row needs a team member picked', refuses({ people: [{ kind: PERSON_KIND.employee, userId: '' }] }) === 'person-bad');
  ok('a visitor row needs a name', refuses({ people: [{ kind: PERSON_KIND.visitor, name: ' ' }] }) === 'person-bad');
  ok('nobody listed as involved is allowed (a near miss)', refuses({ people: [] }) === null);
  ok(`more than ${MAX_PEOPLE} people is refused`, refuses({ people: Array.from({ length: MAX_PEOPLE + 1 }, (_, i) => ({ kind: PERSON_KIND.visitor, name: `P${i}` })) }) === 'people-too-many');
  ok(`${MAX_PEOPLE} people is fine`, refuses({ people: Array.from({ length: MAX_PEOPLE }, (_, i) => ({ kind: PERSON_KIND.visitor, name: `P${i}` })) }) === null);
  for (const [field, max] of Object.entries(INCIDENT_TEXT_MAX)) {
    if (['fileName', 'voidReason', 'personName'].includes(field)) continue;
    const at = refuses({ [field]: 'x'.repeat(max) });
    const over = refuses({ [field]: 'x'.repeat(max + 1) });
    ok(`${field}: ${max} characters is fine, ${max + 1} is too long`, at === null && over === 'too-long');
  }
  ok('a person\'s name past its limit is too long',
    refuses({ people: [{ kind: PERSON_KIND.visitor, name: 'x'.repeat(INCIDENT_TEXT_MAX.personName + 1) }] }) === 'too-long');
  ok('a signature that is not a PNG data URL is refused', refuses({ signature: 'data:image/svg+xml;base64,AAAA' }) === 'signature-bad');

  // files
  const file = (patch = {}) => ({ kind: DOC_KIND.photos, name: 'wrist.jpg', mimeType: 'image/jpeg', sizeBytes: 1000, storagePath: 'org/hr/incident-x/a.jpg', ...patch });
  ok('a photo with its place in the bucket is a file', normalizeFile(file())?.kind === DOC_KIND.photos);
  ok('a file needs one of his four kinds', normalizeFile(file({ kind: '' })) === null && normalizeFile(file({ kind: 'selfie' })) === null);
  ok('a file must be a PDF, PNG, JPEG or WebP', INCIDENT_FILE_MIME.length === 4 && normalizeFile(file({ mimeType: 'text/html' })) === null);
  ok(`a file over ${MAX_FILE_BYTES} bytes is refused`, normalizeFile(file({ sizeBytes: MAX_FILE_BYTES + 1 })) === null);
  ok('a file needs a place (a storage path, or the demo\'s file id)', normalizeFile(file({ storagePath: null })) === null
    && normalizeFile(file({ storagePath: null, fileId: 'hrf_1' }))?.fileId === 'hrf_1');
  ok('a draft with a bad file is refused', refuses({ files: [file({ kind: '' })] }) === 'file-bad');
  ok(`up to ${MAX_FILES} files, never more`, filesRefusal(Array.from({ length: MAX_FILES }, () => file())) === null
    && filesRefusal([file()], MAX_FILES) === 'files-too-many');
  ok('the files a report holds are its ticks, in his order', docKindsOf([file({ kind: DOC_KIND.policeReport }), file(), file()]).join() === `${DOC_KIND.photos},${DOC_KIND.policeReport}`);

  // ── 4. what a filed report keeps ────────────────────────────────────────────
  const kept = incidentAnswers({ ...good, injured: ANSWER.no, witnesses: ANSWER.unknown, witnessNames: 'left over', police: ANSWER.no, policeDetails: 'left over', types: [INCIDENT_TYPE.slip], typeOther: 'left over' });
  ok('injured No keeps no injury, treatment or provider', kept.injuryDescription === null && kept.treatment === null && kept.treatmentProvider === null);
  ok('witnesses not Yes keeps no names or contact', kept.witnessNames === null && kept.witnessContact === null);
  ok('police No keeps no agency details', kept.policeDetails === null);
  ok('Other not ticked keeps no Other words', kept.typeOther === null);
  const kept2 = incidentAnswers({ ...good, types: [INCIDENT_TYPE.slip, INCIDENT_TYPE.injury], notified: [NOTIFIED.hr, NOTIFIED.supervisor] });
  ok('the ticks are kept in HIS order, whatever order they came in', kept2.types.join() === 'injury,slip' && kept2.notified.join() === 'supervisor,hr');
  ok('the employees involved are what the HR card looks up', involvedUserIds([
    { kind: PERSON_KIND.employee, userId: 'u_1' }, { kind: PERSON_KIND.visitor, name: 'V' }, { kind: PERSON_KIND.employee, userId: 'u_1' }, { kind: PERSON_KIND.employee, userId: 'u_2' },
  ]).join() === 'u_1,u_2');
  const t = (k) => catalog[k];
  ok('a list row reads the types in his words, Other with its words',
    typesText(t, { types: [INCIDENT_TYPE.other, INCIDENT_TYPE.damage], typeOther: 'Broken glass' }) === `${catalog[INCIDENT_TYPE_KEYS.damage]}, ${catalog[INCIDENT_TYPE_KEYS.other]}: Broken glass`);
  ok('a list row reads the people with their kind',
    peopleText(t, { people: [{ kind: PERSON_KIND.employee, userId: 'u_1', name: 'Old Name' }, { kind: PERSON_KIND.visitor, name: 'Jane' }] }, { u_1: 'Keisha Brown' })
      === `Keisha Brown (${catalog[PERSON_KIND_KEYS.employee]}), Jane (${catalog[PERSON_KIND_KEYS.visitor]})`);

  // ── 5. the case number ──────────────────────────────────────────────────────
  ok('report 1 is IR-0001', incidentCaseNo({ number: 1 }) === 'IR-0001');
  ok('report 42 is IR-0042, 12345 is IR-12345', incidentCaseNo({ number: 42 }) === 'IR-0042' && incidentCaseNo({ number: 12345 }) === 'IR-12345');
  ok('no number, no case number', incidentCaseNo({}) === null && incidentCaseNo({ number: 0 }) === null && incidentCaseNo(null) === null);
  ok('his time reads AM / PM', timeAmPm('21:40') === '9:40 PM' && timeAmPm('00:05') === '12:05 AM' && timeAmPm('12:00') === '12:00 PM');

  // ── 7. files under their own owner ──────────────────────────────────────────
  const id = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
  ok('a report\'s files are owned by incident-<id>', incidentFileOwner(id) === `incident-${id}` && isIncidentFileOwner(incidentFileOwner(id)));
  ok('an employee or a reimbursement is not an incident owner', !isIncidentFileOwner('u_seed_1') && !isIncidentFileOwner('reimb_1') && !isIncidentFileOwner(null));
  ok('the owner fits the bucket\'s safe path segment', /^[A-Za-z0-9_-]{1,128}$/.test(incidentFileOwner(id)));
  ok('a report id is a uuid', isIncidentId(id) && !isIncidentId('list') && !isIncidentId(`${id}x`));
  const hrFilesRoute = src('../api/hr-files/[...path].js');
  const hrFilesStore = src('../api/_lib/hrFiles/store.js');
  ok('an incident owner names its report', incidentIdOfOwner(incidentFileOwner(id)) === id && incidentIdOfOwner('incident-x') === null && incidentIdOfOwner('u_seed_1') === null);
  ok('🔴 hr-files refuses to delete a file the report holds (the route)', /st\.files\.some\(\(f\) => f && f\.storagePath === body\.storagePath\)\)[\s\S]{0,40}403/.test(hrFilesRoute));
  ok('🔴 …and the store refuses an incident folder to any caller that has not checked', /if \(isIncidentFileOwner\(ownerId\) && !unheldIncidentFile\) throw/.test(hrFilesStore));
  {
    const P = (name) => `org/hr/${incidentFileOwner(id)}/${name}`;
    const on = [{ storagePath: P('a.jpg') }, { fileId: 'hrf_demo' }];
    const kept = filesNotOn([{ storagePath: P('a.jpg') }, { storagePath: P('b.jpg') }, { storagePath: P('b.jpg') }, { fileId: 'hrf_demo' }, { fileId: 'hrf_new' }, { kind: 'photos' }], on);
    ok('🔴 a retried add keeps only what is new, each once (by bucket path, else the demo\'s file id)',
      kept.length === 3 && kept[0].storagePath === P('b.jpg') && kept[1].fileId === 'hrf_new' && kept[2].kind === 'photos');
    ok('…every file already on the report is skipped', filesNotOn(on, on).length === 0);
  }

  // ── 8. the property; the cursor goes where a box opens ─────────────────────
  ok('a customer we clean for is a property', isIncidentProperty({ id: 'c1', name: 'Las Olas Tower' }) && isIncidentProperty({ id: 'c2', name: 'Lead Co', statusOverride: 'lead' }));
  ok('🔴 a supplier is never a property', !isIncidentProperty({ id: 'v1', name: 'Sunshine Supply', type: 'vendor' }));
  ok('🔴 an archived customer is never a property', !isIncidentProperty({ id: 'a1', name: 'Old Plaza', statusOverride: 'archived' }));
  ok('a nameless or missing record is not one', !isIncidentProperty({ id: 'x' }) && !isIncidentProperty(null));
  ok('the form offers only properties (the server\'s rule)', /filter\(isIncidentProperty\)/.test(formSrc));
  const reveals = ['reporterName', 'placeName', 'typeOther', 'injury', 'witnessNames', 'policeDetails', 'notifiedOther'];
  // Opened by setReveal('k'), toggle(…, 'k') or answer(…, 'k'); taken by autoFocus on that box.
  const unfocused = reveals.filter((k) => !new RegExp(`(setReveal\\(|\\? |, )'${k}'`).test(formSrc) || !formSrc.includes(`autoFocus={reveal === '${k}'}`));
  ok(`every box a tick, pick or Yes opens takes the cursor${unfocused.length ? ` (not: ${unfocused.join(', ')})` : ''}`, unfocused.length === 0);
  ok('…and so does a person switched to visitor or other', formSrc.includes('setReveal(`person:${p.key}`)') && formSrc.includes('autoFocus={reveal === `person:${p.key}`}'));

  // ── 6. the printout ─────────────────────────────────────────────────────────
  if (D) {
    const r = {
      ...incidentAnswers(good), id, number: 7, status: INCIDENT_STATUS.reviewed, reportedOn: today, reportedByName: 'Keisha Brown',
      propertyName: 'Las Olas Tower', submittedByName: 'Renata Ortiz', signedOn: today, submitterSignature: SIG,
      reviewedByName: 'Renata Ortiz', receivedOn: today,
      whatHappened: 'She <script>alert(1)</script> slipped & fell.',
      files: [file({ kind: DOC_KIND.photos, name: 'wrist.jpg' }), file({ kind: DOC_KIND.policeReport, name: 'report.pdf', mimeType: 'application/pdf' })],
    };
    const html = D.buildIncidentDocumentHtml(r);
    const textOf = (h) => squash(h.replace(/<style>[\s\S]*?<\/style>/, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/✓/g, ' '));
    const text = textOf(html);
    // 🔴 Every answer, not just every question: his whole form filled in prints every value given.
    const full = {
      ...r, reporterTitle: 'Crew lead', incidentTime: '21:40', exactLocation: 'Lobby, by the elevators', cityState: 'Fort Lauderdale, FL',
      types: [...INCIDENT_TYPES], typeOther: 'Chemical spill', whatHappened: 'Slipped on a wet floor.',
      people: [{ kind: PERSON_KIND.employee, userId: 'u_1', name: 'Tomas Rivera' }, { kind: PERSON_KIND.visitor, userId: null, name: 'Jane Visitor' }],
      injured: ANSWER.yes, injuryDescription: 'Left wrist sprain', treatment: TREATMENT.clinic, treatmentProvider: 'Broward Health',
      witnesses: ANSWER.yes, witnessNames: 'Rosa Diaz', witnessContact: '555-0101', police: ANSWER.yes, policeDetails: 'FLPD, 24-1031, Officer Diaz',
      notified: [...NOTIFIED_LIST], notifiedOther: 'Building engineer', actionsTaken: 'Area secured, floor dried.', submitterContact: '555-0100',
    };
    const fullText = textOf(D.buildIncidentDocumentHtml(full));
    const values = ['Keisha Brown', 'Crew lead', 'Las Olas Tower', '9:40 PM', 'Lobby, by the elevators', 'Fort Lauderdale, FL',
      `${catalog[INCIDENT_TYPE_KEYS.other]}: Chemical spill`, 'Slipped on a wet floor.', 'Tomas Rivera', 'Jane Visitor', 'Left wrist sprain',
      'Broward Health', 'Rosa Diaz', '555-0101', 'FLPD, 24-1031, Officer Diaz', `${catalog[NOTIFIED_KEYS.other]}: Building engineer`,
      'Area secured, floor dried.', 'Renata Ortiz', '555-0100', 'IR-0007'];
    const unprinted = values.filter((v) => !fullText.includes(v));
    ok(`🔴 the printout prints every answer given${unprinted.length ? ` (not: ${unprinted.join(' | ')})` : ''}`, unprinted.length === 0);
    const printMiss = [...new Set([...page1, ...page2])].map((k) => {
      if (k === INCIDENT_FORM_KEYS.footer) return fill(k);
      if (k === INCIDENT_FORM_KEYS.subtitle) return fill(k, { company: IDENTITY && IDENTITY.name });
      if (k === INCIDENT_FORM_KEYS.page) return null;
      return fill(k);
    }).filter((w) => w && !text.includes(w));
    ok(`🔴 the printout carries every line of his form${printMiss.length ? ` (missing: ${printMiss.join(' | ')})` : ''}`, printMiss.length === 0);
    ok('…on his two pages, PAGE 1 OF 2 and PAGE 2 OF 2', text.includes(fill(INCIDENT_FORM_KEYS.page, { page: 1, pages: 2 })) && text.includes(fill(INCIDENT_FORM_KEYS.page, { page: 2, pages: 2 }))
      && (html.match(/class="ir-page"/g) || []).length === 2);
    ok('…his header and footer on both pages', (html.match(/class="ir-hd"/g) || []).length === 2 && (html.match(/class="ir-foot"/g) || []).length === 2);
    const s04 = html.indexOf(`>04&nbsp;&nbsp;`);
    const firstFoot = html.indexOf('class="ir-foot"');
    ok('…sections 01–03 on page one, 04–07 on page two', s04 > firstFoot && html.indexOf('>03&nbsp;&nbsp;') < firstFoot);
    const ticked = (label) => html.includes(`<span class="ir-tick"><span class="ir-box on">✓</span>${D.escapeHtml(label)}`);
    const blankTick = (label) => html.includes(`<span class="ir-tick"><span class="ir-box"></span>${D.escapeHtml(label)}`);
    ok('the types ticked are ticked, the rest are empty boxes', INCIDENT_TYPES.every((x) => (r.types.includes(x) ? ticked(catalog[INCIDENT_TYPE_KEYS[x]]) : blankTick(catalog[INCIDENT_TYPE_KEYS[x]]))));
    ok('the documentation ticks are the kinds of files it holds', ticked(catalog[DOC_KIND_KEYS.photos]) && ticked(catalog[DOC_KIND_KEYS.policeReport])
      && blankTick(catalog[DOC_KIND_KEYS.witness_statement]) && blankTick(catalog[DOC_KIND_KEYS.other]));
    ok('…and the files are named under them', text.includes('wrist.jpg') && text.includes('report.pdf'));
    ok('the treatment ticked is ticked', ticked(catalog[TREATMENT_KEYS.first_aid]) && blankTick(catalog[TREATMENT_KEYS.clinic]));
    ok('section 07: the reviewer, the date received and the case number', text.includes('Renata Ortiz') && text.includes('IR-0007'));
    ok('🔴 what was typed is escaped (no script reaches the print window)', !html.includes('<script>alert(1)</script>') && html.includes('&lt;script&gt;'));
    ok('the signature is printed', html.includes(`src="${SIG}"`));
    const evil = D.buildIncidentDocumentHtml({ ...r, submitterSignature: 'javascript:alert(1)' });
    ok('only a PNG data URL is ever printed as the signature', !evil.includes('javascript:alert(1)'));
    ok('a report that is not voided prints no void banner', !html.includes('class="ir-void"'));
    const v = D.buildIncidentDocumentHtml({ ...r, status: INCIDENT_STATUS.voided, voidedByName: 'Matt', voidedAt: '2026-10-27T15:00:00Z', voidReason: 'Filed twice' });
    ok('a voided report prints its void, who and why', v.includes('class="ir-void"') && v.includes('Filed twice') && v.includes('Matt'));
    ok('the printout holds no colour literal (the document palette only)', !/#[0-9a-fA-F]{3,8}\b/.test(src('../src/lib/hrIncidentDocument.js').replace(/\/\/[^\n]*/g, '')));
  }
}

console.log(`\ntest-hr-incidents: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
if (fails.length) process.exitCode = 1;
