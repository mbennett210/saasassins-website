// Inbound lead-webhook engine verification — drives api/_lib/leads/upsert.js
// (the ported counterpart to the CSV importer) against a fixture org state and
// asserts: create + Master-intake routing, explicit pipeline routing + source
// tags, account-tie (new→prospect, existing-by-name) + auto-primary, lifecycle
// 'client' → active company, fill-blanks enrichment without overwrite, idempotent
// skip (with contactId), never yanking a working-pipeline contact, inbound tag
// names resolved/created, payload pipeline/stage override, validation, and input
// immutability (so the CAS loop never half-writes).
//
// Usage: node scripts/test-lead-upsert.mjs

import assert from 'node:assert/strict';
import { ingestLead } from '../api/_lib/leads/upsert.js';

let pass = 0;
function ok(label, fn) { fn(); pass += 1; console.log(`  ✓ ${label}`); }

function fixtureState() {
  return {
    pipelines: [
      { id: 'pl_master', isMaster: true, label: 'Master Pipeline', stages: [] },
      { id: 'pl_leads', label: '1.1 Leads', stages: [{ key: 'new-lead', label: 'New Lead' }] },
      { id: 'pl_sales', label: '1.2 Sales', stages: [{ key: 'walkthrough', label: 'Walkthrough Scheduled' }, { key: 'won', label: 'Bid Won' }] },
      { id: 'pl_clients', label: '1.3 Clients', stages: [{ key: 'new-client', label: 'New Client+' }] },
    ],
    clients: [
      { id: 'cl_evergreen', name: 'Evergreen Medical Group', email: 'pat@evergreenmed.com', status: 'active', primaryContactId: 'ct_pat' },
    ],
    contacts: [
      { id: 'ct_pat', email: 'pat@evergreenmed.com', firstName: 'Pat', lastName: 'Ramirez', phone: '', title: 'Director', companyId: 'cl_evergreen', tagIds: [], lifecycle: 'client', stage: null, pipelineId: null },
      { id: 'ct_working', email: 'sam@working.com', firstName: 'Sam', lastName: '', phone: '5550199', companyId: null, tagIds: [], lifecycle: 'lead', stage: 'won', pipelineId: 'pl_sales' },
    ],
    tags: [{ id: 'tg_vip', label: 'VIP', color: 'red', scope: 'all' }],
  };
}

const masterCfg = { pipelineId: 'pl_master', stage: 'intake', lifecycle: 'lead', tagIds: [] };
const salesCfg = { pipelineId: 'pl_sales', stage: 'walkthrough', lifecycle: 'lead', tagIds: ['tg_vip'] };

console.log('lead-upsert engine:');

ok('new lead → created at Master New Leads intake, lifecycle lead', () => {
  const s = fixtureState();
  const out = ingestLead(s, { email: 'new1@example.com', firstName: 'New' }, masterCfg);
  assert.equal(out.status, 'created');
  const c = out.state.contacts.find((x) => x.id === out.contactId);
  assert.equal(c.pipelineId, 'pl_master');
  assert.equal(c.stage, 'intake');
  assert.equal(c.lifecycle, 'lead');
  // immutability: the input state is untouched (CAS loop re-applies on a fresh read)
  assert.equal(s.contacts.length, 2);
});

ok('explicit routing → lands in 1.2 Sales · Walkthrough + source tag applied', () => {
  const s = fixtureState();
  const out = ingestLead(s, { email: 'new2@example.com', firstName: 'Two' }, salesCfg);
  const c = out.state.contacts.find((x) => x.id === out.contactId);
  assert.equal(c.pipelineId, 'pl_sales');
  assert.equal(c.stage, 'walkthrough');
  assert.ok(c.tagIds.includes('tg_vip'));
});

