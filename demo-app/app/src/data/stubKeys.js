// localStorage keys for the DEMO/local stubs — ONE declaration per key, imported by BOTH
// halves: the seed builder (data/demoStubs.js) and the adapter that reads and writes the
// rows (lib/qcApi.js, lib/qboApi.js). No imports of its own, so either side can read it for
// free — and naming a key here never drags a stub's FIXTURES into the production bundle.
//
// WHY IT IS ITS OWN FILE. `lib/demoBootstrap.js` writes a stub only when its key is
// ABSENT (a present stub may hold the client's own edits), so a key is also the stub's
// SCHEMA VERSION: change a row's shape without moving the key and every browser that was
// already seeded keeps the old rows for ever. The checklist key was duplicated as a
// literal in both files, which is exactly how that could happen unnoticed — CS-403 moved
// the checklist row's completer from a name to `completed_by_user_id`, and an unbumped key
// would have left an existing demo browser showing "—" in the Quality hub and "Not
// started" for a cleaner's own earlier completion.
//
// 🔴 BUMP THE VERSION whenever a stub's ROW SHAPE changes, and list the old key in
// RETIRED_STUB_KEYS so the stale rows are cleared instead of lingering.

// v4 (2026-10-04, QR-5 / Round 2's scan page): the SAME row shape, a different demo story.
// Coral Bay HOA's Clubhouse now shows the three states a QR code can answer with — the lobby
// cleaned a few hours ago, the restrooms last finished more than 24 hours ago (tonight's clean
// left them unfinished), the hall floors never — so a browser seeded under v3, whose rows put
// both linked areas on one clean, would never show the 24-hour warning at all.
//
// v3 (2026-10-03, CS-547 + QR-1): a checklist row carries `client_submit_id` (the id its
// required photos are filed under) and `area_completions` (when each finished area of the
// clean finished). A browser left on v2 would hold rows with neither, so the location's
// "Last cleaned" line would read "not recorded yet" for every area for ever and the
// result pop-up would look up photos under `undefined`.
//
// v2 (2026-09-27, CS-403): checklist rows carry `completed_by_user_id`, not a name.
export const QC_CHECKLISTS_STUB_KEY = 'cleanspace_qc_checklists_stub_v4';

// v4 (2026-09-28, CS-546): a template's published SCHEMA now spells out each item's
// `naAllowed`, and one demo checklist item carries the office's "N/A ok" flag. The flag
// lives inside the row's `versions[].schema`, so a browser still holding a v3 stub would
// have every item unflagged and would never see the fill's N/A control at all — the same
// silent staleness the key exists to prevent.
//
// v3 (2026-09-28, plan step 5): a TEMPLATE row carries `client_id` — the customer a
// checklist is filed under, null for a starter (R2) — and `item_count`, the denormalized
// count of its PUBLISHED version's items, which the summary reads instead of pulling every
// schema. An already-seeded browser left on an older shape would read every checklist as a
// starter (no customer's menu would list one, and "Start from…" would offer all of them),
// and every item count as blank.
// v5 (2026-10-15, CS-850): the demo's checklists carry the Spanish and Creole lines the server writes
// on save (data/demoTranslations); a browser seeded on v4 would show them in English.
export const QC_TEMPLATES_STUB_KEY = 'cleanspace_qc_templates_stub_v5';

// v4 (2026-10-13, the Cleaner Hub's Client Requests): a work-order row carries `crew_user_ids` (the
// cleaners the office routed it to — WO-19's column, now set from the drawer for any ticket), and
// three of the demo's tickets name Demo Crew (Las Olas' lobby streaks, overdue; Palmetto's carpet,
// the manager's day; and Las Olas' paper towels, done this week). A browser left on v3 would hold
// rows naming nobody, so Demo Crew's Client Requests would be empty.
//
// v3 (2026-10-11, time to resolve — Matt's KPI, the Oct 6 call): the SAME row shape, a different
// demo story. The seeded book gains two more CLOSED tickets (a Las Olas request closed inside its
// 24-hour standard, and an urgent issue the office logged and closed at Bayshore), so Reports →
// Time to resolve shows every kind of figure, and Bayshore's hub tile shows the "none closed"
// sentence beside a closed ticket of the office's own. A browser left on v2 would never hold them.
//
// v2 (2026-10-04, Round 2's client hub): a work-order row carries `raised_by_client_user_id` /
// `raised_by_client_name` and each of its messages `internal` (WO-9) and
// `author_client_user_id`, and the seeded book gains Coral Bay's hub tickets (a client thread,
// an internal note, a ticket completed inside 7 days and one outside). A browser left on v1
// would hold none of that, so the hub preview's ticket pages would answer "not found".
// One declaration here since 2026-10-04; it was a literal in both data/demoStubs.js and
// lib/qcApi.js, the way the checklist key once was.
export const QC_PROBLEMS_STUB_KEY = 'cleanspace_qc_problems_stub_v4';

