// CleanSpace is single-company. Backend code threads an organization_id through
// every table/query; here we pin it to one constant so that logic ports unchanged.
// The matching row lives in the `organizations` table (created by the early
// migrations) and carries org branding (name + logo).
//
// Lived at _lib/forms/constants.js until the Forms module was retired (2026-09-19) —
// these constants were always org identity, not forms code, so they moved here.
//
// Override via env if you ever seed a different organizations row.
export const CLEANSPACE_ORG_ID =
  process.env.FORMS_ORG_ID || '00000000-0000-0000-0000-000000000001';
