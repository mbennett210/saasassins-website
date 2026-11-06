// HR WARNINGS — the pure rules (Matt's HR-1..HR-5, 2026-10-05). Offline.
//
// What it pins, each against the module's own constants (never a restated literal):
//   1. HR-2: three levels, in order — First warning → Last warning → Termination.
//   2. 🔴 HR-1 (b): MATT'S OWN FORM. The questions, their wording and the ten reasons — in
//      English AND in his team's Spanish — are pinned to the form itself
//      (scripts/fixtures/hr-warning-form.json, extracted from his .docx), not to a copy typed
//      here. Several reasons may be ticked (at least one; "Other" needs words), the previous
//      discipline meeting date is optional and never in the future, the details and the
//      corrective action are required. The draft's building, incident date and consequence
//      are GONE (replace means delete), and his 19 Spanish lines stay word for word in the
//      Spanish catalog, whatever else it holds (since S129, the app's own words too).
//   3. 🔴 HR-4, the owner's reading (a): the 12-month period STARTS at the employee's first
//      counted warning and RESETS 12 months later; the next warning after that starts a new
//      period. Voided warnings never count. The form preselects the next level from it.
//   4. HR-5: an unsigned warning is due for its reminder once a day has passed — once.
//   5. a signature is a bounded PNG data URL, so a row can never carry a megabyte.
//   6. the printed warning is his form twice — his English page, then his Spanish page with
//      the same answers, the ticked reasons as ticks, a signature block on each page.
//   7. the migration that moves the table to his form refuses to run on a table with rows.
//
//   node app/scripts/test-hr-warnings.mjs
let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond) — stated because this repo's suites disagree.
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

let W = null;
try { W = await import('../src/lib/hrWarnings.js'); } catch (e) { fails.push(`lib/hrWarnings.js loads (${e.code || e.message})`); }
let R = null;
try { R = await import('../src/lib/hrWarningReminders.js'); } catch (e) { fails.push(`lib/hrWarningReminders.js loads (${e.code || e.message})`); }
let catalog = {};
try { catalog = (await import('../src/i18n/catalog/en.js')).default; } catch { /* reported below */ }
let esCatalog = {};
try { esCatalog = (await import('../src/i18n/catalog/es.js')).default; } catch { /* reported below */ }
const { readFileSync } = await import('node:fs');
const FORM = JSON.parse(readFileSync(new URL('./fixtures/hr-warning-form.json', import.meta.url), 'utf8'));

