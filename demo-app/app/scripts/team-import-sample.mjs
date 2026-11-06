// A fictional TEAM spreadsheet for Settings → Team → Import team (task #466): the scale test's file
// (test-team-import.mjs, 1,000 people) and the demo drive's (30 rows with one of every problem).
// Fictional people only: ".example" emails, made-up employee IDs. Nothing here is anyone's data.
//
//   node app/scripts/team-import-sample.mjs 1000 > /tmp/team.csv          the clean file
//   node app/scripts/team-import-sample.mjs 30 --problems > /tmp/team.csv  one of every problem
//
// The accounts are the demo seed's customers (their numbers and names), so a file made here links
// to them in the login-free demo.
import { pathToFileURL } from 'node:url';

const FIRST = ['Rosa', 'Andre', 'Kim', 'Marisol', 'Tomas', 'Keisha', 'Luis', 'Yolanda', 'Jean', 'Fabiola', 'Wes', 'Nadia', 'Gabriel', 'Renata', 'Priya', 'Dana', 'Carlos', 'Mireille', 'Jorge', 'Esperanza'];
const LAST = ['Delgado', 'Baptiste', 'Nguyen', 'Featherstonehaugh-Delacroix', 'Rivera', 'Bryant', 'Ferrer', 'Reyes', 'Pierre', 'Joseph', 'Carter', 'Brooks', 'Ortiz', 'Cruz', 'Nair', 'Cole', 'Mendez', 'Augustin', 'Salazar', 'Valdés'];
const ROLES = ['Crew', 'Crew', 'Crew', 'Cleaner', 'Janitor', 'Porter', '', 'Crew'];
// The demo seed's customers, as the office would write them: by number, or by name.
export const SEED_ACCOUNTS = ['0001', '0002', 'Gulfstream Logistics', '0004 Coral Bay HOA', 'Palmetto Ridge Corp', '0006', 'Flagler Townhomes', 'Aventura Dental Group', 'Biscayne Harbor Apartments'];

export const SAMPLE_HEADERS = ['First Name', 'Last Name', 'Emp #', 'E-mail', 'Cell', 'Position', 'Rate ($/hr)', 'Building', 'SSN'];

// n rows (the header not counted). `problems`: the first rows carry one of every problem the
// import names, the rest are clean.
export function teamSampleRows(n = 1000, { problems = false, accounts = SEED_ACCOUNTS, idStart = 20001 } = {}) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const first = FIRST[i % FIRST.length];
    const last = LAST[Math.floor(i / FIRST.length) % LAST.length];
    const id = String(idStart + i);
    const email = `${first}.${last}.${i + 1}@example.com`.toLowerCase().replace(/[^a-z0-9.@-]/g, '');
    const phone = i % 3 === 0 ? '' : `(954) 555-${String(1000 + (i % 9000)).slice(-4)}`;
    const role = ROLES[i % ROLES.length];
    const cents = 1450 + ((i * 25) % 550);
    const pay = i % 4 === 0 ? `$${(cents / 100).toFixed(2)}/hr` : (cents / 100).toFixed(2);
    // Most work at one building; about one in ten at two.
    const account = i % 10 === 9 ? `${accounts[i % accounts.length]}; ${accounts[(i + 1) % accounts.length]}` : accounts[i % accounts.length];
    rows.push([first, last, id, email, phone, role, pay, account, 'xxx-xx-0000']);
  }
  if (problems) {
    const bad = [
      ['Ana', 'Sinemail', '29001', '', '', 'Crew', '15', '0001', ''], // no email
      ['Bo', 'Bademail', '29002', 'bo.bademail', '', 'Crew', '15', '0001', ''], // not an email
      ['Cy', 'Twice', '29003', rows[0][3], '', 'Crew', '15', '0001', ''], // the same email as row 2
      ['Di', 'Sameid', rows[0][2], 'di.sameid@example.com', '', 'Crew', '15', '0001', ''], // the same employee ID as row 2
      ['Ed', 'Boss', '29005', 'ed.boss@example.com', '', 'Super Admin', '', '', ''], // never from a file
      ['Flo', 'Lead', '29006', 'flo.lead@example.com', '', 'Crew Lead', '15', '0001', ''], // a role the import doesn't read
      ['Gus', 'Rate', '29007', 'gus.rate@example.com', '', 'Crew', 'fifteen', '0001', ''], // not a pay rate
      ['Hal', 'Nowhere', '29008', 'hal.nowhere@example.com', '', 'Crew', '16', 'Nowhere Plaza', ''], // no such customer
      ['Ida', 'Vendor', '29009', 'ida.vendor@example.com', '', 'Crew', '16', 'Sunshine Supply Co', ''], // a vendor is never cleaned
      ['Jo', 'Mixup', '29010', 'jo.mixup@example.com', '', 'Crew', '16', '0001 Coral Bay HOA', ''], // number and name differ
      ['Kai', 'Manager', '29011', 'kai.manager@example.com', '', 'Account Manager', '', '0002', ''], // an account for a non-cleaner
      ['Lu', 'Noid', '', 'lu.noid@example.com', '', 'Crew', '16', '0002', ''], // no employee ID: one is made
      ['Mo', 'Highrate', '29013', 'mo.highrate@example.com', '', 'Crew', '150', '0002', ''], // a high hourly rate
      ['Andre', 'Baptiste', 'EMP-0006', 'andre@cleanspaceonline.com', '', 'Admin', '15', '0004', ''], // on the team: fill blanks only
      ['Tomas', 'Rivera', 'EMP-0099', 'tomas@cleanspaceonline.com', '', 'Crew', '', '', ''], // on the team with another ID
    ];
    return [...bad, ...rows].slice(0, Math.max(n, bad.length));
  }
  return rows;
}

const quote = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export function teamSampleCsv(n, opts) {
  return [SAMPLE_HEADERS, ...teamSampleRows(n, opts)].map((r) => r.map((v) => quote(String(v))).join(',')).join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const n = Number(process.argv[2]) || 1000;
  process.stdout.write(`${teamSampleCsv(n, { problems: process.argv.includes('--problems') })}\n`);
}
