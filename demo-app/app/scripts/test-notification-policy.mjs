// Regression coverage for the mandatory-notifications policy (lib/roles): crew
// cannot mute event notifications, the reducer/Account UI's single source of truth.
// Run: node app/scripts/test-notification-policy.mjs
import { areNotificationsMandatory, applyMandatoryNotificationPolicy } from '../src/lib/roles.js';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.error(`FAIL: ${label}\n  got  ${g}\n  want ${w}`); };
};

const crew = { id: 'u1', role: 'crew' };
const owner = { id: 'u2', role: 'owner' };
const admin = { id: 'u3', role: 'admin' };
const manager = { id: 'u4', role: 'manager' };

// which roles are mandatory
eq('crew is mandatory', areNotificationsMandatory(crew), true);
eq('owner not mandatory', areNotificationsMandatory(owner), false);
eq('admin not mandatory', areNotificationsMandatory(admin), false);
eq('manager not mandatory', areNotificationsMandatory(manager), false);
eq('null not mandatory', areNotificationsMandatory(null), false);

// crew: event mutes are dropped, enables pass, channel pref passes
eq('crew mutes one event → dropped', applyMandatoryNotificationPolicy(crew, { checklistDue: false }), {});
eq('crew mutes two events → dropped', applyMandatoryNotificationPolicy(crew, { checklistDue: false, inspectionDue: false }), {});
eq('crew enable passes', applyMandatoryNotificationPolicy(crew, { checklistDue: true }), { checklistDue: true });
eq('crew mobile push OFF passes (channel pref, device is theirs)', applyMandatoryNotificationPolicy(crew, { mobilePushEnabled: false }), { mobilePushEnabled: false });
eq('crew mobile push ON passes', applyMandatoryNotificationPolicy(crew, { mobilePushEnabled: true }), { mobilePushEnabled: true });
eq('crew mixed patch keeps enables + channel, drops event mute',
  applyMandatoryNotificationPolicy(crew, { checklistDue: false, mobilePushEnabled: false, newDM: true }),
  { mobilePushEnabled: false, newDM: true });

// non-crew: patch passes through untouched (they may mute)
eq('owner may mute an event', applyMandatoryNotificationPolicy(owner, { checklistDue: false }), { checklistDue: false });
eq('manager may mute an event', applyMandatoryNotificationPolicy(manager, { inspectionDue: false }), { inspectionDue: false });

console.log(`\nnotification-policy: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