if (W) {
  const {
    WARNING_LEVELS, WARNING_LEVEL, WARNING_LEVEL_KEYS, WARNING_FORM_KEYS,
    WARNING_REASONS, WARNING_REASON, WARNING_REASON_KEYS,
    WARNING_STATUS, WARNING_STATUSES, WARNING_STATUS_KEYS, WARNING_STATUS_VARIANTS,
    WARNING_PERIOD_MONTHS, WARNING_REMINDER_HOURS, MAX_SIGNATURE_CHARS,
    WARNING_REFUSAL_KEYS,
    warningDraftRefusal, warningStanding, nextLevelFor, countsTowardStanding,
    signatureRefusal, unsignedReminderDue, previousMeetingDefault,
  } = W;
  const { addMonthsKey, addDaysKey } = await import('../src/lib/dates.js');

  // ── 1. HR-2: the three levels, in order ────────────────────────────────────
  ok('HR-2: exactly three levels', WARNING_LEVELS.length === 3);
  ok('HR-2: First → Last → Termination, in that order',
    WARNING_LEVELS[0] === WARNING_LEVEL.first && WARNING_LEVELS[1] === WARNING_LEVEL.last
    && WARNING_LEVELS[2] === WARNING_LEVEL.termination);
  ok('every level has a label in the English catalog',
    WARNING_LEVELS.every((l) => typeof catalog[WARNING_LEVEL_KEYS[l]] === 'string'));

  // ── 2. 🔴 HR-1 (b): Matt's own form ─────────────────────────────────────────
  const formFields = ['title', 'employeeName', 'date', 'supervisorName', 'previousMeeting', 'reasonsHeading', 'details', 'corrective', 'note'];
  ok('the form module maps every line of his form to a catalog key',
    !!WARNING_FORM_KEYS && formFields.every((f) => typeof WARNING_FORM_KEYS[f] === 'string'));
  for (const f of formFields) {
    const key = WARNING_FORM_KEYS && WARNING_FORM_KEYS[f];
    ok(`his English, word for word: ${f}`, !!key && catalog[key] === FORM.en[f]);
    ok(`his team's Spanish, word for word (accents included): ${f}`, !!key && esCatalog[key] === FORM.es[f]);
  }
  ok('HR-1 (b): his ten reasons, in his order', WARNING_REASONS.length === FORM.en.reasons.length
    && WARNING_REASONS.every((r, i) => catalog[WARNING_REASON_KEYS[r]] === FORM.en.reasons[i]));
  ok('…and their Spanish, in the same order', WARNING_REASONS.length === FORM.es.reasons.length
    && WARNING_REASONS.every((r, i) => esCatalog[WARNING_REASON_KEYS[r]] === FORM.es.reasons[i]));
  ok('"Other" is the last reason', WARNING_REASONS[WARNING_REASONS.length - 1] === WARNING_REASON.other);
  // His 19 lines are HIS words, not ours: whatever else the Spanish catalog holds (since S129,
  // the app's own words — Google Cloud Translation's drafts after the term-list cleanup), these
  // stay exactly as his form has them, and a machine pass may never overwrite one.
  const hisSpanish = new Map([
    ...formFields.map((f) => [WARNING_FORM_KEYS && WARNING_FORM_KEYS[f], FORM.es[f]]),
    ...WARNING_REASONS.map((r, i) => [WARNING_REASON_KEYS[r], FORM.es.reasons[i]]),
  ]);
  const changed = [...hisSpanish].filter(([k, want]) => !k || esCatalog[k] !== want).map(([k]) => k);
  ok(`🔴 his form's ${FORM.es.reasons.length + formFields.length} Spanish lines are in the catalog word for word (changed or missing: ${changed.join(', ') || 'none'})`,
    hisSpanish.size === formFields.length + FORM.es.reasons.length && changed.length === 0);
  ok("replace means delete: the draft's consequence prefill is gone", !('WARNING_CONSEQUENCE_KEYS' in W));
  const gone = Object.keys(catalog).filter((k) => /^hrWarn\.(consequence\.|field\.(building|incidentDate|consequence)$|form\.(noBuilding|consequenceHelp)$|detail\.noBuilding$|refusal\.(incidentDateBad|incidentInFuture|consequenceMissing)$|reason\.(attendance|lateness|quality|conduct|safety|uniform)$)/.test(k));
  ok(`replace means delete: no catalog line for the building, the incident date or the consequence (left: ${gone.join(', ') || 'none'})`, gone.length === 0);
  ok('four statuses: awaiting, acknowledged, refused, voided',
    WARNING_STATUSES.length === 4 && WARNING_STATUSES.includes(WARNING_STATUS.voided));
  ok('every status has words and a badge colour',
    WARNING_STATUSES.every((s) => typeof catalog[WARNING_STATUS_KEYS[s]] === 'string' && WARNING_STATUS_VARIANTS[s]));

  const TODAY = '2026-10-05';
  const good = () => ({
    employeeUserId: 'u_crew', supervisorUserId: 'u_mgr', level: WARNING_LEVEL.first,
    reasons: [WARNING_REASON.tardiness], reasonOther: '', previousMeetingDate: null,
    whatHappened: 'Arrived 45 minutes late to Ball Harbor.', whatMustChange: 'Arrive on time.',
  });
  ok('a complete draft is accepted', warningDraftRefusal(good(), TODAY) === null);
  const refusal = (patch) => warningDraftRefusal({ ...good(), ...patch }, TODAY);
  ok('no employee → employee-missing', refusal({ employeeUserId: '' }) === 'employee-missing');
  ok('no supervisor → supervisor-missing', refusal({ supervisorUserId: null }) === 'supervisor-missing');
  ok('the supervisor cannot warn themselves → same-person', refusal({ supervisorUserId: 'u_crew' }) === 'same-person');
  ok('an unknown level → level-bad', refusal({ level: 'final' }) === 'level-bad');
  ok('no reason ticked → reasons-missing', refusal({ reasons: [] }) === 'reasons-missing');
  ok('reasons that are not a list → reasons-missing', refusal({ reasons: 'tardiness' }) === 'reasons-missing');
  ok('several reasons may be ticked', refusal({ reasons: [WARNING_REASON.tardiness, WARNING_REASON.rudeness, WARNING_REASON.language] }) === null);
  ok('an unknown reason → reason-bad', refusal({ reasons: [WARNING_REASON.tardiness, 'gossip'] }) === 'reason-bad');
  ok('the same reason twice → reason-bad', refusal({ reasons: [WARNING_REASON.fighting, WARNING_REASON.fighting] }) === 'reason-bad');
  ok('"Other" needs words → reason-other-missing', refusal({ reasons: [WARNING_REASON.other], reasonOther: '   ' }) === 'reason-other-missing');
  ok('"Other" with words is accepted', refusal({ reasons: [WARNING_REASON.policy, WARNING_REASON.other], reasonOther: 'Phone use on site' }) === null);
  ok('no previous meeting is fine (optional)', refusal({ previousMeetingDate: '' }) === null && refusal({ previousMeetingDate: null }) === null);
  ok('a previous meeting date that is not a date → previous-date-bad', refusal({ previousMeetingDate: '10/04/2026' }) === 'previous-date-bad');
  ok('a previous meeting in the future → previous-date-in-future', refusal({ previousMeetingDate: addDaysKey(TODAY, 1) }) === 'previous-date-in-future');
  ok('a previous meeting TODAY is fine', refusal({ previousMeetingDate: TODAY }) === null);
  ok('the details of the actions are required', refusal({ whatHappened: '' }) === 'what-happened-missing');
  ok('the corrective action is required', refusal({ whatMustChange: ' ' }) === 'what-must-change-missing');
  ok('every refusal code has a sentence in the catalog',
    Object.values(WARNING_REFUSAL_KEYS).every((k) => typeof catalog[k] === 'string'));

  // ── 3. 🔴 HR-4: the 12-month period (the owner's reading (a)) ─────────────
  const w = (issuedOn, extra = {}) => ({ id: `w_${issuedOn}`, employeeUserId: 'u_crew', issuedOn, status: WARNING_STATUS.acknowledged, ...extra });
  ok('the period is twelve months', WARNING_PERIOD_MONTHS === 12);

  let s = warningStanding([], 'u_crew', TODAY);
  ok('no warnings: 0 in the period, nothing to reset', s.count === 0 && s.since === null && s.resets === null);
  ok('no warnings: the next level is a First warning', s.nextLevel === WARNING_LEVEL.first);

  s = warningStanding([w('2026-01-10')], 'u_crew', TODAY);
  ok('one warning: 1 in the period, since its day', s.count === 1 && s.since === '2026-01-10');
  ok('…resetting twelve months after it', s.resets === addMonthsKey('2026-01-10', WARNING_PERIOD_MONTHS));
  ok('one warning: the next is a Last warning', s.nextLevel === WARNING_LEVEL.last);

  s = warningStanding([w('2026-03-01'), w('2026-01-10')], 'u_crew', TODAY);
  ok('two warnings (any order): 2 in the period, since the FIRST', s.count === 2 && s.since === '2026-01-10');
  ok('two warnings: the next is Termination', s.nextLevel === WARNING_LEVEL.termination);

  s = warningStanding([w('2026-01-10'), w('2026-03-01'), w('2026-05-01')], 'u_crew', TODAY);
  ok('three warnings: the next stays Termination (no fourth level)', s.count === 3 && s.nextLevel === WARNING_LEVEL.termination);

  s = warningStanding([w('2026-01-10'), w('2026-03-01', { status: WARNING_STATUS.voided })], 'u_crew', TODAY);
  ok('a VOIDED warning never counts', s.count === 1 && s.nextLevel === WARNING_LEVEL.last);
  ok('countsTowardStanding: voided no, refused yes, awaiting yes',
    !countsTowardStanding({ status: WARNING_STATUS.voided })
    && countsTowardStanding({ status: WARNING_STATUS.refused })
    && countsTowardStanding({ status: WARNING_STATUS.awaiting }));

  s = warningStanding([w('2025-01-10'), w('2025-12-01')], 'u_crew', '2026-01-10');
  ok('the period RESETS twelve months after its first warning (on the reset day the count is 0)',
    s.count === 0 && s.nextLevel === WARNING_LEVEL.first && s.since === null);
  s = warningStanding([w('2025-01-10'), w('2025-12-01')], 'u_crew', '2026-01-09');
  ok('…and the day before the reset both still count', s.count === 2 && s.resets === '2026-01-10');

  s = warningStanding([w('2025-01-10'), w('2025-06-01'), w('2026-02-01')], 'u_crew', '2026-03-01');
  ok('🔴 a warning after the reset STARTS A NEW PERIOD: it counts alone, the old ones do not',
    s.count === 1 && s.since === '2026-02-01' && s.resets === addMonthsKey('2026-02-01', WARNING_PERIOD_MONTHS));
  ok('…so the next level is Last, not Termination', s.nextLevel === WARNING_LEVEL.last);

  s = warningStanding([w('2025-01-10'), w('2025-06-01'), w('2026-01-10')], 'u_crew', '2026-02-01');
  ok('a warning ON the reset day starts the new period', s.count === 1 && s.since === '2026-01-10');

  s = warningStanding([w('2026-01-10'), { ...w('2026-02-01'), employeeUserId: 'u_other' }], 'u_crew', TODAY);
  ok("another employee's warnings never count", s.count === 1);

  s = warningStanding([w('2026-01-10'), w('2026-11-01')], 'u_crew', TODAY);
  ok('a warning dated after "today" is not counted yet', s.count === 1);

  ok('nextLevelFor: 0 → First, 1 → Last, 2 → Termination, 9 → Termination',
    nextLevelFor(0) === WARNING_LEVEL.first && nextLevelFor(1) === WARNING_LEVEL.last
    && nextLevelFor(2) === WARNING_LEVEL.termination && nextLevelFor(9) === WARNING_LEVEL.termination);

  // The previous discipline meeting's PREFILL: the employee's most recent COUNTED warning.
  const pmd = typeof previousMeetingDefault === 'function' ? previousMeetingDefault : () => undefined;
  ok('previousMeetingDefault: no warnings → empty', pmd([], 'u_crew', TODAY) === null);
  ok('previousMeetingDefault: the most recent warning, any order',
    pmd([w('2025-03-01'), w('2026-02-01'), w('2025-12-01')], 'u_crew', TODAY) === '2026-02-01');
  ok('previousMeetingDefault: a VOIDED warning is no meeting on record',
    pmd([w('2025-03-01'), w('2026-02-01', { status: WARNING_STATUS.voided })], 'u_crew', TODAY) === '2025-03-01');
  ok('previousMeetingDefault: older than the 12-month period still counts as a past meeting',
    pmd([w('2023-03-01')], 'u_crew', TODAY) === '2023-03-01');
  ok("previousMeetingDefault: another employee's warning is not theirs",
    pmd([{ ...w('2026-02-01'), employeeUserId: 'u_other' }], 'u_crew', TODAY) === null);
  ok('previousMeetingDefault: never a day after today', pmd([w('2026-12-01')], 'u_crew', TODAY) === null);

  // ── 4. HR-5: the one-day reminder ─────────────────────────────────────────
  const ISSUED = '2026-10-05T14:00:00.000Z';
  const H = 3600 * 1000;
  const aw = (extra = {}) => ({ id: 'w1', status: WARNING_STATUS.awaiting, issuedAt: ISSUED, remindedAt: null, ...extra });
  ok('HR-5: the reminder waits a day', WARNING_REMINDER_HOURS === 24);
  ok('not due before a day has passed', !unsignedReminderDue(aw(), Date.parse(ISSUED) + (WARNING_REMINDER_HOURS * H) - 1));
  ok('due once a day has passed', unsignedReminderDue(aw(), Date.parse(ISSUED) + WARNING_REMINDER_HOURS * H));
  ok('once only: a reminded warning is not due again', !unsignedReminderDue(aw({ remindedAt: ISSUED }), Date.parse(ISSUED) + 72 * H));
  ok('a signed, refused or voided warning is never due',
    [WARNING_STATUS.acknowledged, WARNING_STATUS.refused, WARNING_STATUS.voided]
      .every((st) => !unsignedReminderDue(aw({ status: st }), Date.parse(ISSUED) + 72 * H)));

  // ── 5. the signature ──────────────────────────────────────────────────────
  const png = `data:image/png;base64,${'iVBORw0KGgo'.padEnd(400, 'A')}`;
  ok('a PNG data URL is a signature', signatureRefusal(png) === null);
  ok('nothing → signature-missing', signatureRefusal('') === 'signature-missing');
  ok('not a PNG data URL → signature-bad', signatureRefusal('data:image/svg+xml;base64,PHN2Zz4=') === 'signature-bad');
  ok('script in the data → signature-bad', signatureRefusal('data:image/png;base64,<script>') === 'signature-bad');
  ok('over the bound → signature-too-large',
    signatureRefusal(`data:image/png;base64,${'A'.repeat(MAX_SIGNATURE_CHARS)}`) === 'signature-too-large');
}