// v3 (2026-10-11, finish an inspection later — Matt, 2026-10-06): a row carries `updated_at`
// (when a draft was last saved: the 30-day retention clock and the device-vs-server comparison,
// lib/inspectionDrafts), and the seeded book gains an inspection LEFT OPEN at Coral Bay
// (`ir_coralbay_draft`, half ticked) so Continue can be seen. A browser left on v2 would never
// show an In progress row at all.
//
// v2 (2026-10-04, Round 2's client hub): the seeded book gains Coral Bay's FAILED inspection
// (`ir_coralbay_fail`) whose redo the hub shows as "What we are doing about it" (HUB-7). One
// declaration here since 2026-10-04 (it was a literal in data/demoStubs.js and lib/qcApi.js).
export const QC_INSPECTIONS_STUB_KEY = 'cleanspace_qc_inspections_stub_v3';

// v2 (2026-10-04, Wave 3): the SAME `{ connection, links }` shape, but the customer fixtures a
// link points at changed meaning — customers are now named "0001 Name" (GO-2) and the ids
// 1001… are those buildings, with jobs, an inactive and a quiet one for the "needs matching"
// list (QB-12). A browser left on v1 would keep links to ids that now name other customers.
//
// v1 (2026-09-25, CS-066): the QuickBooks Online demo stub's db — `{ connection, links }`.
// Read and written by lib/qboApi.js's demo STUB branch; the fixtures it paints from live in
// lib/qboStubData.js, which only that branch reaches (it dead-code-eliminates from
// `npm run build`, CS-066 C1). demoStubs.js lists this key so ?demo=reset wipes it back to
// disconnected.
export const QBO_STUB_KEY = 'cleanspace_qbo_stub_v2';

// v2 (2026-10-08, the client hub redesign): the SAME row shape, a different demo story — the book
// gains a MASTER agreement over Coral Bay HOA and Bayshore Senior Living, the two buildings the hub
// demo's customer contact sees, so the hub's Documents page shows a service agreement (and M3's
// "a master agreement opens from any building it covers"). A browser left on v1 would never see it.
//
// v1 (2026-10-03, CS-194): the contract book's demo db — `{ contracts: [...] }`, each row the
// SAME shape /api/contracts serves (camelCase, with its `years`, `lines` and `reminders`).
// Read and written by lib/contractsApi's demo STUB branch, which dead-code-eliminates from
// `npm run build`. demoStubs.js lists it so ?demo=reset puts the demo book back.
export const CONTRACTS_STUB_KEY = 'cleanspace_contracts_stub_v2';

// v1 (2026-10-08, the client hub redesign §3.6): the customer documents' demo db —
// `{ documents: [...] }`, each row the customer_documents TABLE's own snake_case shape, so the
// office screens and the hub's demo twin run the SAME pure projections the server does
// (lib/customerDocuments.js). Read and written by lib/customerDocumentsApi's demo branch (which a
// production build drops) and read by lib/hubDemo.js. The files themselves are not kept: a demo
// "View" opens the file picked this session, else a generated placeholder page.
export const CUSTOMER_DOCUMENTS_STUB_KEY = 'cleanspace_customer_documents_stub_v1';

// v2 (2026-10-11, the master supply list): `{ catalog: [...], items: [...], requests: [...] }`. The
// org's catalog joins the db, and a building's item is a SWITCH over it — `{ id, clientId,
// catalogItemId }`, its name, SKU, unit and price read from the catalog — where v1's item carried
// its own copy. A browser left on v1 would hold copies the screens no longer read and no catalog,
// so the key moves and v1 is retired.
//
// v1 (2026-10-05, SUP-13): the supplies' demo db — `{ items: [...], requests: [...] }`, each row the
// SAME shape /api/supplies serves (the app's dollar shape; the tables hold cents). Read and written
// by lib/suppliesApi's demo STUB branch, which dead-code-eliminates from `npm run build`. The
// queue and the approved lists left the shared record (INITIAL_STATE no longer carries
// supplyItems / supplyRequests), so this key is where the demo keeps them; demoStubs.js seeds it
// and lists it so ?demo=reset puts the demo's lists and requests back.
// v3 (S131, the supply orders): the db gains `comments` and `invoices`, every order a `number` (the
// story is SO-1041 on) and the per-line record (`fulfillment`). A browser seeded under v2 gets the
// new story as a missing stub (lib/demoBootstrap backfillMissingStubs) — its v2 rows are not read.
// v4 (S131 integration): the SAME shape; the story's cleaner, Keisha, now orders at Coral Bay HOA — her
// stop on the clock in the demo's day — which gains a switched-on list, and the completed order with its
// invoice (SO-1044) is hers there too. A browser seeded under v3, whose story sits at Palmetto Ridge and
// Las Olas, gets the new story as a missing stub (lib/demoBootstrap backfillMissingStubs).
export const SUPPLIES_STUB_KEY = 'cleanspace_supplies_stub_v4';

// v1 (2026-10-04, QR-6): the QR codes' demo db — `{ codes: [...] }`, each row the SAME shape
// as a backend `area_scan_codes` row. Read and written by lib/scanCodesApi's demo branch,
// which a production build drops; absent, it starts from data/demoScanCodes.js (Coral Bay
// HOA's three Clubhouse codes). demoStubs.js lists it so ?demo=reset puts those back.
export const SCAN_CODES_STUB_KEY = 'cleanspace_scan_codes_stub_v1';

