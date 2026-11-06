// A notification must not strand a cleaner on "Job not found".
//
// ══ THE DEFECT ════════════════════════════════════════════════════════════════
// A notification's `url` outlives the record it points at. The reducer scrubs
// `/schedule/<id>` links when IT deletes a job — DELETE_JOB, DELETE_JOB_SERIES, and
// (since the multi-block work) UPDATE_JOB_SERIES' day drop. But the app is not the
// only thing that deletes jobs: a retention tail-trim run as bulk SQL removes rows
// with no reducer action, so no scrub ever fires.
//
// Measured on LIVE 2026-07-22, checked against the FULL public.jobs table rather than
// the windowed browser cache: 50 bell rows pointing at 29 job ids that no longer
// exist, 46 of them UNREAD, spread across 20 real crew. Six were traced to a single
// bulk statement — every one of them tombstoned at exactly 2026-07-21T23:48:25.984Z,
// the tail trim. Tapping one lands a cleaner on "Job not found".
//
// Delete-time scrubbing therefore cannot be the whole answer, because the delete does
// not always go through the app. The read side has to cope. That is what this pins.
//
// ══ THE TRAP THIS GUARDS ══════════════════════════════════════════════════════
// "Not in state.jobs" does NOT mean "deleted". That array is the jobs WINDOW (−45/+100
// days) — and since CS-676 it never grows into the whole table — so judging liveness
// against it marks every out-of-window job dead and strips working links off
// notifications for real future cleans. The first count of this very bug was wrong by 20
// for exactly that reason. The check MUST ask the table about the rows' cleans (by id)
// first, and MUST fail safe until it has answered (every link treated as live).
//
//   node scripts/test-notification-dead-links.mjs
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const src = readFileSync(new URL('../src/components/NotificationsBell.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

// ── 🔴 the gate: the table has answered for these cleans ────────────────
ok('the bell asks the table for its rows\' cleans by id', /jobsLoader\.ensureIds\(linkedKey\.split\(','\)\)/.test(src));
ok('🔴 liveness is judged ONLY once the table has answered for exactly these cleans',
  /const judged = open && !!linkedKey && askedKey === linkedKey;/.test(src));
ok('  ...so an unanswered ask yields NO dead links (fails safe)',
  /!judged \? ''/.test(src) && /\.then\(\(\) => \{ if \(alive\) setAskedKey\(linkedKey\); \}, \(\) => \{\}\)/.test(src));
// If the panel is shut there is nothing to judge, and this component is mounted for
// the whole session — touching s.jobs on every dispatch would undo the useSelector work.
ok('  ...and the job set is only touched while the panel is open', /const judged = open &&/.test(src));

// ── the selector stays cheap ───────────────────────────────────────────
// Returning a Set/array would be a fresh reference every call and re-render the bell
// on every dispatch. A joined string is settled by the default Object.is comparer.
ok('the selector returns a scalar, not a fresh reference',
  /deadJobIds\(s\.jobs, items\)\.join\(','\)/.test(src));
ok('  ...and is rebuilt into a Set once per change, memoized on that string',
  /useMemo\(\(\) => new Set\(deadKey \? deadKey\.split\(','\) : \[\]\), \[deadKey\]\)/.test(src));

// ── only /schedule/<id> links are judged ───────────────────────────────
// Invoice / contact / messaging notifications must be untouched by this.
ok('only /schedule/<id> urls are parsed for a job id',
  /\/\^\\\/schedule\\\/\(\[\^\/\?#\]\+\)\$\//.test(src) || /\^\\\/schedule\\\//.test(src));
ok('a url with no job id is never treated as dead', /return !!id && deadIds\.has\(id\)/.test(src));

// ── behaviour ──────────────────────────────────────────────────────────
ok('🔴 a dead link does NOT navigate', /if \(n\.url && !isDeadLink\(n\)\) navigate/.test(src));
ok('  ...but still marks read', /if \(!n\.readAt\) dispatch\(\{ type: ACTIONS\.MARK_NOTIFICATION_READ/.test(src));
// The row is real history — the clean WAS assigned. Hiding it would be a second lie.
// CS-193: the label is the catalog's line, in the reader's language.
ok('  ...and the row is labelled rather than hidden', /t\('notif\.cleanRemoved'\)/.test(src)
  && /'notif\.cleanRemoved': 'clean removed',/.test(readFileSync(new URL('../src/i18n/catalog/en.js', import.meta.url), 'utf8')));
ok('  ...with an explanatory tooltip', /t\('notif\.removedTitle'\)/.test(src)
  && /'notif\.removedTitle': 'This clean was removed from the schedule',/.test(readFileSync(new URL('../src/i18n/catalog/en.js', import.meta.url), 'utf8')));
ok('the row carries a dead-link class for styling', /dead-link/.test(src));

// ── styling ────────────────────────────────────────────────────────────
ok('a dead row does not present as clickable', /\.bell-item\.dead-link \.bell-item-btn \{ cursor: default; \}/.test(css));
ok('  ...and is visually muted', /\.bell-item\.dead-link \.bell-item-title/.test(css));

// ── the delete-time scrubs still exist (belt AND braces) ───────────────
// Read-time resilience covers deletes the app never saw; the scrubs keep the blob
// clean for the ones it did. Losing either is a regression.
{
  const reducer = readFileSync(new URL('../src/store/reducer.js', import.meta.url), 'utf8');
  ok('DELETE_JOB_SERIES still scrubs dead urls', (reducer.match(/const deadUrls = new Set\(/g) || []).length >= 2);
  ok('UPDATE_JOB_SERIES day-drop still scrubs dead urls', /\[\.\.\.droppedIds\]\.map\(\(rid\) => `\/schedule\/\$\{rid\}`\)/.test(reducer));
}

const total = pass + fails.length;
console.log(`notification dead links: ${pass}/${total} passed`);
for (const f of fails) console.log(`  FAIL: ${f}`);
process.exit(fails.length ? 1 : 0);