if (R) {
  const { WARNING_STATUS } = W || { WARNING_STATUS: {} };
  const {
    getDueWarningReminders, warningReminderIds, HR_WARNING_SIGN_EVENT, HR_WARNING_UNSIGNED_EVENT,
    warningSignUrl, warningOfficeUrl,
  } = R;
  // A Wednesday 10:00 in New York — inside the default office hours.
  const NOW = Date.parse('2026-10-07T14:00:00.000Z');
  const state = {
    company: { timezone: 'America/New_York' },
    opsSettings: {},
    users: [
      { id: 'u_owner', role: 'owner', status: 'active', name: 'Owner' },
      { id: 'u_mgr', role: 'manager', status: 'active', name: 'Mia Manager' },
      { id: 'u_gone', role: 'manager', status: 'inactive', name: 'Gone' },
      { id: 'u_crew', role: 'crew', status: 'active', name: 'Tomas Rivera' },
    ],
  };
  const row = (extra = {}) => ({
    id: '11111111-1111-4111-8111-111111111111', employeeUserId: 'u_crew', employeeName: 'Tomas Rivera',
    supervisorUserId: 'u_mgr', status: WARNING_STATUS.awaiting, issuedAt: '2026-10-05T14:00:00.000Z',
    issuedOn: '2026-10-05', remindedAt: null, ...extra,
  });
  let due = getDueWarningReminders({ warnings: [row()], state, firedIds: new Set(), now: NOW });
  ok('HR-5: an unsigned warning a day old raises TWO alerts', due.length === 2);
  const sup = due.find((a) => a.kind === HR_WARNING_UNSIGNED_EVENT);
  const emp = due.find((a) => a.kind === HR_WARNING_SIGN_EVENT);
  ok('…the supervisor is reminded (users scope, the picked supervisor)', !!sup && sup.recipientScope === 'users' && sup.userIds.join() === 'u_mgr');
  ok('…and the employee gets a nudge', !!emp && emp.userIds.join() === 'u_crew');
  ok('…each with its own deterministic marker id', sup && emp && sup.id === warningReminderIds(row().id).supervisor && emp.id === warningReminderIds(row().id).employee);
  ok('…both carry the warning id, so the run can stamp it', sup && emp && sup.warningId === row().id && emp.warningId === row().id);
  ok('…the supervisor opens the office view, the employee their own', sup && emp && sup.url === warningOfficeUrl(row().id) && emp.url === warningSignUrl(row().id));
  ok('…the words are MESSAGES, rendered per recipient', sup && emp && typeof sup.title?.$t === 'string' && typeof emp.title?.$t === 'string');

  due = getDueWarningReminders({ warnings: [row({ supervisorUserId: 'u_gone' })], state, firedIds: new Set(), now: NOW });
  const fallback = due.find((a) => a.kind === HR_WARNING_UNSIGNED_EVENT);
  ok('a supervisor no longer active → the active owner is reminded instead', !!fallback && fallback.userIds.join() === 'u_owner');

  due = getDueWarningReminders({ warnings: [row()], state, firedIds: new Set([warningReminderIds(row().id).supervisor, warningReminderIds(row().id).employee]), now: NOW });
  ok('a marker already fired → nothing (idempotent within a run)', due.length === 0);
  due = getDueWarningReminders({ warnings: [row({ remindedAt: '2026-10-06T15:00:00.000Z' })], state, firedIds: new Set(), now: NOW });
  ok('a stamped warning → nothing (the durable once-only)', due.length === 0);
  due = getDueWarningReminders({ warnings: [row({ issuedAt: '2026-10-07T00:00:00.000Z' })], state, firedIds: new Set(), now: NOW });
  ok('less than a day → nothing', due.length === 0);
  due = getDueWarningReminders({ warnings: [row()], state, firedIds: new Set(), now: Date.parse('2026-10-07T07:00:00.000Z') });
  ok('outside office hours (03:00) → held until morning', due.length === 0);
  due = getDueWarningReminders({ warnings: [row({ status: WARNING_STATUS.acknowledged })], state, firedIds: new Set(), now: NOW });
  ok('a signed warning → nothing', due.length === 0);
}

