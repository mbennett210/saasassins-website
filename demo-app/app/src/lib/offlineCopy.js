// Shared "saved, will sync" copy for offline-durable STORE actions — key check in/out,
// job status (Start / Mark Done / …), and complaints. These dispatch into the org_state
// store; sync.js flush() persists them to the on-device offlineCache and replays the CAS
// write when the connection returns, so the data is already durable with no signal — the
// same guarantee the clock-punch and checklist queues give. This just makes that visible
// per-action, so a crew member offline sees the identical "Saved on this device — it'll
// sync" reassurance instead of a bare success that looks like it reached the server.
//
// Pure + dependency-free so the message choice is unit-tested (test-offline-copy.mjs).
export const SAVED_OFFLINE = 'Saved on this device. It’ll sync when you’re back online.';

// The success message for a store write: the normal confirmation when online, the
// offline-parity reassurance when there's no signal. Fail-safe — only an explicit
// `false` (navigator reported offline) swaps the copy; undefined/true keep the normal
// message, so a surface that doesn't pass a flag never mis-reports "offline".
export function savedMsg(online, onlineMsg) {
  return online === false ? SAVED_OFFLINE : onlineMsg;
}