ok('unknown company → new prospect account + auto-primary contact', () => {
  const s = fixtureState();
  const out = ingestLead(s, { email: 'three@acmeproperty.com', firstName: 'Three', company: 'Acme Property Mgmt' }, masterCfg);
  const c = out.state.contacts.find((x) => x.id === out.contactId);
  const acct = out.state.clients.find((cl) => cl.name === 'Acme Property Mgmt');
  assert.ok(acct, 'account created');
  assert.equal(acct.status, 'prospect');
  assert.equal(c.companyId, acct.id);
  assert.equal(acct.primaryContactId, c.id);
});

ok('company matches existing account by normalized name (no dupe account)', () => {
  const s = fixtureState();
  const out = ingestLead(s, { email: 'four@example.com', firstName: 'Four', company: 'Evergreen Medical Group, LLC' }, masterCfg);
  const c = out.state.contacts.find((x) => x.id === out.contactId);
  assert.equal(c.companyId, 'cl_evergreen');
  assert.equal(out.state.clients.length, 1); // no new account
});

ok('lifecycle "client" → new account created Active', () => {
  const s = fixtureState();
  const out = ingestLead(s, { email: 'boss@newco.com', firstName: 'Boss', company: 'NewCo Holdings', lifecycle: 'client' }, masterCfg);
  const acct = out.state.clients.find((cl) => cl.name === 'NewCo Holdings');
  assert.equal(acct.status, 'active');
});

ok('matched by email → fills blank phone, never overwrites existing name', () => {
  const s = fixtureState();
  const out = ingestLead(s, { email: 'pat@evergreenmed.com', phone: '555-0201', firstName: 'NotPat' }, masterCfg);
  assert.equal(out.status, 'updated');
  const c = out.state.contacts.find((x) => x.id === 'ct_pat');
  assert.equal(c.phone, '555-0201'); // was blank → filled
  assert.equal(c.firstName, 'Pat');  // populated → preserved
});

ok('idempotent re-post → skipped, still reports contactId', () => {
  const s = fixtureState();
  const first = ingestLead(s, { email: 'pat@evergreenmed.com', phone: '555-0201' }, masterCfg);
  const again = ingestLead(first.state, { email: 'pat@evergreenmed.com', phone: '555-0201' }, masterCfg);
  assert.equal(again.status, 'skipped');
  assert.equal(again.contactId, 'ct_pat');
});

ok('existing contact in a working pipeline is enriched but NOT moved', () => {
  const s = fixtureState();
  const out = ingestLead(s, { email: 'sam@working.com', lastName: 'Working' }, masterCfg);
  const c = out.state.contacts.find((x) => x.id === 'ct_working');
  assert.equal(c.pipelineId, 'pl_sales'); // stays put
  assert.equal(c.stage, 'won');
  assert.equal(c.lastName, 'Working'); // blank → filled
});

ok('inbound tag names are resolved/created (contact scope) and applied', () => {
  const s = fixtureState();
  const out = ingestLead(s, { email: 'tagme@example.com', firstName: 'Tag', tags: ['Paid Social'] }, masterCfg);
  const c = out.state.contacts.find((x) => x.id === out.contactId);
  const tag = out.state.tags.find((t) => t.label === 'Paid Social');
  assert.ok(tag, 'tag created');
  assert.equal(tag.scope, 'contact');
  assert.ok(c.tagIds.includes(tag.id));
});

ok('payload pipeline/stage override (by label) beats the endpoint default', () => {
  const s = fixtureState();
  const out = ingestLead(s, { email: 'ovr@example.com', firstName: 'Ovr', pipeline: '1.2 Sales', stage: 'Bid Won' }, masterCfg);
  const c = out.state.contacts.find((x) => x.id === out.contactId);
  assert.equal(c.pipelineId, 'pl_sales');
  assert.equal(c.stage, 'won');
});

ok('no identifier → invalid (no write)', () => {
  const s = fixtureState();
  const out = ingestLead(s, { notes: 'just a note' }, masterCfg);
  assert.equal(out.status, 'invalid');
});

ok('company-only payload is accepted (created)', () => {
  const s = fixtureState();
  const out = ingestLead(s, { company: 'Standalone Co' }, masterCfg);
  assert.equal(out.status, 'created');
});

console.log(`\n${pass} assertions passed.`);
