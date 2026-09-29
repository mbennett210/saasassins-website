// test-control-parity — controls that must look alike are declared alike, and retired one-off controls stay gone
// (UI_RULES §7, §109, §115, §123–§127; registers CS-357 to CS-365).
//
// 1. Parity groups: selectors that render one control under different names declare the same shape. §7's three
//    segmented class pairs "render identically": until 2026-09-25 `.segmented` was the retired flush fill (a glass
//    track, square segments with dividers, 12px) and `.messaging-inbox-toggle` had a grey track. Now each group is
//    checked property by property, so a divergence fails here instead of reading as a fourth style. The segments
//    also lay out an icon or a count alike (display, alignment, gap).
// 2. Retired names: one-off controls that duplicated a kit control were migrated to it (the pager, the attach
//    picker, "Read & Reply", the retry buttons, New conversation's "more", Messaging's second icon square, the
//    10px-text btn-xs, the compact segmented, and the fourth tab styles: Marketing's glass pills, the customer
//    Activity toggle, the Messages dock's grey track, the layout picker's range switch, the payroll drawer's tabs,
//    the dead dashboard switcher), 25 icon-only controls and close glyphs (§123), eight chip styles (§124) and five
//    dashed add tiles (§125), nine text-action one-offs and the Marketing pagers (§126), and eight menu-row
//    styles (§127). A retired class reappearing in a stylesheet or a component fails.
// 3. One size per kit control: only the base rule, the phone tap-target rule and the documented exceptions may size
//    an icon square, the surface close or a chip (a 24px .btn-icon in one card was a fourth size). Each documented
//    exception names the properties it may set.
// 4. A text button wears .btn: a bare .btn-link (a 30px box with no kit height) is retired; a link in running text
//    is .linklike (UI_RULES §126).
// 5. No stylesheet rule dresses a bare <button> through a parent (`.x button { … }`): that styles a control around
//    the kit, the way the Keys menu, the Payroll and Supplies steppers and a Marketing chip were (UI_RULES §127).
// 6. The kit's type holds wherever a control lands (the step ④ interaction pass, 2026-09-25). A segment label is
//    one line: a wrapped "Super Admin" grew the user menu's segment to 52px. An icon square sets its glyph's type:
//    the Supplies steppers' + and − and the stage arrows fell to the browser's 13px regular. The text link's font
//    reset is zero-specificity (:where), so a row class or a type utility that sizes the link wins: the reset
//    had turned an employee document's 13px name to 16px and would have done the same to every .text-xs link.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { declared as topLevel, styleRules } from './css-rules.mjs';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const CSS_RAW = fs.readFileSync(SRC + 'index.css', 'utf8');

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed += 1; console.error(`  ✗ ${msg}`); } };

/** The top-level declarations of a selector (list members count; @media overrides are scoped apart). */
const declared = (sel) => topLevel(CSS_RAW, sel);

const GROUPS = [
  { name: 'the §7 segmented tracks', sels: ['.tab-container-line', '.messaging-inbox-toggle', '.segmented'],
    props: ['display', 'grid-auto-flow', 'grid-auto-columns', 'background', 'border', 'border-radius', 'padding', 'gap'] },
  { name: 'the §7 segments', sels: ['.tab-btn', '.inbox-toggle-btn', '.segmented-btn'],
    props: ['display', 'align-items', 'justify-content', 'gap', 'padding', 'border', 'border-radius', 'font-size', 'font-weight', 'color', 'background', 'white-space'] },
  { name: 'the §7 active segments', sels: ['.tab-btn.active', '.inbox-toggle-btn.active', '.segmented-btn.active'],
    props: ['background', 'color', 'box-shadow'] },
];
console.log('parity groups');
for (const g of GROUPS) {
  const decls = g.sels.map((s) => [s, declared(s)]);
  for (const p of g.props) {
    const vals = decls.map(([, d]) => d[p]);
    ok(vals.every((v) => v !== undefined && v === vals[0]), `${g.name}: ${p} is one value (${decls.map(([s, d]) => `${s} ${d[p] ?? '—'}`).join(' · ')})`);
  }
}