// v1 (2026-10-17, QR-30): the visitors' thumbs in the demo — `{ ratings: [...] }`, each row the SAME
// shape as a backend `area_scan_ratings` row (the phone a demo stand-in hash). Written by the public
// scan page's demo (lib/scanCodesApi rateArea) and read by the office's Reports → Visitor ratings
// through the same module (fetchVisitorRatings) — its demo branch, which a production build drops;
// absent, it starts from data/demoAreaRatings.js (a week of votes on Coral Bay's Clubhouse areas).
// demoStubs.js lists it so ?demo=reset puts those back.
export const SCAN_RATINGS_STUB_KEY = 'cleanspace_scan_ratings_stub_v1';

// v1 (2026-10-03, UI_RULES §141): the team photos' demo "Storage" — `{ [userId]: { v, dataUrl,
// at } }`, the latest photo each member uploaded in this browser. Read and written by
// lib/avatarApi's demo branch, which a production build drops; the record itself
// (`users[].photo = { v }`) is in the demo's own store as in production. demoStubs.js lists it
// so ?demo=reset wipes the photos with the record that pointed at them. NEVER the state blob:
// an image does not belong in the shared record in the demo either.
export const AVATAR_STUB_KEY = 'cleanspace_avatar_stub_v1';

// v2 (2026-10-05, Matt's own form — HR-1 b): a row carries `reasons` (a list) and
// `previousMeetingDate`, and no longer `reason`, `clientId`/`clientName`, `incidentDate` or
// `consequence`. A browser left on v1 would hold rows the screens can no longer read (no
// reasons to show, a building the form has dropped), so the key moves and v1 is retired.
//
// v1 (2026-10-05, Matt's HR-1..HR-5): the HR warnings' demo db — `{ warnings: [...] }`, each
// row the SAME camelCase shape /api/hr-warnings serves (the one-warning read, signatures
// included). Read and written by lib/hrWarningsApi's demo branch, which a production build
// drops. demoStubs.js seeds it and lists it so ?demo=reset puts the demo's warnings back.
export const HR_WARNINGS_STUB_KEY = 'cleanspace_hr_warnings_stub_v2';

// v1 (2026-10-27, task #258 — Matt's "ACCIDENT / INCIDENT REPORT"): the HR incident reports' demo
// db — `{ incidents: [...] }`, each row the SAME camelCase shape /api/hr-incidents serves (the
// one-report read, signature included). Read and written by lib/hrIncidentsApi's demo branch,
// which a production build drops. demoStubs.js seeds it and lists it so ?demo=reset puts the
// demo's reports back.
export const HR_INCIDENTS_STUB_KEY = 'cleanspace_hr_incidents_stub_v1';

// v1 (2026-11-05, Super Clippy's idea #513 — Matt's termination form): the HR terminations' demo
// db — `{ terminations: [...] }`, each row the SAME camelCase shape /api/hr-terminations serves.
// Read and written by lib/hrTerminationsApi's demo branch, which a production build drops.
// demoStubs.js seeds it and lists it so ?demo=reset puts the demo's terminations back.
export const HR_TERMINATIONS_STUB_KEY = 'cleanspace_hr_terminations_stub_v1';

// Keys no build writes any more. demoBootstrap removes them on every load, so a browser
// seeded under an older shape does not carry its rows around for ever.
export const RETIRED_STUB_KEYS = [
  'cleanspace_qc_checklists_stub_v1',
  'cleanspace_qc_checklists_stub_v2',
  'cleanspace_qc_checklists_stub_v3',
  'cleanspace_qc_templates_stub_v1',
  'cleanspace_qc_templates_stub_v2',
  'cleanspace_qc_templates_stub_v3',
  'cleanspace_qc_templates_stub_v4',
  'cleanspace_qc_problems_stub_v1',
  'cleanspace_qc_problems_stub_v2',
  'cleanspace_qc_problems_stub_v3',
  'cleanspace_qc_inspections_stub_v1',
  'cleanspace_qc_inspections_stub_v2',
  'cleanspace_qbo_stub_v1',
  'cleanspace_hr_warnings_stub_v1',
  'cleanspace_contracts_stub_v1',
  'cleanspace_supplies_stub_v1',
];

// ── Builder B: customer messages (client hub redesign, plan §3.4) ──
// v1 (2026-10-08): the customer Messages' demo db — `{ messages: [...], reads: [...],
// updatesSeen: { [clientUserId]: iso }, emailPrefs: { [clientUserId]: { messages?, requests?,
// inspections? } } }`, each message the SAME snake_case row `public.client_messages` holds. Read and
// written by lib/clientMessagesDemo.js — reached only from lib/clientMessagesApi's demo gate (the
// office) and lib/hubDemo.js (the customer), both dropped from `npm run build`. demoStubs.js seeds
// it and lists it so ?demo=reset puts the demo thread back.
export const CLIENT_MESSAGES_STUB_KEY = 'cleanspace_client_messages_stub_v1';
