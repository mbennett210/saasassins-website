// HR TERMINATIONS — the pure rules and the printed form (Super Clippy's idea #513 from Clean
// Corner's queue, 2026-11-05: Matt's termination form in HR, set up like warnings and incident
// reports, which turns the person's Clean Corner login off). Offline.
//
// What it pins, each against the module's own constants (never a restated literal):
//   1. 🔴 MATT'S OWN FORM. The catalog's English for his sixteen reasons, in TERMINATION_REASONS'
//      order, IS his picture read across his two columns (scripts/fixtures/hr-termination-form.json),
//      and his two headings are the form's lines.
//   2. every line is USED: the form and the read view walk TERMINATION_REASONS, both draw his two
//      columns, and the printout carries every reason.
//   3. the rules the form, the server and the demo share: what is required, "Other:" needs words,
//      a date at most a year ahead and five years back, a real calendar day.
//   4. who may be terminated by whom (the Team page's limits: never a Super Admin, never yourself,
//      an Admin only by an Admin or Super Admin), and who the Direct Account Manager may be (an
//      active Account Manager, never the employee: Daniel's pick).
//   5. where a termination stands (Scheduled → Turning off → Login off; Voided), and when its
//      turn-off and its give-back are due.
//   6. the roster changes: Disabled with the moment stamped, and back ONLY for the row this
//      termination disabled.
//   7. the printout ticks exactly what was ticked, escapes what was typed, and says when it was voided.
//
//   node app/scripts/test-hr-terminations.mjs
let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond) — stated because this repo's suites disagree.
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const { readFileSync } = await import('node:fs');
let L = null;
try { L = await import('../src/lib/hrTerminations.js'); } catch (e) { fails.push(`lib/hrTerminations.js loads (${e.code || e.message})`); }
let D = null;
try { D = await import('../src/lib/hrTerminationDocument.js'); } catch (e) { fails.push(`lib/hrTerminationDocument.js loads (${e.code || e.message})`); }
let catalog = {};
try { catalog = (await import('../src/i18n/catalog/en.js')).default; } catch { fails.push('the English catalog loads'); }
let english = (k) => k;
try { ({ english } = await import('../src/i18n/core.js')); } catch { fails.push('i18n/core loads'); }
const FORM = JSON.parse(readFileSync(new URL('./fixtures/hr-termination-form.json', import.meta.url), 'utf8'));
const src = (rel) => { try { return readFileSync(new URL(rel, import.meta.url), 'utf8'); } catch { return ''; } };