// retired one-off control classes → the kit control that replaced each
const RETIRED = {
  'list-pager-btn': '.btn.btn-outline (ListPager)',
  'attachment-picker-label': '.btn.btn-outline',
  'email-expand-btn': '.btn.btn-sm.btn-gold',
  'msg-retry-btn': '.btn.btn-sm.btn-outline',
  'newconv-more': '.btn.btn-outline',
  'marketing-diag-retry': '.btn.btn-outline',
  'icon-btn': '.btn-icon',
  'btn-xs': '.btn.btn-sm or the 32px .btn',
  'segmented-sm': '.segmented (§7 has one size)',
  'btn-deny': '.btn-danger',
  // the fourth tab styles (UI_RULES §7 "do not invent a fourth style"; register CS-359)
  'settings-pills': '.tab-container.tab-container-line (Marketing)',
  'settings-pill': '.tab-btn',
  'settings-pill-wrap': '.marketing-tabs (placement only)',
  'settings-pill-badge': '.control-count / .inbox-toggle-unread',
  'activity-toggle': '.tab-container.tab-container-line (customer Activity)',
  'activity-toggle-btn': '.tab-btn',
  'activity-toggle-count': '.control-count',
  'cs-msg-seg': '.messaging-inbox-toggle (the Messages dock)',
  'cs-msg-seg-btn': '.inbox-toggle-btn',
  'cs-msg-seg-count': '.inbox-toggle-unread',
  'dlp-seg': '.segmented (the layout picker range)',
  'pay-tab': '.section-tab (UI_RULES §69)',
  'dash-switcher': 'a §7 tab bar',
  'dash-sw-btn': '.tab-btn',
  // icon-only controls and close glyphs (UI_RULES §123; register CS-360)
  'cs-msg-icon-btn': '.btn-icon.btn-icon-ghost',
  'thread-star-btn': '.btn-icon.btn-icon-ghost',
  'thread-row-menu-btn': '.btn-icon.btn-icon-ghost',
  'toast-close': '.btn-icon.btn-icon-ghost',
  'bell-item-dismiss': '.btn-icon.btn-icon-ghost',
  'btn-icon-sm': '.btn-icon',
  'cleaning-area-btn': '.btn-icon',
  'cleaning-area-remove': '.btn-icon.btn-icon-danger',
  'stage-row-delete': '.btn-icon.btn-icon-danger',
  'pay-x': '.btn-icon.btn-icon-danger',
  'hr-doc-x': '.btn-icon.btn-icon-danger',
  'schedule-block-remove': '.btn-icon.btn-icon-danger',
  'marketing-blackout-remove': '.btn-icon.btn-icon-danger',
  'marketing-step-attach-remove': '.btn-icon.btn-icon-danger',
  'opp-quick-btn': '.btn-icon.btn-icon-primary',
  'sheet-close': '.modal-close',
  'pay-icon-btn': '.modal-close',
  'wo-x': '.modal-close',
  'tag-remove': '.chip-remove',
  'email-attachment-remove': '.chip-remove',
  'table-search-clear': '.input-clear',
  'msearch-clear': '.input-clear',
  'media-del': '.thumb-remove',
  'ticket-thumb-remove': '.thumb-remove',
  // chips (UI_RULES §124; register CS-361)
  'filter-chip': '.chip',
  'keys-filter-chip': '.chip',
  'keys-filter-count': '.control-count',
  'wo-chip': '.chip',
  'wo-chip-k': '.control-count',
  'msearch-lp-chip': '.chip',
  'marketing-flow-tally': '.chip.chip-sm',
  'marketing-reply-bucket-count': '.control-count',
  'role-toggle': '.chip.chip-sm',
  'sched-unassigned-chip': '.chip.chip-danger',
  'user-quick-btn': '.segmented-btn',
  'tab-count': '.control-count (renamed)',
  'rel-chip': 'a kit .chip in DetailHeader\'s relationship slot',
  'notif-chip': 'nothing (dead since the clone)',
  'token-row': 'nothing (dead)',
  // add tiles (UI_RULES §125; register CS-362)
  'pipeline-col-add': '.add-tile',
  'pipeline-col-empty-clickable': '.add-tile',
  'schedule-block-add': '.add-tile',
  'marketing-inbox-ghost': '.add-tile',
  'marketing-inbox-ghost-icon': 'the tile\'s own icon gap',
  'disclosure-toggle': '.btn.btn-link with a chevron',
  // text actions and the last bespoke buttons (UI_RULES §126; register CS-363)
  'hr-link': '.linklike',
  'wo-clearlink': '.linklike',
  'enroll-banner-link': '.linklike',
  'marketing-pagination': 'ListPager',
  'marketing-pagination-btn': 'ListPager',
  'enroll-pager': 'ListPager',
  'enroll-pager-label': 'ListPager',
  'dash-layout-note-btn': '.btn.btn-outline',
  'visit-checklist-btn': '.btn.btn-gold',
  // menu options (UI_RULES §127; register CS-364)
  'select-option': '.menu-option',
  'tag-picker-option': '.menu-option',
  'status-option': '.menu-option',
  'status-option-typed': '.status-typed (the vendor divider)',
  'status-option-snooze': 'nothing (dead)',
  'thread-row-menu-item': '.menu-option',
  'user-menu-item': '.menu-option',
  'contact-picker-clear': '.menu-option.menu-option-danger',
  // triggers (UI_RULES §109; register CS-365)
  'contact-picker-trigger': '.select-trigger (the field primitive)',
  'client-status-trigger': '.badge-trigger',
  'key-status-trigger': '.badge-trigger',
};
console.log('retired names');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.(css|jsx?)$/.test(e.name) ? [path.join(d, e.name)] : []);
const files = walk(SRC).map((f) => ({ rel: path.relative(SRC, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') }));
for (const [cls, kit] of Object.entries(RETIRED)) {
  const re = new RegExp(`(^|[^\\w-])${cls}(?![\\w-])`);
  const hits = files.filter((f) => re.test(f.text)).map((f) => f.rel);
  ok(hits.length === 0, `.${cls} is retired (use ${kit})${hits.length ? `: still in ${hits.join(', ')}` : ''}`);
}

// 3. the rules allowed to size a kit control ('<@-prelude>|<selector list>'), each with the properties it may set
//    ('*' = the kit rule itself)
const BOX = ['width', 'height', 'min-width', 'min-height'];
const SIZERS = {
  '.btn-icon': { props: BOX, allowed: {
    '|.btn-icon': '*',
    '@media (max-width: 640px)|.btn-icon, .modal-close': ['width', 'height'],
    '@media (max-width: 640px)|.thread-row .btn-icon': ['width', 'height'],
    '@container msgpane (max-width: 640px)|.message-pane-actions .btn-icon': ['width', 'height'],
  } },
  '.modal-close': { props: BOX, allowed: { '|.modal-close': '*', '@media (max-width: 640px)|.btn-icon, .modal-close': ['width', 'height'] } },
  // the add tile's look lives in .add-tile; its containers (a sequence's flow row) only place and size the slot
  '.add-tile': { props: ['padding', 'border', 'border-width', 'border-style', 'border-radius', 'font-size', 'font-weight'], allowed: { '|.add-tile': '*' } },
  // .chip-sm is its own class; the job editor's day picker is the one dense exception (a week fits one row)
  '.chip': { props: [...BOX, 'padding', 'font-size'], allowed: { '|.chip': '*', '|.day-picker .chip': ['min-width', 'padding', 'font-size'] } },
};
console.log('one size per kit control');
{
  const rules = styleRules(CSS_RAW);
  for (const [cls, { props, allowed }] of Object.entries(SIZERS)) {
    const re = new RegExp(`\\${cls}(?![\\w-])`);
    const sizing = rules.filter((r) => r.sels.some((s) => re.test(s)) && props.some((p) => p in r.decl))
      .map((r) => ({ key: `${r.at}|${r.sels.join(', ')}`, set: props.filter((p) => p in r.decl) }));
    const extra = sizing.filter(({ key, set }) => !(key in allowed) || (allowed[key] !== '*' && set.some((p) => !allowed[key].includes(p))))
      .map(({ key, set }) => `${key} {${set.join(', ')}}`);
    ok(extra.length === 0, `${cls} is sized only by its base rule and the documented exceptions${extra.length ? `: also ${extra.join(' · ')}` : ''}`);
    ok(Object.keys(allowed).every((k) => sizing.some((s) => s.key === k)), `${cls}: every documented sizing rule is still there`);
  }
}

// 4. every .btn-link also wears .btn
console.log('text buttons wear .btn');
{
  const bare = [];
  for (const f of walk(SRC).filter((p) => /\.jsx?$/.test(p))) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/className=(\{`[^`]*`\}|"[^"]*"|'[^']*')/g)) {
      const toks = m[1].replace(/\$\{[^}]*\}/g, ' ').replace(/[{}`"']/g, ' ').split(/\s+/).filter(Boolean);
      if (toks.includes('btn-link') && !toks.includes('btn')) bare.push(`${path.relative(SRC, f).split(path.sep).join('/')}:${text.slice(0, m.index).split('\n').length}`);
    }
  }
  ok(bare.length === 0, `every .btn-link also wears .btn (a link in running text is .linklike)${bare.length ? `: bare in ${bare.join(', ')}` : ''}`);
}

// 5. no rule dresses a bare <button> through a parent selector
console.log('no parent-dressed buttons');
{
  const dressed = [];
  for (const f of walk(SRC).filter((p) => /\.css$/.test(p))) {
    for (const r of styleRules(fs.readFileSync(f, 'utf8'))) {
      for (const s of r.sels) if (/[\s>+~]button(?![\w-])/.test(s)) dressed.push(`${path.relative(SRC, f).split(path.sep).join('/')}: ${s}`);
    }
  }
  ok(dressed.length === 0, `no stylesheet rule dresses a bare <button> through a parent (give it a kit class)${dressed.length ? `: ${dressed.slice(0, 6).join(' · ')}` : ''}`);
}

// 6. the kit's type holds wherever a control lands
console.log('kit type');
{
  ok(declared('.segmented-btn')['white-space'] === 'nowrap', `a §7 segment label is one line (.segmented-btn white-space: ${declared('.segmented-btn')['white-space'] ?? '—'}; the parity group holds the other two)`);
  const icon = declared('.btn-icon');
  ok(Boolean(icon['font-size'] && icon['font-weight']), `.btn-icon sets its glyph's type (font-size ${icon['font-size'] ?? '—'}, font-weight ${icon['font-weight'] ?? '—'})`);
  const link = declared('.linklike');
  const sized = ['font', 'font-size', 'font-weight', 'line-height', 'font-family'].filter((p) => p in link);
  ok(sized.length === 0, `.linklike declares no type at class specificity${sized.length ? ` (it sets ${sized.join(', ')})` : ''}`);
  ok(declared(':where(.linklike)').font === 'inherit', ':where(.linklike) resets the font to its text, at zero specificity');
}

if (failed) { console.error(`\n✗ test-control-parity: ${failed} check(s) failed`); process.exit(1); }
console.log('\n✓ test-control-parity: look-alike controls are declared alike, retired one-offs stay gone');
