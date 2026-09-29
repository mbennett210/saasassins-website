// Shared visual-QA route matrix. Stable, id-free routes so pixel baselines don't
// churn on seed changes. Detail pages carry per-clone seeded ids (see
// scripts/responsive-sweep.mjs ROUTES) — add specific ones here per clone if a
// detail layout needs a baseline. Keep this list curated: every route here is one
// baseline × every device project, committed to the repo.
export const VISUAL_ROUTES = [
  '/',
  '/schedule',
  '/customers',
  '/invoices',
  '/variance',
  '/inspections',
  '/keys',
  '/quotes',
  '/messaging',
  '/drafts',
  '/marketing',
  '/settings/company',
  '/settings/team',
  '/settings/operations',
];