if (L) {
  const {
    TERMINATION_FORM_KEYS, TERMINATION_REASONS, TERMINATION_REASON_KEYS, TERMINATION_REASON, TERMINATION_STATUS,
    ACCESS_STATE, TERMINATION_STANDING, TERMINATION_STANDING_KEYS, TERMINATION_TEXT_MAX, TERMINATION_REFUSAL_KEYS,
    TERMINATION_DAYS_AHEAD, TERMINATION_DAYS_BACK, terminationStanding, isDayKey, isTerminationId, normalizeReasons,
    isDirectManagerChoice, directManagerChoices, terminationTargetRefusal, terminationDraftRefusal, terminationAnswers,
    reasonsText, terminationAccessDue, terminationRestoreDue, rosterWithAccessEnded, rosterWithAccessRestored,
  } = L;
  const en = (k) => catalog[k];

  // ── 1. his form, word for word ─────────────────────────────────────────────
  const across = [];
  for (let i = 0; i < Math.max(FORM.left.length, FORM.right.length); i += 1) {
    if (FORM.left[i]) across.push(FORM.left[i]);
    if (FORM.right[i]) across.push(FORM.right[i]);
  }
  ok('his picture holds sixteen reasons, and the form has sixteen', across.length === 16 && TERMINATION_REASONS.length === 16);
  const ours = TERMINATION_REASONS.map((x) => en(TERMINATION_REASON_KEYS[x]));
  ok(`every reason is his, word for word, in his order (read across his two columns)\n      got  ${JSON.stringify(ours)}\n      want ${JSON.stringify(across)}`,
    JSON.stringify(ours) === JSON.stringify(across));
  ok('his column one is the form\'s even places, his column two its odd ones (so a two-column grid puts each where he did)',
    FORM.left.every((w, i) => ours[2 * i] === w) && FORM.right.every((w, i) => ours[2 * i + 1] === w));
  ok('"Other:" is his last box, and the one with words', TERMINATION_REASONS[TERMINATION_REASONS.length - 1] === TERMINATION_REASON.other && en(TERMINATION_REASON_KEYS.other) === 'Other:');
  ok('his two headings are the form\'s lines', en(TERMINATION_FORM_KEYS.reasons) === FORM.headings[0] && en(TERMINATION_FORM_KEYS.manager) === FORM.headings[1]);
  ok('his email\'s lines: the employee\'s name and the day of termination', en(TERMINATION_FORM_KEYS.employee) === 'Employee’s Name' && en(TERMINATION_FORM_KEYS.date) === 'Day of Termination');
  ok('every form line, reason, standing and refusal is a catalog line',
    [...Object.values(TERMINATION_FORM_KEYS), ...Object.values(TERMINATION_REASON_KEYS), ...Object.values(TERMINATION_STANDING_KEYS), ...Object.values(TERMINATION_REFUSAL_KEYS)]
      .every((k) => typeof en(k) === 'string' && en(k).length > 0));
  ok('the reasons\' codes are unique', new Set(TERMINATION_REASONS).size === TERMINATION_REASONS.length);

  // ── 2. every line used, in his two columns ──────────────────────────────────
  const form = src('../src/components/HrTerminationForm.jsx');
  const detail = src('../src/components/HrTerminationDetail.jsx');
  const css = src('../src/index.css');
  ok('the form ticks every reason from TERMINATION_REASONS', /TERMINATION_REASONS\.map\(/.test(form) && /TERMINATION_REASON_KEYS\[x\]/.test(form));
  ok('the read view shows every reason from TERMINATION_REASONS', /TERMINATION_REASONS\.map\(/.test(detail));
  ok('the form asks every line of his (employee, date, reasons, manager)', ['employee', 'date', 'reasons', 'manager'].every((f) => form.includes(`F('${f}')`)));
  ok('the read view shows every line of his', ['employee', 'date', 'reasons', 'manager'].every((f) => detail.includes(`F('${f}')`)));
  ok('the form draws his two columns on every screen (no phone rule changes it)',
    /\.hrt-reasons \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(css) && !/@media[^{]*\{[^}]*\.hrt-reasons \{[^}]*grid-template-columns/.test(css));
  ok('the read view draws them in his two columns too', /\.hrt-tick-list \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(css));

  // ── 3. the draft's rules ────────────────────────────────────────────────────
  const today = '2026-11-05';
  const good = { employeeUserId: 'u_c', terminationDate: today, managerUserId: 'u_am', reasons: [TERMINATION_REASON.resignation], reasonOther: '' };
  const R = (patch) => terminationDraftRefusal({ ...good, ...patch }, today);
  ok('a whole draft passes', R({}) === null);
  ok('no employee → employee-missing', R({ employeeUserId: '' }) === 'employee-missing');
  ok('no day → date-missing', R({ terminationDate: '' }) === 'date-missing');
  ok('a day that is not on the calendar → date-missing', R({ terminationDate: '2026-02-30' }) === 'date-missing' && !isDayKey('2026-13-01') && isDayKey('2028-02-29'));
  const plus = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  ok(`up to ${TERMINATION_DAYS_AHEAD} days ahead is allowed, a day more is refused`, R({ terminationDate: plus(TERMINATION_DAYS_AHEAD) }) === null && R({ terminationDate: plus(TERMINATION_DAYS_AHEAD + 1) }) === 'date-too-far');
  ok(`up to ${TERMINATION_DAYS_BACK} days back is allowed, a day more is refused`, R({ terminationDate: plus(-TERMINATION_DAYS_BACK) }) === null && R({ terminationDate: plus(-TERMINATION_DAYS_BACK - 1) }) === 'date-too-old');
  ok('a past day is allowed (the login turns off at once)', R({ terminationDate: plus(-3) }) === null);
  ok('no manager → manager-missing', R({ managerUserId: '' }) === 'manager-missing');
  ok('the employee as their own manager → refused', R({ managerUserId: 'u_c' }) === 'manager-not-account-manager');
  ok('no reason → reasons-missing', R({ reasons: [] }) === 'reasons-missing' && R({ reasons: null }) === 'reasons-missing');
  ok('a reason not on his form → reason-bad', R({ reasons: ['fired'] }) === 'reason-bad');
  ok('"Other:" with no words → reason-other-missing', R({ reasons: [TERMINATION_REASON.other], reasonOther: '  ' }) === 'reason-other-missing');
  ok('"Other:" with too many words → too-long', R({ reasons: [TERMINATION_REASON.other], reasonOther: 'x'.repeat(TERMINATION_TEXT_MAX.reasonOther + 1) }) === 'too-long');
  ok('"Other:" with words passes', R({ reasons: [TERMINATION_REASON.other], reasonOther: 'Left the state' }) === null);
  const kept = terminationAnswers({ ...good, reasons: [TERMINATION_REASON.other, TERMINATION_REASON.resignation, TERMINATION_REASON.resignation, 'bogus'], reasonOther: '  Moved away  ' });
  ok('the kept reasons are his order, once each, nothing else', JSON.stringify(kept.reasons) === JSON.stringify([TERMINATION_REASON.resignation, TERMINATION_REASON.other]));
  ok('"Other"\'s words are kept trimmed when Other is ticked', kept.reasonOther === 'Moved away');
  ok('"Other"\'s words are dropped when Other is not ticked', terminationAnswers({ ...good, reasonOther: 'stray' }).reasonOther === null);
  ok('normalizeReasons reads anything', JSON.stringify(normalizeReasons('x')) === '[]' && normalizeReasons(null).length === 0);
  ok('an id is a v4-shaped uuid', isTerminationId('dec0de03-0000-4000-8000-00000000c001') && !isTerminationId('nope') && !isTerminationId(null));

  // ── 4. who, and whose manager ───────────────────────────────────────────────
  const owner = { id: 'u_o', role: 'owner', status: 'active' };
  const admin = { id: 'u_a', role: 'admin', status: 'active' };
  const am = { id: 'u_am', role: 'manager', status: 'active' };
  const om = { id: 'u_om', role: 'manager', managerLevel: 'operations', status: 'active' };
  const crew = { id: 'u_c', role: 'crew', status: 'active' };
  const T = (caller, emp) => terminationTargetRefusal(caller, emp);
  ok('never a Super Admin, by anyone', T(owner, { ...owner, id: 'u_o2' }) === 'employee-owner' && T(am, owner) === 'employee-owner');
  ok('never yourself', T(am, am) === 'employee-self' && T(admin, admin) === 'employee-self');
  ok('an Admin only by an Admin or a Super Admin', T(am, admin) === 'employee-admin' && T(owner, admin) === null && T({ id: 'u_a2', role: 'admin' }, admin) === null);
  ok('a cleaner or a manager, by a manager', T(am, crew) === null && T(om, am) === null);
  ok('no employee → employee-missing', T(am, null) === 'employee-missing');
  ok('the Direct Account Manager: an active Account Manager', isDirectManagerChoice(am, 'u_c'));
  ok('…never an Operations Manager (Daniel\'s pick: Account Managers only)', !isDirectManagerChoice(om, 'u_c'));
  ok('…never a Disabled one', !isDirectManagerChoice({ ...am, status: 'disabled' }, 'u_c'));
  ok('…never a cleaner, an admin or the Super Admin', !isDirectManagerChoice(crew) && !isDirectManagerChoice(admin) && !isDirectManagerChoice(owner));
  ok('…never the employee themselves', !isDirectManagerChoice(am, 'u_am'));
  ok('the picker lists exactly those', JSON.stringify(directManagerChoices([owner, admin, am, om, crew, { ...am, id: 'u_am2', status: 'invited' }], 'u_c').map((u) => u.id)) === JSON.stringify(['u_am', 'u_am2']));

  // ── 5. where it stands ──────────────────────────────────────────────────────
  const row = (patch) => ({ status: TERMINATION_STATUS.filed, accessState: ACCESS_STATE.scheduled, terminationDate: '2026-11-10', ...patch });
  ok('a day still ahead → Scheduled', terminationStanding(row(), today) === TERMINATION_STANDING.scheduled);
  ok('the day has come, not yet off → Turning off', terminationStanding(row({ terminationDate: today }), today) === TERMINATION_STANDING.due
    && terminationStanding(row({ terminationDate: today, accessState: ACCESS_STATE.ending }), today) === TERMINATION_STANDING.due);
  ok('off (or already off) → Login off', terminationStanding(row({ accessState: ACCESS_STATE.ended }), today) === TERMINATION_STANDING.ended
    && terminationStanding(row({ accessState: ACCESS_STATE.alreadyOff }), today) === TERMINATION_STANDING.ended);
  ok('voided → Voided, whatever the login', terminationStanding(row({ status: TERMINATION_STATUS.voided, accessState: ACCESS_STATE.ended }), today) === TERMINATION_STANDING.voided);
  ok('the turn-off is due on the day, not before', terminationAccessDue(row({ terminationDate: today }), today) && !terminationAccessDue(row(), today)
    && terminationAccessDue(row({ terminationDate: '2026-11-01', accessState: ACCESS_STATE.ending }), today));
  ok('…and never once off, or voided', !terminationAccessDue(row({ terminationDate: today, accessState: ACCESS_STATE.ended }), today)
    && !terminationAccessDue(row({ terminationDate: today, status: TERMINATION_STATUS.voided }), today));
  ok('the give-back is due only for a voided one that began turning the login off',
    terminationRestoreDue(row({ status: TERMINATION_STATUS.voided, accessState: ACCESS_STATE.ended }))
    && terminationRestoreDue(row({ status: TERMINATION_STATUS.voided, accessState: ACCESS_STATE.ending }))
    && !terminationRestoreDue(row({ status: TERMINATION_STATUS.voided, accessState: ACCESS_STATE.scheduled }))
    && !terminationRestoreDue(row({ status: TERMINATION_STATUS.voided, accessState: ACCESS_STATE.alreadyOff }))
    && !terminationRestoreDue(row({ accessState: ACCESS_STATE.ended })));

  // ── 6. the roster ───────────────────────────────────────────────────────────
  const at = '2026-11-05T17:00:00.000Z';
  const users = [crew, am, { id: 'u_x', role: 'crew', status: 'invited' }];
  const off = rosterWithAccessEnded(users, 'u_c', at);
  ok('ending access: the member reads Disabled with the moment stamped', off.changed && off.users[0].status === 'disabled' && off.users[0].disabledAt === at);
  ok('…and nothing else changes', off.users[1] === users[1] && off.users[2] === users[2] && off.users[0].role === 'crew');
  ok('a member already off is left as they are', !rosterWithAccessEnded([{ ...crew, status: 'disabled', disabledAt: 'earlier' }], 'u_c', at).changed);
  const back = rosterWithAccessRestored(off.users, 'u_c', { disabledAt: at, statusBefore: 'active' });
  ok('a void gives back the row this termination disabled', back.changed && back.mine && back.users[0].status === 'active' && back.users[0].disabledAt === null);
  ok('…as Invited when they had been Invited', rosterWithAccessRestored(rosterWithAccessEnded(users, 'u_x', at).users, 'u_x', { disabledAt: at, statusBefore: 'invited' }).users[2].status === 'invited');
  const byHand = rosterWithAccessRestored([{ ...crew, status: 'disabled', disabledAt: '2026-11-06T09:00:00.000Z' }], 'u_c', { disabledAt: at, statusBefore: 'active' });
  ok('a row disabled again on Team since (another moment) is left off', !byHand.changed && byHand.users[0].status === 'disabled');
  ok('a row turned back on on Team since is left as it is', !rosterWithAccessRestored(users, 'u_c', { disabledAt: at, statusBefore: 'active' }).changed);

  // ── 7. the list's words and the printout ────────────────────────────────────
  const t = (k) => english(k);
  ok('a list row reads his reasons in his order, "Other:" with its words',
    reasonsText(t, { reasons: [TERMINATION_REASON.other, TERMINATION_REASON.resignation], reasonOther: 'Moved' }) === 'Resignation, Other: Moved');
  if (D) {
    const r = {
      employeeName: 'Luis <b>Ferrer</b>', terminationDate: '2026-11-05', managerName: 'Renata Cruz',
      reasons: [TERMINATION_REASON.insubordination, TERMINATION_REASON.other], reasonOther: 'Left <script>x</script>',
      status: TERMINATION_STATUS.filed, filedAt: at, filedByName: 'Kyler',
    };
    const html = D.buildTerminationDocumentHtml(r);
    ok('the printout carries every one of his reasons', TERMINATION_REASONS.every((x) => html.includes(english(TERMINATION_REASON_KEYS[x]).replace(/&/g, '&amp;'))));
    ok('…and his lines', Object.values(TERMINATION_FORM_KEYS).every((k) => html.includes(english(k).replace(/&/g, '&amp;'))));
    ok('it ticks exactly the reasons ticked', (html.match(/class="tr-box on"/g) || []).length === 2);
    ok('it escapes what was typed', !html.includes('<script>x') && html.includes('&lt;script&gt;') && !html.includes('<b>Ferrer'));
    ok('it reads the day as that calendar day', html.includes('November 5, 2026'));
    ok('a filed one has no void line', !html.includes('tr-void"'));
    ok('a voided one says so, with the reason', D.buildTerminationDocumentHtml({ ...r, status: TERMINATION_STATUS.voided, voidedByName: 'Kyler', voidedAt: at, voidReason: 'Filed for the wrong person' }).includes('Filed for the wrong person'));
    ok('no colour literal in it (the brand layer\'s DOC palette only)', !/#[0-9a-f]{3,8}\b/i.test(src('../src/lib/hrTerminationDocument.js').replace(/\/\/.*$/gm, '')));
  }
}

if (fails.length) {
  console.error(`test-hr-terminations: ${pass} passed, ${fails.length} FAILED`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`test-hr-terminations: ${pass} passed, 0 failed`);
