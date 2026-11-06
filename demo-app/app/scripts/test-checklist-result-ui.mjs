// CS-552 — the SHAPE of the checklist-result pop-up, and the row that opens it.
//
// THE DEFECT. Quality → Checklists listed one row per submitted checklist — "25/26", who,
// when — with no way to see which items those were, which was marked "does not apply", or
// what the cleaner wrote on it. The rule behind the new pop-up is a pure module and runs in
// `test-checklist-result-view.mjs`; this suite holds the SCREEN: that the result opens from
// a real control rather than a click handler on a `<tr>`, that it is read-only and fetches
// nothing, that its controls are kit controls with accessible names that say what they act
// on, that the dialog is announced as one, and that a phone gets real tap targets.
//
// MECHANICAL over the source (the shape `test-checklist-na-ui.mjs`, `test-checklist-by-
// user-id.mjs` and `test-checklist-location-ui.mjs` use), because a .jsx cannot be imported
// by plain Node — Vite writes extensionless imports and DEV_PLAYBOOK 3.9.5 forbids a suite
// registering a resolver hook. The behaviour itself is driven in the demo browser at
// 375x812 and 1280x800 and reported in the build.
//
// Failing-first by construction: pre-fix `components/ChecklistResultModal.jsx` and
// `lib/checklistResultView.js` do not exist (their reads return ''), the Checklists table
// has no per-row control and no badge, and `Modal` declares no dialog role.
//
//   node app/scripts/test-checklist-result-ui.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const read = (p) => { try { return readFileSync(path.join(APP, p), 'utf8'); } catch { return ''; } };
// Comments quote the defect and describe the rule on purpose; only real code counts.
const code = (p) => read(p).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const MODAL_TEXT = read('src/components/ChecklistResultModal.jsx');
const MODAL = code('src/components/ChecklistResultModal.jsx');
const HUB = code('src/pages/Inspections.jsx');
const KIT_MODAL = code('src/components/Modal.jsx');
const VIEW = code('src/lib/checklistResultView.js');
const CSS = read('src/index.css');
const LEDGER = read('design-system/controls.json');
const FROM_HERE = code('src/hooks/useFromHere.js');

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
// 🔴 A NEGATIVE CHECK OVER A FILE THAT DOES NOT EXIST PASSES FOR THE WRONG REASON. Pre-fix
// `ChecklistResultModal.jsx` is absent and `read()` answers '', so "it fetches nothing" was
// green against nothing at all — and a check that cannot fail proves nothing (THE LAW
// II.3). Every "the pop-up does NOT do X" therefore requires the pop-up to exist first.
const hasModal = MODAL.trim().length > 0;
const modalLacks = (re) => hasModal && !re.test(MODAL);

// ── 1. the row opens it, as a REAL control ──────────────────────────────────
// A `<tr onClick>` cannot carry a focus ring, an accessible name or a role without
// breaking the table's semantics for assistive tech, so the result opens from a button in
// the row — the same way the Inspections tab one click away opens its report.
ok('the Checklists table opens the result from a control, not a row click',
  /className="btn btn-link btn-sm"[^>]*onClick=\{\(\) => setResultRow\(c\)\}/.test(HUB));
ok('…and no <tr> in the hub carries a click handler', !/<tr[^>]*onClick/.test(HUB));
ok('…with visible words, so it is not an unlabelled affordance', />View result</.test(HUB));
// One of up to 20 identical-looking buttons: its accessible name has to say WHICH result
// it opens (CS-549's lesson on this feature's sibling), and the visible words lead it so a
// voice user can say what they read (WCAG 2.5.3).
// …and the name has to be UNIQUE among them. Checklist + customer + day is not: two
// cleaners submit the same checklist at the same customer on one night whenever one covers
// for the other (lib/jobCover), and that also made the name say LESS than the visible row,
// which carries a By column. The cleaner and the time are in it.
ok('…and an accessible name that names the checklist, the location, the CLEANER and the time',
  /aria-label=\{resultActionLabel\(c\)\}/.test(HUB)
  && /'View result',\s*c\.template_snapshot\?\.name,\s*clientLabel\(c\) \|\| siteLabel\(c\),\s*byName\(c\),\s*c\.performed_at \? `\$\{fmtDate\(c\.performed_at\)\} \$\{fmtTime\(c\.performed_at\)\}`/.test(HUB));

