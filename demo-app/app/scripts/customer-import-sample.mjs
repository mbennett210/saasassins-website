// A realistic Customers-import file at Clean Space's scale: N buildings (default 750), each with
// a customer number, a name, a South-Florida address, a supervisor and K contacts (default 2, so
// 1,500 contacts on 1,500 rows — a building's later rows add its other contacts). Fictional
// throughout (".example" mail, 555 phones). Used by test-customer-import.mjs's scale check and to
// write the file the demo imports:
//
//   node app/scripts/customer-import-sample.mjs [--buildings 750] [--contacts 2] [--out file.csv]
//
// Numbers start at 0101 so they never meet the demo book's 0001–0007.
import { writeFileSync } from 'node:fs';
import { toCsvText } from '../src/lib/csv.js';

const FIRST = ['Ana', 'Luis', 'Rosa', 'Marcus', 'Priya', 'Devon', 'Keisha', 'Tomas', 'Elena', 'Jamal', 'Sofia', 'Andre', 'Grace', 'Omar', 'Lena', 'Carlos', 'Nadia', 'Victor', 'Imani', 'Rafael'];
const LAST = ['Silva', 'Gomez', 'Diaz', 'Bennett', 'Nair', 'Brooks', 'Bryant', 'Rivera', 'Petrova', 'Hughes', 'Martinez', 'Baptiste', 'Kim', 'Haddad', 'Novak', 'Ortiz', 'Farouk', 'Alvarez', 'Okafor', 'Castillo'];
const PLACE = ['Harbor', 'Palm', 'Coral', 'Bayview', 'Sawgrass', 'Cypress', 'Lakeside', 'Ocean', 'Sunrise', 'Mangrove', 'Royal', 'Heron', 'Pelican', 'Tarpon', 'Banyan', 'Seagrape'];
const KIND = ['Towers', 'Plaza', 'Office Park', 'Commons', 'Medical Center', 'Corporate Center', 'Lofts', 'Village', 'Pointe', 'Executive Suites', 'Trade Center', 'Gardens'];
const CITY = [['Pompano Beach', '33062'], ['Coral Springs', '33065'], ['Plantation', '33324'], ['Sunrise', '33351'], ['Weston', '33326'], ['Hollywood', '33021'],
  ['Miramar', '33025'], ['Pembroke Pines', '33027'], ['Boca Raton', '33431'], ['Delray Beach', '33444'], ['Miami', '33131'], ['Doral', '33172'], ['Hialeah', '33012'], ['Davie', '33314']];
const STREET = ['NW 36th St', 'SE 3rd Ave', 'N Federal Hwy', 'W Commercial Blvd', 'Las Olas Blvd', 'S University Dr', 'NW 87th Ave', 'Biscayne Blvd', 'Glades Rd', 'Pines Blvd'];
const SUPERVISORS = ['renata@cleanspaceonline.com', 'yolanda@cleanspaceonline.com', 'priya@cleanspaceonline.com'];
const ROLE = ['Property manager', 'Facilities director', 'Office manager', 'Building engineer', 'Operations lead'];

export const SAMPLE_HEADERS = ['Customer #', 'Customer name', 'Type', 'Street', 'City', 'State', 'ZIP', 'Supervisor',
  'Contact first name', 'Contact last name', 'Contact email', 'Contact phone', 'Contact role', 'Notes'];

// Rows (arrays), deterministic for a given size.
export function sampleBuildingRows({ buildings = 750, contactsPerBuilding = 2 } = {}) {
  const rows = [];
  for (let b = 0; b < buildings; b += 1) {
    const number = String(101 + b).padStart(4, '0');
    const name = `${PLACE[b % PLACE.length]} ${KIND[Math.floor(b / PLACE.length) % KIND.length]} ${Math.floor(b / (PLACE.length * KIND.length)) + 1}`;
    const [city, zip] = CITY[b % CITY.length];
    const street = `${1000 + ((b * 37) % 8999)} ${STREET[b % STREET.length]}`;
    const domain = `${PLACE[b % PLACE.length].toLowerCase()}${b}.example`;
    for (let k = 0; k < contactsPerBuilding; k += 1) {
      const first = FIRST[(b + k * 7) % FIRST.length];
      const last = LAST[(b * 3 + k) % LAST.length];
      const phone = `(${['305', '754', '954'][(b + k) % 3]}) 555-${String((b * 13 + k * 97) % 10000).padStart(4, '0')}`;
      const first2 = k === 0;
      rows.push([
        number, name, 'Customer', first2 ? street : '', first2 ? city : '', first2 ? 'FL' : '', first2 ? zip : '',
        first2 ? SUPERVISORS[b % SUPERVISORS.length] : '',
        first, last, `${first.toLowerCase()}.${last.toLowerCase()}.${k}@${domain}`, phone, ROLE[(b + k) % ROLE.length],
        first2 && b % 4 === 0 ? 'Lobby, restrooms and break room nightly; gate code at the front desk.' : '',
      ]);
    }
  }
  return rows;
}

export function sampleBuildingsCsv(opts) {
  return toCsvText([SAMPLE_HEADERS, ...sampleBuildingRows(opts)]);
}

// CLI
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
  const buildings = Number(arg('--buildings', 750));
  const contactsPerBuilding = Number(arg('--contacts', 2));
  const out = arg('--out', `customers-${buildings}.csv`);
  writeFileSync(out, sampleBuildingsCsv({ buildings, contactsPerBuilding }));
  console.log(`wrote ${out}: ${buildings} buildings, ${buildings * contactsPerBuilding} contacts`);
}
