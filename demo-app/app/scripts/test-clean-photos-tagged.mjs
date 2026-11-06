// CS-691 — photos from My Day's "Before / after photos" showed up nowhere.
//
// WHAT WAS WRONG. My Day's card opened ONE gallery for the clean (`scope="clean"`, the job's
// id) with no `areaId`, so every upload was stored with no before/after phase. Every reader of
// a clean's photos asks for a phase: the visit's two galleries and their step ticks
// (CrewJobVisit), the office's Photos (JobDetail) and the customer hub's visit photos
// (`api/_lib/clientHub/reads` reads only `area_id` in HUB_VISIT_PHOTO_AREAS). The pictures
// existed and nobody could see them.
//
// WHAT THIS PINS. Every gallery that files a clean's photos files them under one of the phases
// the hub reads — read from its source of truth, `lib/hubVisit HUB_VISIT_PHOTO_AREAS` — and My
// Day offers BOTH, as the visit does, so a phone's photo lands where every reader looks.
//
// REGRESSION (THE LAW II.3): on the pre-fix tree My Day's gallery has no `areaId`.
//
//   node scripts/test-clean-photos-tagged.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => { try { return fs.readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
const { HUB_VISIT_PHOTO_AREAS, HUB_VISIT_PHOTO_SCOPE } = await import(pathToFileURL(path.join(APP, 'src/lib/hubVisit.js')).href);

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

// Every <MediaGallery …> element in the app, with its props as written.
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : (/\.jsx$/.test(d.name) ? [path.join(dir, d.name)] : [])));
const galleries = [];
for (const file of walk(path.join(APP, 'src'))) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/<MediaGallery\b([\s\S]*?)\/>/g)) {
    galleries.push({ file: path.relative(APP, file).split(path.sep).join('/'), props: m[1] });
  }
}
const cleanGalleries = galleries.filter((g) => new RegExp(`scope="${HUB_VISIT_PHOTO_SCOPE}"`).test(g.props));
ok('the clean galleries were found (sanity)', cleanGalleries.length >= 5, String(cleanGalleries.length));
for (const g of cleanGalleries) {
  const area = /areaId="([^"]+)"/.exec(g.props)?.[1] || null;
  ok(`${g.file}: a clean's gallery files its photos under a phase the hub, the visit and the office read`, HUB_VISIT_PHOTO_AREAS.includes(area), `areaId ${JSON.stringify(area)}`);
}
// The Cleaner Hub (brief A, plan D9): the cleaner's photos moved from My Day's card to the Clock Out
// screen (pages/crew/CrewClock), and stay on the clean's page (the visit) — the hub depends on them.
const CLOCK = 'src/pages/crew/CrewClock.jsx';
const clockOut = cleanGalleries.filter((g) => g.file === CLOCK);
const areasOf = (list) => list.map((g) => /areaId="([^"]+)"/.exec(g.props)?.[1]).sort();
ok('the Clock Out screen offers both phases, as the visit does', JSON.stringify(areasOf(clockOut)) === JSON.stringify([...HUB_VISIT_PHOTO_AREAS].sort()), JSON.stringify(areasOf(clockOut)));
ok('…with the visit\'s own words', /label=\{t\('visit\.step\.before'\)\}/.test(read(CLOCK)) && /label=\{t\('visit\.step\.after'\)\}/.test(read(CLOCK)));
const en = read('src/i18n/catalog/en.js');
ok('the untagged gallery\'s words are gone with it (replace means delete)', !/'myDay\.beforeAfterPhotos':/.test(en) && !/'myDay\.beforeAfterHint':/.test(en));

if (fails.length) {
  console.error(`\ntest-clean-photos-tagged: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\ntest-clean-photos-tagged: ${pass}/${pass} passed`);
}
