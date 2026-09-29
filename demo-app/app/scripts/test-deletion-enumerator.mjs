// Phase-A proof for the deletion-ripple audit: the enumerator's coverage is asserted,
// not eyeballed. Auto-discovered by run-tests.mjs (offline; imports only the pure store
// via the resolve shim — no live service).
//
//   node app/scripts/test-deletion-enumerator.mjs
//
// It pins three things that would otherwise rot silently:
//   1. the real reducer + seed import under plain node (the load-bearing capability);
//   2. the three nets rediscover the fields a naive `/Id$/` grep structurally misses
//      (map-key refs, non-Id-suffixed refs, email refs) WITHOUT being told they exist;
//   3. the manifest reconciles against a fresh enumeration — every enumerated cell is
//      classified, no field is left UNCLASSIFIED, and every delete action is moded.
// So a new reference field, or a new delete action, cannot land un-audited.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadStore, enumerateUniverse } from './deletion-core.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };

const { reducer, ACTIONS, INITIAL_STATE } = await loadStore();
const u = enumerateUniverse(INITIAL_STATE);
const cells = u.cells;

// ── 1. the load-bearing capability ──
ok(typeof reducer === 'function', 'ENUM-01 A: the real reducer imports under plain node');
ok(ACTIONS && typeof ACTIONS.DELETE_USER === 'string', 'ENUM-01 B: ACTIONS resolves DELETE_USER');
ok(INITIAL_STATE && Array.isArray(INITIAL_STATE.clients), 'ENUM-01 C: INITIAL_STATE hydrates clients');
// a no-op dispatch returns the SAME reference — the property guard-blocks rely on.
ok(reducer(INITIAL_STATE, { type: 'NO_SUCH_ACTION_XYZ' }) === INITIAL_STATE, 'ENUM-01 D: unknown action is an identity no-op (guard-block detection)');

// ── 2. tricky cells rediscovered UNAIDED ──
// map-key ref: crewChecklists { [userId]: templateId } — invisible to an /Id$/ grep.
ok(cells.has('clients[].crewChecklists.{key}'), 'ENUM-02 A: N1 finds the crewChecklists map-key ref (userId)');
// non-Id-suffixed user ref — only the value-join can see it.
ok(cells.has('timeOff[].createdBy') && cells.get('timeOff[].createdBy').nets.has('N3'), 'ENUM-02 B: N3 value-join finds the non-Id-suffixed ref timeOff.createdBy');
// email-as-FK — value-join against the contact email set.
ok(cells.has('marketingSends[].toEmail'), 'ENUM-02 C: N3 finds the email-as-FK marketingSends.toEmail');
ok(cells.has('messages[].fromEmail'), 'ENUM-02 D: N3 finds messages.fromEmail (email-as-FK)');
// the pilot finding: read receipts carry user ids.
ok(cells.has('messages[].readByUserIds'), 'ENUM-02 E: read-receipt id-array messages.readByUserIds enumerated');
ok(cells.has('keyEvents[].holderUserId'), 'ENUM-02 F: keyEvents.holderUserId enumerated');

// ── 3. traps are NOT mistaken for FKs ──
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../deletion.manifest.json', import.meta.url)), 'utf8'));
for (const trap of ['oauthWorkspaces[].clientId', 'users[].hr.employeeId', 'marketingSends[].providerMessageId', 'messages[].emailHeaders.messageId']) {
  ok(!manifest.fields[trap] && manifest.excluded[trap], `ENUM-03: ${trap} classified EXTERNAL-NOT-FK, not a live FK`);
}

// ── 4. manifest reconciles against THIS fresh enumeration ──
const classified = new Set([...Object.keys(manifest.fields), ...Object.keys(manifest.excluded)]);
const enumerated = [...cells.keys()];
const unclassified = enumerated.filter((c) => !classified.has(c));
ok(unclassified.length === 0, `ENUM-04 A: every enumerated cell is classified (${unclassified.length} unclassified: ${unclassified.slice(0, 5).join(', ')})`);
const unpolicied = Object.entries(manifest.fields).filter(([, v]) => v.policy === 'UNCLASSIFIED').map(([k]) => k);
ok(unpolicied.length === 0, `ENUM-04 B: no manifest field left UNCLASSIFIED (${unpolicied.slice(0, 5).join(', ')})`);
const unmoded = [...u.actions.keys()].filter((a) => !manifest.actions[a] || manifest.actions[a].mode === 'UNCLASSIFIED');
ok(unmoded.length === 0, `ENUM-04 C: every delete-family action is moded (${unmoded.slice(0, 5).join(', ')})`);
// every policy uses the declared vocabulary.
const VOCAB = new Set(['SWEEP', 'NULLIFY', 'NULLIFY+name', 'REPOINT', 'BLOCK', 'BLOCK-UNSETTLED', 'KEEP-BY-DESIGN', 'NOT-EXERCISABLE']);
const badPolicy = Object.entries(manifest.fields).filter(([, v]) => !VOCAB.has(v.policy)).map(([k]) => k);
ok(badPolicy.length === 0, `ENUM-04 D: every field policy is in the declared vocabulary (${badPolicy.slice(0, 5).join(', ')})`);
// a name-keeping cell names the field the person's name must land in, on the SAME
// top-level row (the harness proves "+NAME" there, so only `coll[].field` cells qualify).
const unnamed = Object.entries(manifest.fields).filter(([, v]) => v.policy === 'NULLIFY+name' && !v.nameField).map(([k]) => k);
ok(unnamed.length === 0, `ENUM-04 E: every NULLIFY+name cell declares its nameField (${unnamed.slice(0, 5).join(', ')})`);
const badNamePath = Object.entries(manifest.fields).filter(([k, v]) => v.nameField && !/^[A-Za-z]+\[\]\.[A-Za-z]+$/.test(k)).map(([k]) => k);
ok(badNamePath.length === 0, `ENUM-04 F: nameField only on top-level row cells (${badNamePath.slice(0, 5).join(', ')})`);

console.log(`\n${pass}/${pass + fail} deletion-enumerator assertions passed  ·  ${enumerated.length} cells enumerated · ${Object.keys(manifest.fields).length} fields + ${Object.keys(manifest.excluded).length} excluded · ${u.actions.size} delete actions`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exit(1); }
console.log('');
