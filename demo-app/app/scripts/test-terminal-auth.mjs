// Unit test for the terminal-auth classification on the server-mediated write path
// (app/src/lib/terminalAuth.js).
//
// THE BUG (2026-09-23): the server answers a write 403 `{ code: 'account-disabled' }`
// (or 'not-on-team') when a login can no longer act — requireAuthority in
// app/api/_lib/authz.js. The client only ever treated a 403 as a REAL answer when it
// carried a field-guard `violations` list; every other 403, account-disabled included,
// was classified as a transport failure → stateApi fell back to the direct write and the
// sync manager retried the same 403 every ~5s forever ("offline" that never clears)
// instead of signing the user out. terminalAuthCode() is the decision that flips
// account-disabled / not-on-team from "retry" to "terminal sign-out"; stateApi throws +
// hands off on a non-null result, flush() then neither falls back nor retries.
//
// terminalAuth.js is dependency-free ON PURPOSE so this drives the REAL decision function
// under plain node (stateApi.js can't be node-imported — its Vite-only extensionless
// imports; same reason test-sync-content-guard.mjs copies its transforms). Testing the
// real classifier is what proves the fix without a restated literal.
//
//   node app/scripts/test-terminal-auth.mjs
import {
  terminalAuthCode,
  terminalAuthMessage,
  TERMINAL_AUTH_CODES,
  ACCOUNT_DISABLED_MESSAGE,
  NOT_ON_TEAM_MESSAGE,
} from '../src/lib/terminalAuth.js';

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}`); }
};
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)})`, got === want);

console.log('terminalAuthCode — the terminal answers (drive sign-out, NOT retry):');
// These two are the fix: pre-fix each of these returned null (no terminal branch existed),
// so the write fell back to `unavailable` → direct write / 5s retry loop. Now they classify.
eq('403 account-disabled → "account-disabled"',
  terminalAuthCode(403, { error: 'Account disabled', code: 'account-disabled' }), 'account-disabled');
eq('403 not-on-team → "not-on-team"',
  terminalAuthCode(403, { error: 'Not on team', code: 'not-on-team' }), 'not-on-team');
// The code alone decides — the human-readable `error` string is irrelevant.
eq('403 account-disabled with no error string still classifies',
  terminalAuthCode(403, { code: 'account-disabled' }), 'account-disabled');

console.log('\nterminalAuthCode — NOT terminal (must still fall back / retry as today):');
// The field-guard 403 stays a `violations` answer, NOT terminal — the client handles it
// separately (revert + adopt). Over-broadening here would wrongly sign out on a rejected
// roles/permissions edit.
eq('403 with violations, no terminal code → null',
  terminalAuthCode(403, { error: 'refused', violations: [{ field: 'permissions' }] }), null);
// A bare 403 with no known code keeps today's behaviour (transport fallback). This is the
// guard against signing out on any unclassified 403.
eq('403 bare (no code) → null', terminalAuthCode(403, { error: 'Forbidden' }), null);
eq('403 unknown code → null', terminalAuthCode(403, { code: 'something-else' }), null);
// Only 403 is terminal — a 401 is an auth blip indistinguishable from a real one (see
// stateApi post()), a 5xx is transport, a 200 is success.
eq('401 account-disabled → null (only 403 is terminal)',
  terminalAuthCode(401, { code: 'account-disabled' }), null);
eq('500 → null', terminalAuthCode(500, null), null);
eq('200 → null', terminalAuthCode(200, { code: 'account-disabled' }), null);
// Defensive: a non-object / absent body never throws and never classifies.
eq('403 null payload → null', terminalAuthCode(403, null), null);
eq('403 undefined payload → null', terminalAuthCode(403, undefined), null);
eq('403 string payload → null', terminalAuthCode(403, 'account-disabled'), null);
eq('403 number payload → null', terminalAuthCode(403, 42), null);

console.log('\nTERMINAL_AUTH_CODES — exactly the two documented codes:');
ok('has account-disabled', TERMINAL_AUTH_CODES.has('account-disabled'));
ok('has not-on-team', TERMINAL_AUTH_CODES.has('not-on-team'));
eq('size is 2', TERMINAL_AUTH_CODES.size, 2);

console.log('\nterminalAuthMessage — a clear, actionable line per code:');
eq('account-disabled → the disabled message', terminalAuthMessage('account-disabled'), ACCOUNT_DISABLED_MESSAGE);
eq('not-on-team → the off-team message', terminalAuthMessage('not-on-team'), NOT_ON_TEAM_MESSAGE);
// A future/unknown terminal code must not render a blank line — it falls to the default.
eq('unknown code → default (disabled) message', terminalAuthMessage('some-new-code'), ACCOUNT_DISABLED_MESSAGE);
eq('undefined → default message', terminalAuthMessage(undefined), ACCOUNT_DISABLED_MESSAGE);
ok('disabled message names the account state', /disabled/i.test(ACCOUNT_DISABLED_MESSAGE));
ok('disabled message tells them who to contact', /owner/i.test(ACCOUNT_DISABLED_MESSAGE));
ok('off-team message names the team state', /team/i.test(NOT_ON_TEAM_MESSAGE));
ok('off-team message tells them who to contact', /owner/i.test(NOT_ON_TEAM_MESSAGE));

console.log(`\n${fail ? '✖' : '✓'} terminal-auth: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
