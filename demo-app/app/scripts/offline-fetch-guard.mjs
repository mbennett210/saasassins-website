// Preload for running a live-capable script OFFLINE in a test: every fetch must go to
// OFFLINE_ONLY_URL (a local fake), anything else is refused before it leaves the machine.
//   node --import ./offline-fetch-guard.mjs some-script.mjs     (with OFFLINE_ONLY_URL set)
// Refuses to run at all without OFFLINE_ONLY_URL, so it can't be used to wave a live
// script through. Not a test file (no `test-` prefix): run-tests.mjs neither runs nor scans it.
const only = process.env.OFFLINE_ONLY_URL;
if (!only || !/^http:\/\/127\.0\.0\.1:\d+$/.test(only)) {
  console.error('offline-fetch-guard: OFFLINE_ONLY_URL must be a local http://127.0.0.1:<port> fake.');
  process.exit(4);
}
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const u = String(typeof input === 'string' ? input : input?.url ?? input);
  if (!u.startsWith(only)) {
    console.error(`offline-fetch-guard: refused ${u}`);
    return Promise.reject(new Error(`offline: refused ${u}`));
  }
  return realFetch(input, init);
};