// ── 6. the printed record: his form, English page then Spanish page ─────────
let D = null;
try { D = await import('../src/lib/hrWarningDocument.js'); } catch (e) { fails.push(`lib/hrWarningDocument.js loads (${e.code || e.message})`); }
let core = null;
try { core = await import('../src/i18n/core.js'); core.registerCatalog('es', esCatalog); } catch { /* reported by the checks */ }
if (D && W && core) {
  const { WARNING_STATUS, WARNING_LEVEL, WARNING_REASON } = W;
  const esc = typeof D.escapeHtml === 'function' ? D.escapeHtml : (t) => t;
  const base = {
    id: 'w1', employeeName: 'Tomas Rivera', supervisorName: 'Renata Cruz',
    level: WARNING_LEVEL.last, reasons: [WARNING_REASON.tardiness, WARNING_REASON.other], reasonOther: 'Phone use on site',
    previousMeetingDate: '2026-06-02', issuedAt: '2026-10-05T14:00:00.000Z', issuedOn: '2026-10-05',
    whatHappened: 'On the phone <b>during</b> the clean.', whatMustChange: 'Phones away.',
    status: WARNING_STATUS.acknowledged, employeeSignedAt: '2026-10-05T15:00:00.000Z', signedInPerson: true,
    employeeSignature: 'data:image/png;base64,iVBORw0KGgo=', employeeComment: 'I disagree.',
  };
  const pages = (html) => html.split('class="hw-page').slice(1);
  let html = D.buildWarningDocumentHtml(base, { tz: 'America/New_York' });
  const [enPage = '', esPage = ''] = pages(html);
  ok('two pages: his English page, then his Spanish page', pages(html).length === 2);
  ok('…the English page reads his English (title, every question, the note)',
    ['title', 'employeeName', 'date', 'supervisorName', 'previousMeeting', 'reasonsHeading', 'details', 'corrective', 'note']
      .every((f) => enPage.includes(esc(FORM.en[f]))));
  ok("…the Spanish page reads his team's Spanish",
    ['title', 'employeeName', 'date', 'supervisorName', 'previousMeeting', 'reasonsHeading', 'details', 'corrective', 'note']
      .every((f) => esPage.includes(esc(FORM.es[f]))));
  ok('…every one of his ten reasons is printed on each page',
    FORM.en.reasons.every((t) => enPage.includes(`>${esc(t)}<`)) && FORM.es.reasons.every((t) => esPage.includes(`>${esc(t)}<`)));
  const ticked = (page) => (page.match(/class="hw-tick on"/g) || []).length;
  ok('…and exactly the ticked ones carry a tick, on both pages', ticked(enPage) === 2 && ticked(esPage) === 2);
  ok("…the people's own words stay as typed, untranslated, on BOTH pages",
    [enPage, esPage].every((p) => p.includes('Phone use on site') && p.includes('Phones away.') && p.includes('Tomas Rivera') && p.includes('Renata Cruz')));
  ok('…escaped, never markup', html.includes('&lt;b&gt;during&lt;/b&gt;') && !html.includes('<b>during</b>'));
  ok('…the previous meeting date in each page\'s language', /June 2, 2026/.test(enPage) && /2 de junio de 2026/.test(esPage));
  ok('…a signature block closes EACH page: the signature and the comment',
    [enPage, esPage].every((p) => p.includes('hw-sign') && p.includes('src="data:image/png;base64,iVBORw0KGgo="') && p.includes('I disagree.')));
  ok("…and the signature block carries the supervisor's name", [enPage, esPage].every((p) => p.slice(p.indexOf('hw-sign')).includes('Renata Cruz')));
  html = D.buildWarningDocumentHtml({ ...base, previousMeetingDate: null }, { tz: 'America/New_York' });
  ok('no previous meeting: the line is left blank, as on the paper form', pages(html).length === 2 && pages(html).every((p) => p.includes('hw-blank')));
  html = D.buildWarningDocumentHtml({ ...base, employeeSignature: 'javascript:alert(1)' }, { tz: 'America/New_York' });
  ok('a signature that is not a PNG data URL never reaches an <img>', !html.includes('javascript:'));
  html = D.buildWarningDocumentHtml({
    ...base, status: WARNING_STATUS.refused, employeeSignedAt: null, employeeSignature: null,
    refusedAt: '2026-10-05T15:00:00.000Z', hrManagerName: 'Olivia Owner', hrManagerSignedAt: '2026-10-05T15:00:00.000Z',
    hrManagerSignature: 'data:image/png;base64,iVBORw0KGgo=',
  }, { tz: 'America/New_York' });
  // Each page words the refusal in its own language, from the catalog (the Spanish page falls
  // back to the English line only while the Spanish catalog lacks it).
  const refusalWords = (lang) => core.translate(lang, 'hrWarn.detail.refusedBy', { name: 'Olivia Owner', when: '2026-10-05T15:00:00.000Z' }, 'America/New_York');
  const [enRefused = '', esRefused = ''] = pages(html);
  ok('HR-3: a refused warning prints the refusal and the HR manager who signed, on both pages',
    pages(html).length === 2 && enRefused.includes(esc(refusalWords('en'))) && esRefused.includes(esc(refusalWords('es')))
    && [enRefused, esRefused].every((p) => p.includes('Olivia Owner') && p.includes('data:image/png')));
  html = D.buildWarningDocumentHtml({ ...base, status: WARNING_STATUS.voided, voidedByName: 'Olivia Owner', voidReason: 'Wrong person' }, { tz: 'America/New_York' });
  ok('a voided warning prints as voided, with why', /Voided/.test(html) && html.includes('Wrong person'));
  ok('the printed form has no building, incident date or consequence',
    !/Building|Date it happened|If it happens again/.test(D.buildWarningDocumentHtml(base, { tz: 'America/New_York' })));
}

