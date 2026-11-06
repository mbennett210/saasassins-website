// ONE VIEW PER RECORD (task #130 from Clean Corner's queue, CS-885). A view that holds something
// typed for ONE record (a note, a reply, a comment), or a per-visit id or confirm flag, must be
// rebuilt when its record changes; React reuses a component left at the same place with no key, so
// what was typed for one record stayed on screen for the next and was saved there.
//   V  Review's focus flow: ReviewFocus rendered DraftCard / DecisionCard with no key, so Next, Back
//      and Skip kept the card: a note typed but not added sat in the next item's box (Add note or
//      leaving then posted it THERE), the visit's sitting and a confirmed "Change" carried over, and
//      a text answer typed on a tap that did not blur was saved on the next question. Now each item
//      gets its own card (key = the item id): leaving it unmounts it, so its unsent note posts on
//      the item it was typed for (ReviewNotes) and a dirty text answer saves there (useSyncedText).
//      Proven by RENDERING ReviewFocus (rolldown, the cards stubbed) and reading the keys it gives.
//   I  the inventory: the note box and the synced answer box are used only where one instance
//      serves one item (the keyed cards; a layout picker reviews one fixed pick)
//   R  the record routes that kept a typed box across records (App.jsx `KeyedByParam`, "A different
//      record = a fresh page"): the hub's request page (its reply box; the hub's bell opens another
//      request in place) and the office's order page (its comment box and the comment's minted id;
//      the bell opens another order in place). The crew's order page was already keyed.
// REGRESSION (THE LAW II.3): on 0481431c (the tree before the fix) 8 of 15 checks fail (V1–V5, V7,
// R1, R2); the 7 that pass there are the controls, V6 and the inventory, which the fix leaves as is.
//   node app/scripts/test-view-per-record.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). Label first.
const ok = (label, cond, detail) => { if (cond) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`); };
const read = (rel) => { try { return fs.readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };
const srcFiles = (dir) => fs.readdirSync(path.join(APP, dir), { withFileTypes: true }).flatMap((e) => {
  const rel = path.join(dir, e.name);
  if (e.isDirectory()) return srcFiles(rel);
  return /\.jsx?$/.test(e.name) ? [rel.split(path.sep).join('/')] : [];
});
const SRC = srcFiles('src');
const usersOf = (re) => SRC.filter((f) => re.test(read(f)));

// ── V. Review's focus flow: one card per item, proven from a render ─────────────────────────
// ReviewFocus has no hooks, so calling it returns its element tree; the cards are stubbed (their
// own render is not the point) and the walk finds them by type and reads the key React will use.
const CACHE = path.join(APP, 'node_modules', '.cache');
fs.mkdirSync(CACHE, { recursive: true });
const tmp = fs.mkdtempSync(path.join(CACHE, 'test-view-per-record-'));
const abs = (...p) => JSON.stringify(path.join(APP, ...p).split(path.sep).join('/'));
fs.writeFileSync(path.join(tmp, 'entry.jsx'), `export { default as ReviewFocus } from ${abs('src', 'pages', 'review', 'ReviewFocus.jsx')};
export { default as DecisionCard } from 'stub:decision-card';
export { default as DraftCard } from 'stub:draft-card';
`);
const STUBS = {
  '\0decision-card': 'export default function DecisionCard() { return null; }',
  '\0draft-card': 'export default function DraftCard() { return null; }',
  '\0empty-state': 'export default function EmptyState() { return null; }',
};
const plugin = {
  name: 'view-per-record-test',
  resolveId(id, importer) {
    const fromFocus = /[\\/]pages[\\/]review[\\/]ReviewFocus\.jsx$/.test(importer || '');
    if (id === 'stub:decision-card' || (fromFocus && /^\.\/DecisionCard(\.jsx)?$/.test(id))) return '\0decision-card';
    if (id === 'stub:draft-card' || (fromFocus && /^\.\/DraftCard(\.jsx)?$/.test(id))) return '\0draft-card';
    if (fromFocus && /[\\/]components[\\/]EmptyState(\.jsx)?$/.test(id)) return '\0empty-state';
    return null;
  },
  load(id) { return Object.hasOwn(STUBS, id) ? STUBS[id] : null; },
};
let M = null;
try {
  const bundle = await rolldown({
    input: path.join(tmp, 'entry.jsx'), platform: 'node', cwd: APP, logLevel: 'silent', plugins: [plugin],
    transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ MODE: 'test', PROD: false, DEV: true, SSR: true }) } },
  });
  await bundle.write({ file: path.join(tmp, 'focus.mjs'), format: 'esm' });
  M = await import(pathToFileURL(path.join(tmp, 'focus.mjs')).href);
} catch (e) {
  fails.push(`ReviewFocus bundles (${String(e?.message || e).split('\n')[0]})`);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// The cards ReviewFocus draws for item `idx` of a walk: [{ card, key, item }].
const cardsAt = (area, ids, idx) => {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if (node.type === M.DecisionCard) out.push({ card: 'question', key: node.key, item: node.props?.question?.id });
    else if (node.type === M.DraftCard) out.push({ card: 'draft', key: node.key, item: node.props?.draft?.id });
    if (node.props) walk(node.props.children);
  };
  const no = () => {};
  walk(M.ReviewFocus({ area, ids, idx, onBack: no, onNext: no, onSkip: no, onExit: no }));
  return out;
};
if (M && typeof M.ReviewFocus === 'function') {
  const drafts = ['lead-ack', 'walkthrough-confirm'];   // the flag's two drafts, in catalog order
  const a = cardsAt('drafts', drafts, 0);
  const b = cardsAt('drafts', drafts, 1);
  ok('control: the focus card draws the walked draft', a.length === 1 && a[0].card === 'draft' && a[0].item === 'lead-ack' && b[0]?.item === 'walkthrough-confirm', { a, b });
  ok('🔴 V1 each draft gets its own card: the key is the draft\'s id (lead-ack, then walkthrough-confirm on Next)', a[0]?.key === 'lead-ack' && b[0]?.key === 'walkthrough-confirm', { a, b });
  const q1 = cardsAt('hub', ['HUB-1', 'HUB-2'], 0);
  const q2 = cardsAt('hub', ['HUB-1', 'HUB-2'], 1);
  ok('control: the focus card draws the walked question', q1.length === 1 && q1[0].card === 'question' && q1[0].item === 'HUB-1' && q2[0]?.item === 'HUB-2', { q1, q2 });
  ok('🔴 V2 each question gets its own card: the key is the question\'s id (HUB-1, then HUB-2 on Next)', q1[0]?.key === 'HUB-1' && q2[0]?.key === 'HUB-2', { q1, q2 });
  // Next then Back: the key changes at each move, so the card is rebuilt both ways; drawn again for
  // the same item (a keystroke re-renders it) the key holds, so typing never rebuilds the card.
  const keys = [0, 1, 0].map((i) => cardsAt('hub', ['HUB-1', 'HUB-2'], i)[0]?.key);
  const again = cardsAt('hub', ['HUB-1', 'HUB-2'], 1)[0]?.key;
  ok('🔴 V3 Next then Back rebuilds the card each way (HUB-1 → HUB-2 → HUB-1), and a re-render of one item keeps its card',
    JSON.stringify(keys) === JSON.stringify(['HUB-1', 'HUB-2', 'HUB-1']) && again === 'HUB-2', { keys, again });
  const open = ['PAY-1', 'lead-ack'];   // the "Everything open" walk mixes questions and drafts
  const o1 = cardsAt('open', open, 0);
  const o2 = cardsAt('open', open, 1);
  ok('🔴 V4 a mixed walk keys both kinds by the item (PAY-1, then lead-ack)', o1[0]?.key === 'PAY-1' && o1[0]?.card === 'question' && o2[0]?.key === 'lead-ack' && o2[0]?.card === 'draft', { o1, o2 });
} else ok('🔴 V1 ReviewFocus renders', false, M ? 'no ReviewFocus export' : 'bundle failed');

const cardRenders = SRC.flatMap((f) => [...read(f).matchAll(/<(DecisionCard|DraftCard)\b[^>]*>/g)].map((m) => ({ f, tag: m[0] })));
ok('🔴 V5 the cards are drawn only by ReviewFocus, and every draw carries a key',
  cardRenders.length === 2 && cardRenders.every((r) => r.f === 'src/pages/review/ReviewFocus.jsx' && /\bkey=\{/.test(r.tag)), cardRenders);
ok('V6 one visit = one card: each card mints its sitting once per mount (a new item is a new visit)',
  /const sitting = useMemo\(\(\) => newSitting\(\), \[\]\);/.test(read('src/pages/review/DraftCard.jsx'))
  && /const sitting = useMemo\(\(\) => newSitting\(\), \[\]\);/.test(read('src/pages/review/DecisionCard.jsx')));
ok('V7 the draft card holds its "Before this update" line for its own life, with no per-id juggling (it is one draft)',
  /const \[held, setHeld\] = useState\(null\);/.test(read('src/pages/review/DraftCard.jsx')) && !/held\.id|held\?\.id/.test(read('src/pages/review/DraftCard.jsx')));

// ── I. the inventory: where the note box and the synced answer box are used ──────────────────
// A new user must be added here with the reason one instance can only ever serve one item.
const notesUsers = usersOf(/<ReviewNotes\b/).sort();
ok('I1 the note box (ReviewNotes) is used only by the two keyed cards and the two layout pickers',
  JSON.stringify(notesUsers) === JSON.stringify(['src/components/DashboardLayoutPicker.jsx', 'src/components/PayrollLayoutPicker.jsx', 'src/pages/review/DecisionCard.jsx', 'src/pages/review/DraftCard.jsx']), notesUsers);
ok('I2 …and each picker reviews ONE fixed pick, so its box can never meet another item',
  /usePickReview\(LAYOUT_PICK_ID, sitting\)/.test(read('src/components/DashboardLayoutPicker.jsx'))
  && /usePickReview\(PAYROLL_PICK_ID, sitting\)/.test(read('src/components/PayrollLayoutPicker.jsx')));
const syncedUsers = usersOf(/\buseSyncedText\(/).filter((f) => f !== 'src/hooks/useSyncedText.js');
ok('I3 the synced answer box (useSyncedText) is used only by the question card', JSON.stringify(syncedUsers) === JSON.stringify(['src/pages/review/DecisionCard.jsx']), syncedUsers);

// ── R. record routes that held a typed box: a fresh page per record ─────────────────────────
const app = read('src/App.jsx');
ok('control: KeyedByParam keys its children by the named param', /function KeyedByParam\(\{ name, children \}\) \{\s*const params = useParams\(\);\s*return <Fragment key=\{params\[name\]\}>\{children\}<\/Fragment>;/.test(app));
ok('🔴 R1 the hub\'s request page is a fresh page per request (its reply box; the bell opens another request in place)',
  /<Route path="\/hub\/b\/:buildingId\/tickets\/:ticketId" element=\{<KeyedByParam name="ticketId"><HubTicket \/><\/KeyedByParam>\} \/>/.test(app));
ok('🔴 R2 the office\'s order page is a fresh page per order (its comment box and the comment\'s minted id; the bell opens another order in place)',
  /<Route path="supplies\/orders\/:id" element=\{<RequirePerm perm="supplies\.view"><KeyedByParam name="id"><SupplyOrder \/><\/KeyedByParam><\/RequirePerm>\} \/>/.test(app));

console.log(`test-view-per-record: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
