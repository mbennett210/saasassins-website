// review-browser-check — the DRIVEN regression check for the Review section's synced-text
// fields and the focus flow's layout stability (UI_RULES §98/§130, brain [[client-review]]).
//
// 🔴 WHY A DRIVEN HARNESS. These are emergent DOM-lifecycle behaviours that a node unit test
// cannot see: a controlled field that keeps typing while a remote edit lands, a save that
// fires on UNMOUNT (browser Back = popstate, no blur), and a footer nav that must not move
// under a real mouse press. Each costs one page load and a real event; `window.__ppGetState`
// / `window.__ppDispatch` (DEV-only, store/index.jsx) read and drive the shared review slice.
// Every case is GUARDED — a thrown error (e.g. a selector missing on regressed code) is
// recorded as that case's FAIL and the suite carries on, so it reports the whole picture.
//
// It needs a running demo server (seeded, login-free), exactly like responsive-sweep. It is
// deliberately NOT named test-*.mjs, so run-tests never globs it and never counts it — a
// browser check that can't run offline stays out of the offline suite. With NO --url it EXITS
// NON-ZERO with the usage line (no fake self-skip green).
//
// Run it:
//   npm --prefix app run dev -- --mode demo --port 5361
//   npm --prefix app run check:review -- --url http://localhost:5361
// CHROME_PATH overrides the browser (same env var responsive-sweep uses).

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const URL_ARG = arg('--url', process.env.REVIEW_TEST_URL || null);

if (!URL_ARG) {
  console.error('\nusage: npm --prefix app run check:review -- --url http://localhost:5361');
  console.error('  needs a running demo server:  npm --prefix app run dev -- --mode demo --port 5361\n');
  process.exit(2);
}
const BASE = URL_ARG.replace(/\/$/, '');

const res = await fetch(BASE).catch(() => null);
if (!res || !res.ok) {
  console.error(`\n✖ No demo server at ${BASE} (${res ? res.status : 'no response'}).`);
  console.error('  Start one:  npm --prefix app run dev -- --mode demo --port 5361\n');
  process.exit(2);
}

const LOCAL_CHROME = process.env.CHROME_PATH
  || (process.platform === 'win32'
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

const puppeteer = (await import('puppeteer-core')).default;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let pageErrors = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   [' + detail + ']' : ''}`);
}
// Run a case; a throw (missing selector on regressed code, timeout, …) is that case's FAIL.
async function step(label, fn) {
  try { await fn(); }
  catch (e) { check(label + ' (threw)', false, String((e && e.message) || e).split('\n')[0].slice(0, 90)); }
}

