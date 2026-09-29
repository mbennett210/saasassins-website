// CSV import routes the service address to the CUSTOMER'S LOCATION, never the person.
//
// One location per customer (S23): the address is the LOCATION's defining field. The
// importer used to map a single `address` column onto the contact and create companies
// with no address (blank locations). This suite pins the new routing:
//   • CONTACT_FIELDS carries the structured location columns and NO person `address`
//     (the fail-first assertion — it fails against the pre-change field list);
//   • buildImportPlan attaches `location` to each create/update row, and `mapped` never
//     carries `address`;
//   • buildClientLocation (the reducer's ADD_CLIENT hook) turns the structured address
//     into the customer's one location — proving the address lands where the modal sends it.
//
// Pure client-side helpers — no app/api, offline-safe.
// Usage: node scripts/test-csv-location-import.mjs

import assert from 'node:assert/strict';
import {
  CONTACT_FIELDS,
  LOCATION_FIELD_KEYS,
  locationFromMapped,
  buildImportPlan,
} from '../src/lib/csv.js';
import { buildClientLocation } from '../src/lib/location.js';

let pass = 0;
function ok(label, fn) {
  fn();
  pass += 1;
  console.log(`  ✓ ${label}`);
}

const fieldKeys = CONTACT_FIELDS.map((f) => f.key);

ok('CONTACT_FIELDS has the four structured location columns', () => {
  for (const k of ['locStreet', 'locCity', 'locState', 'locZip']) {
    assert.ok(fieldKeys.includes(k), `missing ${k}`);
  }
  assert.deepEqual(LOCATION_FIELD_KEYS, ['locStreet', 'locCity', 'locState', 'locZip']);
});

ok('CONTACT_FIELDS no longer has a person `address` field (fail-first)', () => {
  assert.ok(!fieldKeys.includes('address'), 'address must not be a contact field — the person never has an address');
});

ok('locationFromMapped: structured columns → {street,city,state,zip}; empty → null', () => {
  assert.deepEqual(
    locationFromMapped({ locStreet: '500 SE 3rd Ave', locCity: 'Fort Lauderdale', locState: 'FL', locZip: '33301' }),
    { street: '500 SE 3rd Ave', city: 'Fort Lauderdale', state: 'FL', zip: '33301' },
  );
  assert.equal(locationFromMapped({ firstName: 'Pat' }), null, 'no location columns → null (skip the location)');
  assert.deepEqual(
    locationFromMapped({ locStreet: '1 Main St' }),
    { street: '1 Main St', city: '', state: '', zip: '' },
    'partial location still returns an object',
  );
});

// buildImportPlan wiring: a create row carries the parsed location; the person payload
// (`mapped`) never carries an address key.
const headers = ['First Name', 'Company', 'Street', 'City', 'State', 'ZIP'];
const mapping = { 0: 'firstName', 1: 'company', 2: 'locStreet', 3: 'locCity', 4: 'locState', 5: 'locZip' };

ok('buildImportPlan attaches location to a create row; mapped has no address', () => {
  const [row] = buildImportPlan({
    rows: [['Pat', 'Acme Cleaning', '500 SE 3rd Ave', 'Fort Lauderdale', 'FL', '33301']],
    headers, mapping, existingContacts: [], existingClients: [], mode: 'upsert', requireCompany: true,
  });
  assert.equal(row.action, 'create');
  assert.deepEqual(row.location, { street: '500 SE 3rd Ave', city: 'Fort Lauderdale', state: 'FL', zip: '33301' });
  assert.ok(!('address' in row.mapped), 'mapped must not carry a person address');
});

ok('buildImportPlan: a row with no location columns → location null', () => {
  const [row] = buildImportPlan({
    rows: [['Sam', 'Naked Co', '', '', '', '']],
    headers, mapping, existingContacts: [], existingClients: [], mode: 'upsert', requireCompany: true,
  });
  assert.equal(row.action, 'create');
  assert.equal(row.location, null);
});

// The ADD_CLIENT hook the modal relies on: structured address on the client → the
// customer's single location carries that address (composed + discrete fields).
ok('buildClientLocation seeds the location address from structured client fields', () => {
  const site = buildClientLocation(
    { id: 'cl_x', type: 'customer', street: '500 SE 3rd Ave', city: 'Fort Lauderdale', state: 'FL', zip: '33301', serviceId: null, createdAt: '2026-01-01T00:00:00.000Z' },
    [],
  );
  assert.equal(site.clientId, 'cl_x');
  assert.equal(site.street, '500 SE 3rd Ave');
  assert.equal(site.city, 'Fort Lauderdale');
  assert.equal(site.state, 'FL');
  assert.equal(site.zip, '33301');
  assert.ok(/500 SE 3rd Ave/.test(site.address) && /Fort Lauderdale/.test(site.address) && /33301/.test(site.address),
    `composed address should carry the full street/city/zip, got "${site.address}"`);
});

console.log(`\n${pass} assertions passed — csv location-import routing.\n`);
