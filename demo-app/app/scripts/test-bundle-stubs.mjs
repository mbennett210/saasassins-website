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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const engine = fileURLToPath(new URL('./check-bundle-stubs.mjs', import.meta.url));
try {
  execFileSync(process.execPath, [engine, '--build'], { stdio: 'inherit' });
  process.exit(0);
} catch {
  // check-bundle-stubs already printed which markers were found and why.
  console.error('\n✖ test-bundle-stubs: the production build contains a reachable browser stub (CS-010, CS-038).');
  process.exit(1);
}