// "24/26" alone never said whether that was a finished checklist. The badge says it in
// words — by the SAME rule the clock-out gate reached its verdict with, over the row's own
// stored counts, so the table can never contradict the block a cleaner met.
//
// 🔴 READ AS ONE EXPRESSION, POLARITY INCLUDED. `/Not finished/` beside
// `/isChecklistComplete\(c\)/` both still match when the condition is INVERTED, so every
// finished checklist could read "Not finished" with the suite green (reviewer A's U3
// mutant). A static assertion can honestly hold the whole conditional; it cannot hold what
// the browser paints, so this is where it stops.
ok('an unfinished checklist — and ONLY an unfinished one — is flagged in the table',
  /\{!isChecklistComplete\(c\) && <span className="cr-row-flag"><Badge variant="red">Not finished<\/Badge><\/span>\}/.test(HUB));
ok('…by the shared rule, never a restated comparison',
  /from '\.\.\/lib\/crewChecklist'/.test(HUB) && !/completed_count >= c\.total_count|c\.completed_count ===/.test(HUB));
ok('…and the new column did not leave the table\'s spans behind',
  !/colSpan=\{5\}/.test(HUB.slice(HUB.indexOf("tab === 'checklists'"))) );

// ── 2. it is READ-ONLY, and it reads the row the tab already holds ──────────
// `checklists/list` is `select('*')` and the route hands the rows over as they are, so
// every field is already on the row. The list is crew-scoped SERVER-side
// (`applyCrewScope(…, 'completed_by_user_id')`), so a viewer can only open a result they
// were already handed — a second permission here would only hide a record from someone
// already holding it.
ok('the pop-up takes the row it was given', /function ChecklistResultModal\(\{ open, result, onClose \}\)/.test(MODAL));
ok('…and fetches nothing', modalLacks(/qcApi|fetch\(|useEffect\([^)]*api/));
ok('…and writes nothing', modalLacks(/dispatch|ACTIONS\./));
ok('…and gates on no permission of its own', modalLacks(/usePermission/));
ok('the hub mounts it from the row it opened', /<ChecklistResultModal open=\{!!resultRow\} result=\{resultRow\}/.test(HUB));

// ── 3. the rule lives in the pure module, and the pop-up only renders it ────
ok('the pop-up reads the shared projection', /projectChecklistResult/.test(MODAL));
ok('…and the shared filter, never a second copy of the rule', /filterResultItems/.test(MODAL));
ok('…and restates no counting arithmetic of its own',
  modalLacks(/completed_count|total_count|\.filter\(\(i\) => i\.checked/));
ok('the projection reads the ONE counting rule\'s primitives',
  /from '\.\/checklistCount\.js'/.test(VIEW) && /submittedItemKey/.test(VIEW) && /itemAllowsNa/.test(VIEW));
ok('…and the clock-out gate\'s completeness rule, over the STORED counts',
  /isChecklistComplete/.test(VIEW) && /from '\.\/crewChecklist\.js'/.test(VIEW));

// ── 4. what the pop-up shows, in the order the owner picked (variant A) ─────
ok('the header is the checklist\'s name from the snapshot', /title=\{view\.name\}/.test(MODAL));
ok('the meta line says where, who and when', /cr-meta/.test(MODAL) && /Completed by \{cleaner\}/.test(MODAL));
// The org's wall clock, through the shared helpers — never a hand-rolled format and never
// the device's zone (THE LAW II.8: all calendar math in the ORG's timezone).
ok('…and "when" is the org\'s zone through the shared date helpers',
  /fmtDateLong\(result\.performed_at\)/.test(MODAL) && /fmtTime\(result\.performed_at\)/.test(MODAL)
  && /from '\.\.\/lib\/dates'/.test(MODAL));
// "done", or "resolved" when the cleaner marked a task not completed (Matt, 2026-10-13) —
// still the row's own stored counts either way.
ok('the summary leads with the row\'s OWN counts',
  /\{stored\.done\} of \{stored\.total\} \{headWord\}/.test(MODAL)
  && /const headWord = counts\.notCompleted \? 'resolved' : 'done';/.test(MODAL));
ok('…badged "Not finished" when, and only when, it is not complete',
  /\{!view\.complete && <Badge variant="red">Not finished<\/Badge>\}/.test(MODAL));
ok('…with the quiet breakdown beside it', /marked N\/A/.test(MODAL) && /not done/.test(MODAL));
ok('…and a progress bar that is decoration, not information',
  /cr-bar" aria-hidden="true"/.test(MODAL));
// A derived total that disagrees with the stored one (an old row, a hand-edited one, a lost
// snapshot) is said out loud: the stored counts stay the headline rather than two truths
// sitting silently side by side. Each of the three conditionals below is matched as ONE
// expression — its guard and the block it guards — so a `{false && …}` wrapper, or an
// inverted guard, fails here instead of shipping a notice nothing can ever render.
ok('a stored/derived disagreement is said in words, and the stored counts stay the headline',
  /\{view\.countsDisagree && \(\s*<p className="cr-note-disagree[^]{0,120}Recorded as \{stored\.done\} of \{stored\.total\} when it was submitted/.test(MODAL));
// The projection asks it of EVERY record now, schema or not: a lost snapshot is exactly
// where the two come apart, and that used to be the one case guarded out.
ok('…and the projection asks it of a snapshot-less record too',
  /countsDisagree: counts\.total !== stored\.total \|\| counts\.done !== stored\.done/.test(VIEW)
  && !/countsDisagree: hasSchema/.test(VIEW));
// A tooltip never shows on a phone (the publish-refusal precedent), so the fallback notice
// is visible text.
ok('a record with no usable snapshot says so in VISIBLE text, not a title attribute',
  /\{!view\.hasSchema && \(\s*<p className="callout callout-info/.test(MODAL)
  && /structure wasn’t recorded/.test(MODAL_TEXT) && !/title=\{[^}]*structure/.test(MODAL_TEXT));
ok('the exceptions come FIRST, and the block is absent when there are none',
  /\{view\.exceptions\.length > 0 && \(\s*<div className="cr-flags">[^]{0,120}Needs a look \(\{view\.exceptions\.length\}\)/.test(MODAL));

// ── 5. the controls are kit controls, named by what they act on ─────────────
ok('the filters are the kit\'s .chip (UI_RULES §124), not a bespoke pill',
  /className=\{`chip cr-chip \$\{filter === c\.key \? 'on' : ''\}`\}/.test(MODAL));
ok('…each saying whether it is the one in force', /aria-pressed=\{filter === c\.key\}/.test(MODAL));
// CS-549 is an open Low on this feature's sibling: an N/A control whose accessible name is
// just "N/A". Not repeated here — and each visible label is contained in its accessible
// name, so a voice user can say what they read (WCAG 2.5.3).
ok('…and an accessible name that says what it does, never a bare "Everything"',
  /aria-label=\{c\.aria\}/.test(MODAL) && /aria: 'Show everything'/.test(MODAL)
  && /aria: 'Show N\/A only'/.test(MODAL));
ok('…with the vocabulary and the order coming from the rule module, so the two cannot drift',
  /RESULT_FILTERS\.map\(\(key\) => \(\{ key, \.\.\.CHIP_TEXT\[key\] \}\)\)/.test(MODAL));
ok('an area collapses from a real button that reports its state',
  /className="cr-area-head"/.test(MODAL) && /aria-expanded=\{!isClosed\}/.test(MODAL) && /aria-controls=\{listId\}/.test(MODAL));
ok('…and the collapsed items leave the accessibility tree, not just the screen',
  /<ul className="cr-items" id=\{listId\} hidden=/.test(MODAL));
ok('…and that bespoke family is classified in the control ledger (UI_RULES §128)',
  /"\.cr-area-head": \{ "role": "row"/.test(LEDGER));
// Nothing may depend on telling green from red, or on reading a glyph.
ok('each item states its own state in words', /\{SAYS\[i\.state\]\}/.test(MODAL));
ok('…and the coloured mark beside it is hidden from assistive tech',
  /className=\{`cr-ico \$\{i\.state\}`\} aria-hidden="true"/.test(MODAL));

// ── 6. the actions ──────────────────────────────────────────────────────────
ok('Close is a kit button', /className="btn btn-outline" onClick=\{onClose\}>Close</.test(MODAL));
// Every production row today carries no job_id (the office flow writes none), so the
// second action must be absent rather than dead.
ok('"Open the clean" appears ONLY when the submission is bound to a clean',
  /\{result\.job_id && \(\s*<button type="button" className="btn btn-primary" onClick=\{openClean\}>Open the clean<\/button>/.test(MODAL));
// CLAUDE.md's nav convention + lint:backnav: a link into a back-arrow page carries its
// referrer, so the clean's back arrow returns to the hub the manager came from.
ok('…and it carries its referrer, so Back returns to the hub',
  /useFromHere/.test(MODAL) && /navigate\(`\/schedule\/\$\{jobId\}`, \{ state: nav \}\)/.test(MODAL));
// …and the referrer has to carry a LABEL, or the pill reads the destination's own fallback:
// off a clean it said "← Schedule", the page it had just left. deriveFromLabel's if-chain is
// the shared list every list page joins.
ok('…and the referrer names the hub, so the pill does not read "Schedule"',
  // CS-193: the label is Quality's catalog key, rendered in the reader's language.
  /pathname === '\/inspections'\) return 'nav\.quality'/.test(FROM_HERE));

// ── 7. the keyboard, and the dialog ─────────────────────────────────────────
// `Modal` closes on Esc but moves no focus, so the keyboard would otherwise stay on the
// table behind the overlay. The scroll region takes it, which also makes the arrow keys
// scroll the thing focus landed on.
ok('opening the pop-up moves focus into it', /bodyRef\.current\.focus\(\)/.test(MODAL));
ok('…onto its scroll region, which is focusable for that reason',
  /className="cr-body" ref=\{bodyRef\} tabIndex=\{-1\}/.test(MODAL));
ok('…and that region shows a focus ring', /\.cr-body:focus-visible/.test(CSS));
// Esc otherwise dropped focus to <body> and a keyboard reader lost their place in a 20-row
// table. `Modal` restores nothing, so the pop-up hands focus back itself — read as one
// expression, guard included, so a dropped `document.contains` (which would throw at a
// detached node after "Open the clean") or an inverted guard fails here.
ok('closing gives focus BACK to the control that opened it',
  /openerRef\.current = document\.activeElement/.test(MODAL)
  && /if \(opener && typeof opener\.focus === 'function' && document\.contains\(opener\)\) opener\.focus\(\);/.test(MODAL));
// The capture must be declared BEFORE the focus effect: effects run in declaration order,
// so capturing after it captured the dialog's own body and restored nothing (measured —
// Esc still landed on <body>).
ok('…and it remembers the opener BEFORE moving focus into the dialog',
  MODAL.indexOf('openerRef.current = document.activeElement') < MODAL.indexOf('bodyRef.current.focus()'));
ok('the area toggle shows one too', /\.cr-area-head:focus-visible/.test(CSS));
// A different result reopens clean: a manager stepping through a week of cleans never
// reads one night through the filter they left on the last one.
ok('a different result reopens with every area expanded and the filter reset',
  /setFilter\('all'\);/.test(MODAL) && /setCollapsed\(\{\}\);/.test(MODAL));
// The overlay was an unnamed pile of text to a screen reader: no role, no name. One fix in
// the shared Modal, so every pop-up in the app is announced as the dialog it is.
ok('the app\'s Modal declares itself a dialog', /role="dialog"/.test(KIT_MODAL));
ok('…named by the header it already shows',
  /aria-labelledby=\{titleId\}/.test(KIT_MODAL) && /<h2 id=\{titleId\}>\{title\}<\/h2>/.test(KIT_MODAL));
// 🔴 AND IT CLAIMS NO INERTNESS IT CANNOT KEEP. `aria-modal="true"` promises the rest of
// the page is inert; this Modal traps no focus (five Tabs leave an open pop-up for the nav
// behind the overlay, and two sibling dialogs can be open at once — measured). Telling a
// screen reader a boundary exists where the keyboard walks straight through is worse than
// saying nothing. A real trap changes behaviour for all 63 dialogs and is its own build.
ok('…and claims no modality, because nothing here traps focus',
  !/aria-modal/.test(KIT_MODAL));

// ── 8. the phone ────────────────────────────────────────────────────────────
// Cleaners and managers open this on a phone. `.chip` is 32px and the area toggle 36px,
// both under the touch floor, so each takes the kit's --control-height-lg inside the phone
// block — the same 44px floor `.chip-remove` and `.btn-icon` take (UI_RULES §123).
const phoneBlock = /@media \(max-width: 640px\)\s*\{(?:(?!@media)[^])*?/;
ok('the filter chips reach the 44px floor on a phone',
  new RegExp(phoneBlock.source + '\\.cr-chip\\s*\\{[^}]*--control-height-lg').test(CSS));
ok('…and so does an area\'s collapse',
  new RegExp(phoneBlock.source + '\\.cr-area-head\\s*\\{[^}]*--control-height-lg').test(CSS));
// Three columns squeeze the label at 320px; the state drops under it rather than the row
// growing a sideways scroll.
ok('an item\'s state drops below its label at phone width, so nothing scrolls sideways',
  new RegExp(phoneBlock.source + '\\.cr-item\\s*\\{[^}]*grid-template-columns').test(CSS));
// A note is the cleaner's free text and they paste into it. One unbroken token (a photo
// URL) has no break opportunity, so the POP-UP scrolled sideways — 93px at 375, 144px at
// 320 — while the page itself stayed clean, which is why no gate caught it. All three
// places a note or a label can land have to break it.
for (const sel of ['\\.cr-label', '\\.cr-note', '\\.cr-flags-list li']) {
  ok(`a pasted URL in a note cannot widen the pop-up (${sel.replace(/\\/g, '')})`,
    new RegExp(`${sel}\\s*\\{[^}]*overflow-wrap:\\s*anywhere`).test(CSS));
}

if (fails.length) { console.error('\nchecklist-result-ui FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\nchecklist-result-ui: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