const browser = await puppeteer.launch({
  executablePath: LOCAL_CHROME, headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 1280, height: 1000, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => pageErrors.push(e.message));

// ── helpers ────────────────────────────────────────────────────────────────
const review = () => page.evaluate(() => window.__ppGetState().clientReview);
const itemInUrl = () => { try { return new URL(page.url()).searchParams.get('item'); } catch { return null; } };
const areaInUrl = () => { try { return new URL(page.url()).searchParams.get('area'); } catch { return null; } };
const val = (sel) => page.$eval(sel, (el) => el.value).catch(() => null);
const dispatch = (action) => page.evaluate((a) => window.__ppDispatch(a), action);
const blurActive = () => page.evaluate(() => document.activeElement && document.activeElement.blur());

async function reset() {
  await page.goto(BASE + '/review', { waitUntil: 'networkidle0' });
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* private mode */ } });
  await page.goto(BASE + '/review', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.review-tiles', { timeout: 12000 });
}
async function openArea(tileText) {
  await page.evaluate((t) => {
    const b = [...document.querySelectorAll('.review-tile, .review-hero-actions button')].find((x) => x.textContent.includes(t));
    if (b) b.click();
  }, tileText);
  await page.waitForSelector('.review-focus', { timeout: 8000 });
}
async function clickNextDom() { await page.evaluate(() => { const b = document.querySelector('.review-nav .btn-primary'); if (b) b.click(); }); }
async function walkTo(target, max = 20) {
  for (let i = 0; i < max; i++) { if (itemInUrl() === target) return true; await clickNextDom(); await sleep(120); }
  return itemInUrl() === target;
}
// The genuine browser/hardware Back button: fires popstate; React Router unmounts ReviewFocus.
async function browserBack() {
  await page.evaluate(() => window.history.back());
  for (let i = 0; i < 40; i++) { await sleep(50); if (!areaInUrl()) return; }
}
const navRectTop = () => page.$eval('.review-nav .btn-primary', (el) => el.getBoundingClientRect().top).catch(() => null);
async function clickNextRealMouse() {
  // A physical press: move → down → (React commits any blur-driven layout change) → up.
  const r = await page.$eval('.review-nav .btn-primary', (el) => { const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  await page.mouse.move(r.x, r.y);
  await page.mouse.down();
  await sleep(90);            // let a mousedown-blur save + re-render settle before release
  await page.mouse.up();
  await sleep(200);
}

// PAY-1 is the first (text) question of "Time clock & payroll"; resolved once, reused.
let payId = 'PAY-1';

// ── A. synced-text behaviour ─────────────────────────────────────────────────
await step('A1 dirty box keeps typing when a remote edit lands', async () => {
  await reset(); await openArea('Time clock & payroll'); await page.waitForSelector('.review-answer', { timeout: 8000 });
  payId = itemInUrl();
  await page.focus('.review-answer');
  await page.type('.review-answer', 'LOCAL-TYPING');
  await dispatch({ type: 'UPDATE_CLIENT_REVIEW', kind: 'decisions', id: payId, patch: { text: 'REMOTE-CLOBBER' } });
  await sleep(200);
  check('A1 dirty box keeps typing when a remote edit lands', (await val('.review-answer')) === 'LOCAL-TYPING', 'value=' + (await val('.review-answer')));
});

await step('A2 idle box adopts a remote edit, focus+blur does not re-save', async () => {
  await reset(); await openArea('Time clock & payroll'); await page.waitForSelector('.review-answer', { timeout: 8000 });
  await dispatch({ type: 'UPDATE_CLIENT_REVIEW', kind: 'decisions', id: payId, patch: { text: 'REMOTE-IDLE' } });
  await sleep(200);
  const adopted = (await val('.review-answer')) === 'REMOTE-IDLE';
  const atBefore = (await review()).decisions[payId]?.at;
  await page.focus('.review-answer'); await blurActive(); await sleep(250);
  const atAfter = (await review()).decisions[payId]?.at;
  check('A2 idle box adopts a remote edit, focus+blur does not re-save', adopted && atAfter === atBefore && (await val('.review-answer')) === 'REMOTE-IDLE', `adopted=${adopted} at ${atBefore}==${atAfter}`);
});

await step('A3 Clear answer empties the box and it stays empty', async () => {
  await reset(); await openArea('Time clock & payroll'); await page.waitForSelector('.review-answer', { timeout: 8000 });
  await page.type('.review-answer', 'TO-CLEAR'); await blurActive(); await sleep(250);
  // Clear answer lives inline in the status row post-fix (.review-status-clear); fall back to text.
  await page.evaluate(() => {
    const b = document.querySelector('.review-status-clear') ||
      [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Clear answer');
    if (b) b.click();
  });
  await sleep(250);
  const clearedNow = (await val('.review-answer')) === '' && ((await review()).decisions[payId]?.text || '') === '';
  await sleep(400);
  check('A3 Clear answer empties the box and it stays empty', clearedNow && (await val('.review-answer')) === '', 'value=' + JSON.stringify(await val('.review-answer')));
});

await step('A4 a blur-saved value survives a reload', async () => {
  await reset(); await openArea('Time clock & payroll'); await page.waitForSelector('.review-answer', { timeout: 8000 });
  const a4 = 'SURVIVE-RELOAD';
  await page.type('.review-answer', a4); await blurActive(); await sleep(500);
  await page.goto(BASE + '/review', { waitUntil: 'networkidle0' });
  check('A4 a blur-saved value survives a reload', ((await review()).decisions[payId]?.text) === a4, 'text=' + ((await review()).decisions[payId]?.text));
});

// ── B. unmount flush on browser Back (popstate, NO blur) ──────────────────────
await step('B1 text answer flush', async () => {
  await reset(); await openArea('Time clock & payroll'); await page.waitForSelector('.review-answer', { timeout: 8000 });
  const b1 = 'FLUSH-TEXT-' + Date.now();
  await page.type('.review-answer', b1); await sleep(150); await browserBack(); await sleep(300);
  check('B1 text answer saved on browser Back (popstate)', ((await review()).decisions[payId]?.text) === b1, 'text=' + ((await review()).decisions[payId]?.text));
  await sleep(400); await page.goto(BASE + '/review', { waitUntil: 'networkidle0' });
  check('B1 text answer survives reload', ((await review()).decisions[payId]?.text) === b1);
});

// CS-402: notes are ADD-ONLY. An unsent composer draft auto-posts as a NEW note on browser
// Back (popstate, no blur) — to the entry's `notes` array — and survives a reload.
const lastNoteText = (arr) => (Array.isArray(arr) && arr.length ? arr[arr.length - 1].text : null);
await step('B2 question note composer auto-posts on browser Back', async () => {
  await reset(); await openArea('Contract tracking'); await page.waitForSelector('.review-note-input', { timeout: 8000 });
  const conId = itemInUrl();
  const b2 = 'ADDNOTE-Q-' + Date.now();
  await page.type('.review-note-input', b2); await sleep(150); await browserBack(); await sleep(400);
  check('B2 question note auto-posted to notes[] on browser Back', lastNoteText((await review()).decisions[conId]?.notes) === b2, `item=${conId}`);
  await sleep(400); await page.goto(BASE + '/review', { waitUntil: 'networkidle0' });
  check('B2 question note survives reload', lastNoteText((await review()).decisions[conId]?.notes) === b2);
});

await step('B3 draft note composer auto-posts on browser Back', async () => {
  await reset(); await openArea('Drafts to sign off'); await page.waitForSelector('.review-note-input', { timeout: 8000 });
  const draftId = itemInUrl();
  const b3 = 'ADDNOTE-D-' + Date.now();
  await page.type('.review-note-input', b3); await sleep(150); await browserBack(); await sleep(400);
  check('B3 draft note auto-posted to notes[] on browser Back', lastNoteText((await review()).drafts[draftId]?.notes) === b3, `item=${draftId}`);
  await sleep(400); await page.goto(BASE + '/review', { waitUntil: 'networkidle0' });
  check('B3 draft note survives reload', lastNoteText((await review()).drafts[draftId]?.notes) === b3);
});

// ── C. view-and-leave writes nothing ──────────────────────────────────────────
await step('C view-and-leave writes nothing', async () => {
  await reset(); await openArea('Contract tracking'); await page.waitForSelector('.review-focus', { timeout: 8000 });
  const cId = itemInUrl();
  await sleep(250); await browserBack(); await sleep(300);
  check('C view-and-leave writes nothing (no at stamp)', (await review()).decisions[cId] === undefined, `item=${cId} v=${JSON.stringify((await review()).decisions[cId])}`);
});

// ── D. no double-write when leaving after a blur already saved ─────────────────
await step('D blur-then-leave does not double-write', async () => {
  await reset(); await openArea('Time clock & payroll'); await page.waitForSelector('.review-answer', { timeout: 8000 });
  const d = 'ONCE-' + Date.now();
  await page.type('.review-answer', d); await blurActive(); await sleep(450);
  const dAt1 = (await review()).decisions[payId]?.at;
  await browserBack(); await sleep(400);
  const e = (await review()).decisions[payId];
  check('D blur-then-leave does not double-write (at unchanged, value identical)', e && e.text === d && e.at === dAt1, `at ${dAt1}==${e?.at}`);
});

// ── E. layout stability: a physical Next click advances after typing; and Next's
//     rect is unchanged across the answered flip for text / single / multi + a note.
await step('E1 one physical Next click advances after typing (text, PAY-1)', async () => {
  await reset(); await openArea('Time clock & payroll'); await page.waitForSelector('.review-answer', { timeout: 8000 });
  await page.type('.review-answer', 'ADVANCE-ME');
  await clickNextRealMouse();
  check('E1 one physical Next click advances after typing (text, PAY-1)', itemInUrl() && itemInUrl() !== payId, `item ${payId} -> ${itemInUrl()}`);
});
await step('E2 Next rect stable across answered flip — TEXT', async () => {
  await reset(); await openArea('Time clock & payroll'); await page.waitForSelector('.review-answer', { timeout: 8000 });
  const t0 = await navRectTop();
  await page.type('.review-answer', 'x'); await blurActive(); await sleep(250);
  const t1 = await navRectTop();
  check('E2 Next rect stable across answered flip — TEXT', Math.abs(t1 - t0) <= 1, `top ${t0}->${t1}`);
});
await step('E3 Next rect stable across answered flip — SINGLE (HUB-1)', async () => {
  await reset(); await openArea('Client Hub'); await page.waitForSelector('.review-opts[role="radiogroup"]', { timeout: 8000 });
  const s0 = await navRectTop();
  await page.evaluate(() => { const r = document.querySelector('.review-opt input'); if (r) r.click(); }); await sleep(250);
  const s1 = await navRectTop();
  check('E3 Next rect stable across answered flip — SINGLE (HUB-1)', Math.abs(s1 - s0) <= 1, `top ${s0}->${s1}`);
});
await step('E4 Next rect stable across answered flip — MULTI (QR-2)', async () => {
  await reset(); await openArea('QR codes'); await page.waitForSelector('.review-focus', { timeout: 8000 });
  await walkTo('QR-2'); await page.waitForSelector('.review-opts[role="group"]', { timeout: 8000 });
  const m0 = await navRectTop();
  await page.evaluate(() => { const r = document.querySelector('.review-opt input'); if (r) r.click(); }); await sleep(250);
  const m1 = await navRectTop();
  check('E4 Next rect stable across answered flip — MULTI (QR-2)', Math.abs(m1 - m0) <= 1, `top ${m0}->${m1}`);
});
await step('E5 Next rect stable across a note edit', async () => {
  await reset(); await openArea('Contract tracking'); await page.waitForSelector('.review-note-input', { timeout: 8000 });
  const n0 = await navRectTop();
  await page.type('.review-note-input', 'a note'); await blurActive(); await sleep(250);
  const n1 = await navRectTop();
  check('E5 Next rect stable across a note edit', Math.abs(n1 - n0) <= 1, `top ${n0}->${n1}`);
});

// ── F. production-shape load: a review slice with NO `decisions` key ───────────
await step('F production-shape (blob without decisions) loads without crashing', async () => {
  pageErrors = [];
  await reset();
  // A live blob predates `decisions`. SET_CLIENT_REVIEW is now an additive UNION and can't
  // drop a bucket, so inject the raw production shape via HYDRATE. The selector must default
  // the missing bucket so the card renders instead of throwing on review.decisions[id].
  await page.evaluate(() => { const s = window.__ppGetState(); window.__ppDispatch({ type: 'HYDRATE', payload: { ...s, clientReview: { sections: {}, drafts: {}, picks: {} } } }); });
  await sleep(150);
  await openArea('Time clock & payroll');
  const rendered = await page.$('.review-answer');
  const rawHasNoDecisions = (await review()).decisions === undefined;
  check('F production-shape (blob without `decisions`) loads without crashing',
    !!rendered && pageErrors.length === 0 && rawHasNoDecisions,
    `rendered=${!!rendered} errors=${pageErrors.length} rawNoDecisions=${rawHasNoDecisions}`);
});

// ── G. width sweep: nav stability + one physical Next click across snapped-window widths.
//     641/680/720 are the seam where the meta row used to wrap 2→1 line and a 3-line
//     recommendation exceeded the fixed height (a snapped half-screen laptop is ~683px).
//     Covers a text question (PAY-1 — also needs-your-answer + New), a single (HUB-1) and a
//     multi (QR-2, whose longest recommendation wraps to 3 lines); every question is dated
//     today, so the "New" badge is present on each while unanswered.
const WIDTHS = [641, 680, 720, 820, 1024, 1440];
for (const w of WIDTHS) {
  await step(`G[${w}] one physical Next click advances after typing (text, PAY-1)`, async () => {
    await page.setViewport({ width: w, height: 1200, deviceScaleFactor: 1 });
    await reset(); await openArea('Time clock & payroll'); await page.waitForSelector('.review-answer', { timeout: 8000 });
    await page.type('.review-answer', 'ADVANCE');
    await clickNextRealMouse();
    check(`G[${w}] one physical Next click advances (text)`, itemInUrl() && itemInUrl() !== payId, `item ${payId} -> ${itemInUrl()}`);
  });
  await step(`G[${w}] nav rect stable — TEXT (PAY-1, needs+New)`, async () => {
    await page.setViewport({ width: w, height: 1200, deviceScaleFactor: 1 });
    await reset(); await openArea('Time clock & payroll'); await page.waitForSelector('.review-answer', { timeout: 8000 });
    const a = await navRectTop(); await page.type('.review-answer', 'x'); await blurActive(); await sleep(200); const b = await navRectTop();
    check(`G[${w}] nav rect stable — TEXT (PAY-1)`, Math.abs(b - a) <= 1, `top ${a}->${b}`);
  });
  await step(`G[${w}] nav rect stable — SINGLE (HUB-1)`, async () => {
    await page.setViewport({ width: w, height: 1200, deviceScaleFactor: 1 });
    await reset(); await openArea('Client Hub'); await page.waitForSelector('.review-opts[role="radiogroup"]', { timeout: 8000 });
    const a = await navRectTop(); await page.evaluate(() => { const r = document.querySelector('.review-opt input'); if (r) r.click(); }); await sleep(200); const b = await navRectTop();
    check(`G[${w}] nav rect stable — SINGLE (HUB-1)`, Math.abs(b - a) <= 1, `top ${a}->${b}`);
  });
  await step(`G[${w}] nav rect stable — MULTI (QR-2)`, async () => {
    await page.setViewport({ width: w, height: 1200, deviceScaleFactor: 1 });
    await reset(); await openArea('QR codes'); await page.waitForSelector('.review-focus', { timeout: 8000 });
    await walkTo('QR-2'); await page.waitForSelector('.review-opts[role="group"]', { timeout: 8000 });
    const a = await navRectTop(); await page.evaluate(() => { const r = document.querySelector('.review-opt input'); if (r) r.click(); }); await sleep(200); const b = await navRectTop();
    check(`G[${w}] nav rect stable — MULTI (QR-2)`, Math.abs(b - a) <= 1, `top ${a}->${b}`);
  });
}

// ── H–O. CS-402: the ADDITIVE model driven in the browser ──────────────────────────
// Seed a sign-off stamped with an OLD sitting; opening the card mints a NEW sitting, so the
// entry reads LOCKED. (First sign-off on an empty entry isn't locked, so confirm:true here is
// harmless and just stamps the seed sitting.)
const seedSignoff = (kind, id, patch) => dispatch({ type: 'UPDATE_CLIENT_REVIEW', kind, id, patch, sitting: 'seed-old-sitting', confirm: true });
const dialogText = () => page.$eval('.confirm-message', (el) => el.textContent).catch(() => null);
const clickConfirmBtn = () => page.evaluate(() => { const b = document.querySelector('.modal-actions .btn-primary'); if (b) b.click(); });
const clickCancelBtn = () => page.evaluate(() => { const b = document.querySelector('.modal-actions .btn-outline'); if (b) b.click(); });

await step('H a question answered in an earlier visit is LOCKED; clicking another option does nothing', async () => {
  await reset();
  await seedSignoff('decisions', 'HUB-3', { choice: 'a' }); await sleep(150);
  await openArea('Client Hub'); await walkTo('HUB-3'); await page.waitForSelector('.review-opts', { timeout: 8000 });
  const hasChange = (await page.$('.review-status-change')) != null;
  const optDisabled = await page.$eval('.review-opts input', (el) => el.disabled).catch(() => false);
  await page.evaluate(() => { const ins = [...document.querySelectorAll('.review-opts input')]; const b = ins[1] || ins[0]; if (b) b.click(); });
  await sleep(250);
  const stillA = (await review()).decisions['HUB-3']?.choice === 'a';
  check('H locked question: Change shown, options disabled, a foreign click is a no-op', hasChange && optDisabled && stillA, `change=${hasChange} disabled=${optDisabled} stillA=${stillA}`);
});

await step('I Change answer → Cancel keeps it; → Confirm changes it and history lists the old answer with a date', async () => {
  await reset();
  await seedSignoff('decisions', 'HUB-3', { choice: 'a' }); await sleep(150);
  await openArea('Client Hub'); await walkTo('HUB-3'); await page.waitForSelector('.review-status-change', { timeout: 8000 });
  // Cancel path
  await page.evaluate(() => document.querySelector('.review-status-change').click()); await sleep(200);
  const dlg = await dialogText();
  await clickCancelBtn(); await sleep(200);
  const afterCancel = (await review()).decisions['HUB-3']?.choice === 'a' && (await page.$('.review-opts input')) && (await page.$eval('.review-opts input', (el) => el.disabled));
  // Confirm path → pick option b
  await page.evaluate(() => document.querySelector('.review-status-change').click()); await sleep(200);
  await clickConfirmBtn(); await sleep(250);
  await page.evaluate(() => { const ins = [...document.querySelectorAll('.review-opts input')]; if (ins[1]) ins[1].click(); }); await sleep(300);
  const e = (await review()).decisions['HUB-3'];
  const histOk = Array.isArray(e?.history) && e.history.length === 1 && e.history[0].choice === 'a';
  const hasEarlier = await page.$('.review-history') != null;
  const dateShown = await page.$eval('.review-history-at', (el) => (el.textContent || '').trim().length > 0).catch(() => false);
  check('I Change answer: Cancel keeps it, Confirm changes it + history keeps the old answer with a date',
    (dlg && dlg.includes('answered on')) && afterCancel && e?.choice === 'b' && histOk && hasEarlier && dateShown,
    `dlg=${!!dlg} cancelKept=${afterCancel} newChoice=${e?.choice} hist=${JSON.stringify(e?.history)} earlier=${hasEarlier} date=${dateShown}`);
});

await step('J a draft verdict from an earlier visit is LOCKED; Change → Confirm records the new verdict and keeps the old one', async () => {
  await reset();
  await seedSignoff('drafts', 'quote-email', { status: 'accepted' }); await sleep(150);
  await openArea('Drafts to sign off'); await walkTo('quote-email'); await page.waitForSelector('.drafts-verdict-locked', { timeout: 8000 });
  const lockedMsg = await page.$eval('.drafts-verdict-msg', (el) => el.textContent).catch(() => '');
  await page.evaluate(() => document.querySelector('.drafts-verdict-change').click()); await sleep(200);
  const dlg = await dialogText();
  await clickConfirmBtn(); await sleep(250);
  await page.evaluate(() => { const b = document.querySelector('.drafts-changes'); if (b) b.click(); }); await sleep(300);
  const e = (await review()).drafts['quote-email'];
  const histOk = Array.isArray(e?.history) && e.history.length === 1 && e.history[0].status === 'accepted';
  check('J draft verdict lock + Change→Confirm keeps the prior verdict in history',
    lockedMsg.includes('Accepted') && !!dlg && e?.status === 'changes' && histOk,
    `msg="${lockedMsg}" dlg=${!!dlg} status=${e?.status} hist=${JSON.stringify(e?.history)}`);
});

await step('K notes: add two, both listed, no edit or delete control', async () => {
  await reset(); await openArea('Client Hub'); await walkTo('HUB-1'); await page.waitForSelector('.review-note-input', { timeout: 8000 });
  const addNote = async (t) => {
    await page.type('.review-note-input', t);
    await page.evaluate(() => { const b = document.querySelector('.review-note-add'); if (b) b.click(); });
    await sleep(250);
  };
  await addNote('First note'); await addNote('Second note');
  const items = await page.$$eval('.review-note-item', (els) => els.map((e) => e.textContent));
  const btnsInItems = await page.$$eval('.review-note-item button', (els) => els.length).catch(() => 0);
  const notes = (await review()).decisions['HUB-1']?.notes || [];
  check('K two notes listed, oldest→newest, no edit/delete control',
    items.length === 2 && items[0].includes('First note') && items[1].includes('Second note') && btnsInItems === 0 && notes.length === 2,
    `items=${items.length} btns=${btnsInItems} notes=${notes.length}`);
});

await step('M sidebar un-approve asks to confirm; Cancel keeps it approved', async () => {
  await reset();
  // approve the first in-review section (one click), then read which route it was
  await page.evaluate(() => { const m = document.querySelector('.nav-review-ir'); if (m) m.click(); }); await sleep(250);
  const approvedRoute = await page.evaluate(() => { const s = window.__ppGetState().clientReview.sections; return Object.keys(s).find((k) => s[k]?.status === 'approved') || null; });
  // clicking the now-green marker opens a confirm dialog (does NOT flip immediately)
  await page.evaluate(() => { const m = document.querySelector('.nav-review-approved'); if (m) m.click(); }); await sleep(250);
  const dlg = await dialogText();
  await clickCancelBtn(); await sleep(250);
  const stillApproved = await page.evaluate((r) => window.__ppGetState().clientReview.sections[r]?.status === 'approved', approvedRoute);
  check('M un-approve confirms; Cancel keeps the approval',
    !!approvedRoute && !!dlg && dlg.includes('approved on') && stillApproved,
    `route=${approvedRoute} dlg=${!!dlg} stillApproved=${stillApproved}`);
});

await step('N a layout pick from an earlier visit locks, and its Change asks to confirm', async () => {
  await page.goto(BASE + '/payroll', { waitUntil: 'networkidle0' });
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* private */ } });
  await page.goto(BASE + '/payroll', { waitUntil: 'networkidle0' });
  await dispatch({ type: 'UPDATE_CLIENT_REVIEW', kind: 'picks', id: 'payroll-layout', patch: { choice: 'Register', status: 'chosen' }, sitting: 'seed-old-sitting', confirm: true });
  await sleep(250);
  await page.waitForSelector('.dash-layout-note', { timeout: 8000 });
  await page.evaluate(() => { const b = document.querySelector('.dash-layout-note button'); if (b) b.click(); }); // open the picker
  await page.waitForSelector('.dlp', { timeout: 8000 });
  await page.waitForSelector('.dlp-decision .dlp-link', { timeout: 8000 });
  await page.evaluate(() => { const b = document.querySelector('.dlp-decision .dlp-link'); if (b) b.click(); }); // "Change" on a locked pick
  await sleep(250);
  const dlg = await dialogText();
  const stillChosen = (await review()).picks['payroll-layout']?.status === 'chosen';
  check('N locked pick: Change opens a confirm and does not flip on its own',
    !!dlg && dlg.includes('stays listed') && stillChosen,
    `dlg=${!!dlg} status=${(await review()).picks['payroll-layout']?.status}`);
  await clickCancelBtn(); await sleep(150);
});

await step('O a misclick fix within the SAME visit needs no confirm and adds no history', async () => {
  await reset(); await openArea('Client Hub'); await walkTo('HUB-1'); await page.waitForSelector('.review-opts', { timeout: 8000 });
  await page.evaluate(() => { const ins = [...document.querySelectorAll('.review-opts input')]; if (ins[0]) ins[0].click(); }); await sleep(200);
  await page.evaluate(() => { const ins = [...document.querySelectorAll('.review-opts input')]; if (ins[1]) ins[1].click(); }); await sleep(250);
  const noDialog = (await page.$('.confirm-message')) == null;
  const e = (await review()).decisions['HUB-1'];
  check('O same-visit misclick fix: choice changed, no confirm dialog, no history',
    noDialog && e?.choice === 'b' && (!Array.isArray(e?.history) || e.history.length === 0),
    `dialog=${!noDialog} choice=${e?.choice} hist=${JSON.stringify(e?.history)}`);
});

const passed = results.filter((r) => r.pass).length;
console.log(`\nSUMMARY  ${passed}/${results.length} passed`);
await browser.close();
process.exitCode = passed === results.length ? 0 : 1;
