// test-bundle-stubs.mjs — the offline run-tests entry for the CS-010 / CS-038 bundle gate.
//
// run-tests.mjs auto-discovers every test-*.mjs. This one builds a PRODUCTION bundle to a
// temp dir (offline — the local vite bin, no network, no VITE_* env needed) and asserts it
// contains no reachable browser-stub adapter, by delegating to check-bundle-stubs.mjs
// --build. It is honestly offline: it never uses --url (the live check is a separate,
// manual/post-deploy command). See check-bundle-stubs.mjs for the marker rationale.
//
// This is the machine that makes CS-010 non-recurring: a change that puts Quotes (or the
// integrations/team/twilio stub) back into a production build fails the offline suite here,
// before it can reach `main`.
//
// First, the markers on fixtures (2026-10-03): a marker made of ordinary words fails a
// re-branded build whose brand pack uses them. The QuickBooks fixture marker matched the bare
// words "Day Porter", which the test brand Harbor & Pine's services carry, so the throwaway-pack
// proof (REBRAND.md §6) went red on a clean build.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const engine = fileURLToPath(new URL('./check-bundle-stubs.mjs', import.meta.url));
const fails = [];
let lib = null;
try { lib = await import('./check-bundle-stubs.mjs'); } catch { /* fails below */ }
const hits = (text) => (lib?.scanText ? lib.scanText('fixture.js', text).map((h) => h.marker) : null);
if (!lib?.scanText || !Array.isArray(lib?.MARKERS)) fails.push('check-bundle-stubs.mjs exports MARKERS and scanText');
else {
  // the QuickBooks stub's class and department arrays, as the minifier writes them
  for (const text of ['class:[`Janitorial`,`Floor Care`,`Day Porter`,`Special Projects`]', 'department:["North Region","Central Region","South Region"]']) {
    if (!hits(text).includes('legacy-qbo-fixtures')) fails.push(`the QuickBooks fixtures are caught: ${text}`);
  }
  // a brand pack's own words in a production bundle (the identity module, the quote): no marker
  for (const text of ['services:`Commercial Cleaning, Day Porter & Floor Care`', 'services:"Day Porter, Special Projects & Floor Care"', '<p>Special Projects</p>']) {
    if (hits(text).length) fails.push(`a brand's services are not a stub marker: ${text} (got ${hits(text).join(', ')})`);
  }
}
if (fails.length) {
  for (const f of fails) console.error(`  ✗ ${f}`);
  console.error(`\n✖ test-bundle-stubs: ${fails.length} marker check(s) failed.`);
  process.exit(1);
}
try {
  execFileSync(process.execPath, [engine, '--build'], { stdio: 'inherit' });
  process.exit(0);
} catch {
  // check-bundle-stubs already printed which markers were found and why.
  console.error('\n✖ test-bundle-stubs: the production build contains a reachable browser stub (CS-010, CS-038).');
  process.exit(1);
}