// ── 7. the migration onto his form ──────────────────────────────────────────
let sql = '';
try { sql = readFileSync(new URL('../../supabase/migrations/20261005150000_hr_warnings_form.sql', import.meta.url), 'utf8'); } catch { /* reported below */ }
const code = sql.replace(/--[^\n]*/g, '').toLowerCase();
ok('the form migration exists (20261005150000_hr_warnings_form.sql)', sql.length > 0);
const guardAt = code.search(/if\s+exists\s*\(\s*select\s+1\s+from\s+public\.hr_warnings\s*\)/);
const firstAlter = code.indexOf('alter table');
ok('🔴 it FIRST refuses to run on a table holding any row (it can never drop data)',
  guardAt >= 0 && firstAlter > guardAt && /raise\s+exception/.test(code.slice(guardAt, firstAlter)));
ok('it adds reasons text[] not null', /add\s+column\s+(if\s+not\s+exists\s+)?reasons\s+text\[\]\s+not\s+null/.test(code));
ok('…with at least one reason and no empty or null one', /cardinality\(\s*reasons\s*\)\s*>=\s*1/.test(code)
  && /array_position\(\s*reasons\s*,\s*''\s*\)\s+is\s+null/.test(code) && /array_position\(\s*reasons\s*,\s*null\s*\)\s+is\s+null/.test(code));
ok('it adds previous_meeting_date date', /add\s+column\s+(if\s+not\s+exists\s+)?previous_meeting_date\s+date\b/.test(code));
for (const col of ['reason', 'client_id', 'client_name', 'incident_date', 'consequence']) {
  ok(`it drops ${col}`, new RegExp(`drop\\s+column\\s+(if\\s+exists\\s+)?${col}\\b`).test(code));
}
const fnAt = code.indexOf('create or replace function public.hr_warnings_guard_change');
const guardFn = fnAt >= 0 ? code.slice(fnAt) : '';
ok('it re-creates the lock (hr_warnings_guard_change) AFTER the columns change', fnAt > code.lastIndexOf('drop column'));
ok('…locking the new columns', /new\.reasons/.test(guardFn) && /new\.previous_meeting_date/.test(guardFn));
ok('…and naming none of the dropped ones', guardFn.length > 0 && !/\b(new|old)\.(reason|client_id|client_name|incident_date|consequence)\b/.test(guardFn));
ok('the reason vocabulary stays in lib/hrWarnings.js (no check constraint lists it)', !W || W.WARNING_REASONS.every((r) => !code.includes(`'${r}'`)));

console.log(`\ntest-hr-warnings: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
if (fails.length) process.exitCode = 1;
