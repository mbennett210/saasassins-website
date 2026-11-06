// The customer page's section tabs, in order, from what the viewer may see. ONE rule, so the
// tab strip, the `?tab=` deep link and its clamp read the same list: a tab the viewer may not
// open is never offered, and a stale `?tab=` for it falls back to Overview rather than leaving
// the body blank.
//
//   contract  — contracts.view (CON: owner/admin/manager, never crew)
//   documents — hub.documents.manage (the client hub redesign, plan 2026-10-08 §3.6: the COI,
//               W-9 and agreement the customer downloads from the hub — beside the Contract tab
//               it links to)
//   supplies  — supplies.view (round 3, Daniel 2026-10-06: the building's own Supplies tab —
//               its list, budget and order day, and its requests — after Contract, before
//               Activity, as in the mockup he picked)
//   messages  — hub.messages.view (the client hub redesign, plan §3.4, D5: the building's
//               conversation with its customers — after Supplies, before Activity)
//
// Plain JS with no imports, so the node suites load it (test-supplies-page.mjs C18).
export function clientSectionKeys({ contracts = false, documents = false, supplies = false, messages = false } = {}) {
  return [
    'overview', 'access', 'contacts',
    ...(contracts ? ['contract'] : []),
    ...(documents ? ['documents'] : []),
    ...(supplies ? ['supplies'] : []),
    ...(messages ? ['messages'] : []),
    'activity', 'notes',
  ];
}
