// One-time setup: create Supabase Auth accounts for the CleanSpace team, matching
// the seeded team emails (the app maps a login → team member + role by email).
// Reads credentials from app/.env.local (service-role key — never hardcoded).
//
// Usage (from app/):  node scripts/create-auth-users.mjs
//   • Set a chosen password:   TEMP_PASSWORD='Something#Strong1' node scripts/create-auth-users.mjs
//   • Otherwise a strong random temp password is generated and printed once.
// Re-running is safe: already-existing accounts are skipped.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const env = {};
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const url = env.SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in app/.env.local'); process.exit(1); }

const admin = createClient(url, key, { auth: { persistSession: false } });

// Must exactly match the seeded team emails in src/data/seed.js.
const EMAILS = [
  'kyle@cleanspaceonline.com',
  'steve@cleanspaceonline.com',
  'heather@cleanspaceonline.com',
  'lauren@cleanspaceonline.com',
  'marcus@cleanspaceonline.com',
  'riley@cleanspaceonline.com',
  'jamie@cleanspaceonline.com',
  'casey@cleanspaceonline.com',
];

const tempPassword = process.env.TEMP_PASSWORD || `CleanSpace-${randomBytes(5).toString('hex')}!`;

let created = 0;
for (const email of EMAILS) {
  const { error } = await admin.auth.admin.createUser({ email, password: tempPassword, email_confirm: true });
  if (error) console.log(`SKIP  ${email} — ${error.message}`);
  else { console.log(`OK    ${email}`); created += 1; }
}
console.log(`\nCreated ${created}/${EMAILS.length} accounts.`);
if (created > 0) {
  console.log(`TEMP PASSWORD (newly created accounts): ${tempPassword}`);
  console.log('→ Have each person change it after first login.');
}
