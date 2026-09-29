// Server-side lead upsert — the inbound-webhook counterpart to the CSV importer.
//
// It REUSES the importer's matching engine (src/lib/csv.js `buildImportPlan` +
// normalizers) verbatim by feeding it a single synthetic row, then applies the
// resulting plan to the org_state blob by PORTING the reducer's ADD_CONTACT /
// UPDATE_CONTACT / ADD_CLIENT side effects plus CsvImportModal.doImport's
// account-create / route / tag-union logic. Pure (no I/O, no React, no store) —
// same posture as api/_lib/marketing/engine.js, so the webhook and the
// interactive importer compute identical results and can't drift.
//
// Entry point: ingestLead(state, payload, endpointConfig) -> { state, status,
// contactId, reason }. The caller (api/webhooks/[...path].js) does the CAS write.

import { buildImportPlan } from '../../../src/lib/csv.js';
import { newId } from '../../../src/lib/ids.js';

const nowIso = () => new Date().toISOString();
const has = (v) => !!(v && String(v).trim());

// The importer maps these CSV columns; we feed one synthetic row so the engine
// runs exactly like a 1-row CSV upsert. `id` is a Contact-ID match key (a sender
// echoing back our contactId matches exactly); it's never adopted as our id.
const FIELDS = ['firstName', 'lastName', 'email', 'phone', 'title', 'company', 'lifecycle', 'notes', 'id'];

// Resolve the effective ingestion point: endpoint defaults, overridable per
// payload. pipeline/stage accept an id or a (case-insensitive) name/label.
function resolveRouting(state, config = {}, payload = {}) {
  const pipelines = state.pipelines || [];
  const master = pipelines.find((p) => p.isMaster) || null;
  const masterId = master ? master.id : null;

  const findPipeline = (ref) => {
    if (ref == null || ref === '') return null;
    const s = String(ref).trim().toLowerCase();
    return pipelines.find((p) => p.id === ref) || pipelines.find((p) => (p.label || '').toLowerCase() === s) || null;
  };

  // Pipeline: payload override (id or name) wins over the endpoint default.
  let pipelineId = config.pipelineId || null;
  const overridePipeline = findPipeline(payload.pipelineId || payload.pipeline);
  if (overridePipeline) pipelineId = overridePipeline.id;
  const chosen = pipelines.find((p) => p.id === pipelineId) || null;

  // Stage: Master only has the implicit New Leads intake; otherwise resolve a
  // payload override (key or label) against the chosen pipeline, else the
  // endpoint default, else the pipeline's first stage.
  let stage = null;
  if (chosen) {
    if (chosen.isMaster) {
      stage = 'intake';
    } else {
      const stageRef = has(payload.stage) ? payload.stage : config.stage;
      const sl = String(stageRef || '').trim().toLowerCase();
      const match = (chosen.stages || []).find((s) => s.key === stageRef || (s.label || '').toLowerCase() === sl);
      stage = match ? match.key : (chosen.stages && chosen.stages[0] ? chosen.stages[0].key : null);
    }
  }

  const lifecycle = has(payload.lifecycle) ? payload.lifecycle : (config.lifecycle || 'lead');
  const tagIds = Array.isArray(config.tagIds) ? config.tagIds.filter(Boolean) : [];
  return { pipelineId, stage, lifecycle, tagIds, masterId };
}

// Resolve inbound tag NAMES (Zapier sends names, not our ids) to tag ids,
// creating any that don't exist (contact scope) — mirrors TagPicker.createNew /
// the ADD_TAG reducer. Returns { tagIds, tags } where `tags` is the (possibly
// extended) tag list to persist.
function resolveTagNames(tags, names) {
  if (!Array.isArray(names) || names.length === 0) return { tagIds: [], tags };
  let list = tags;
  const ids = [];
  for (const raw of names) {
    const label = String(raw == null ? '' : raw).trim();
    if (!label) continue;
    const existing = list.find((t) => (t.label || '').toLowerCase() === label.toLowerCase());
    if (existing) { ids.push(existing.id); continue; }
    const tag = { id: newId('tg'), label, color: 'slate', scope: 'contact' };
    list = [...list, tag];
    ids.push(tag.id);
  }
  return { tagIds: ids, tags: list };
}

// Create a client/account record — mirrors the ADD_CLIENT reducer defaults +
// CsvImportModal.ensureAccountId's status-from-lifecycle.
function makeClient(name, lifecycle) {
  return {
    id: newId('cl'),
    name,
    status: lifecycle === 'client' ? 'active' : 'prospect',
    revenue: 0,
    notes: '',
    createdAt: nowIso(),
    lastServiceAt: null,
    primaryContactId: null,
  };
}

// Tie a plan's resolved account to a concrete companyId, creating the account if
// new. Returns { companyId, clients } (clients extended when an account is made).
function ensureAccount(clients, account, lifecycle) {
  if (!account) return { companyId: null, clients };
  if (!account.isNew) return { companyId: account.id, clients };
  const client = makeClient(account.name, lifecycle);
  return { companyId: client.id, clients: [...clients, client] };
}

// Bulk-route into the chosen pipeline — mirrors CsvImportModal.routePatch: never
// pull a contact out of a working (non-Master) pipeline, and skip if already there.
function routePatch(routing, existing) {
  const { pipelineId, stage, masterId } = routing;
  if (!pipelineId || !stage) return null;
  if (existing && existing.pipelineId && existing.pipelineId !== masterId) return null;
  if (existing && existing.pipelineId === pipelineId && existing.stage === stage) return null;
  return { pipelineId, stage };
}

// Build a new contact — mirrors the ADD_CONTACT reducer (defaults, lead→Master
// intake fallback, first-contact-becomes-primary). Returns { contact, clients }.
function buildContact(contactInput, clients, pipelines) {
  const email = (contactInput.email || '').trim().toLowerCase();
  const base = {
    id: newId('ct'),
    email: '',
    firstName: '', lastName: '', title: '', phone: '',
    companyId: null,
    tagIds: [],
    lifecycle: 'lead',
    stage: null, dealValue: null, expectedCloseDate: null, stageChangedAt: nowIso(),
    notes: '', customFields: {},
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  const contact = { ...base, ...contactInput, email };
  if (contact.lifecycle === 'lead' && !contact.pipelineId && !contact.stage) {
    const master = (pipelines || []).find((p) => p.isMaster);
    if (master) { contact.pipelineId = master.id; contact.stage = 'intake'; }
  }
  let nextClients = clients;
  if (contact.companyId) {
    nextClients = clients.map((cl) =>
      cl.id === contact.companyId && !cl.primaryContactId ? { ...cl, primaryContactId: contact.id } : cl
    );
  }
  return { contact, clients: nextClients };
}

// Apply an UPDATE_CONTACT-style patch (enrichment + route + tags) with the
// reducer's company side effects (adopt primary, promote prospect→active on
// lifecycle 'client'). Returns the next { contacts, clients }.
function applyContactPatch(state, contactId, patch, clients) {
  const existing = (state.contacts || []).find((c) => c.id === contactId);
  const fullPatch = { ...patch, updatedAt: nowIso() };
  if (fullPatch.email) fullPatch.email = String(fullPatch.email).trim().toLowerCase();
  const companyId = fullPatch.companyId !== undefined ? fullPatch.companyId : (existing && existing.companyId);
  const becameClient = fullPatch.lifecycle === 'client' && existing && existing.lifecycle !== 'client';
  let nextClients = clients;
  if (companyId) {
    nextClients = clients.map((cl) => {
      if (cl.id !== companyId) return cl;
      let next = cl;
      if (!next.primaryContactId) next = { ...next, primaryContactId: contactId };
      if (becameClient && next.status === 'prospect') next = { ...next, status: 'active' };
      return next;
    });
  }
  const contacts = (state.contacts || []).map((c) => (c.id === contactId ? { ...c, ...fullPatch } : c));
  return { contacts, clients: nextClients };
}

// Upsert one inbound lead into the org_state blob.
//   state          — the whole app store (contacts, clients, pipelines, tags…)
//   payload        — the flat inbound JSON
//   endpointConfig — the webhook's lead_config: { pipelineId, stage, lifecycle, tagIds, sourceLabel }
// Returns { state, status: 'created'|'updated'|'skipped'|'invalid', contactId, reason }.
export function ingestLead(state, payload = {}, endpointConfig = {}) {
  const routing = resolveRouting(state, endpointConfig, payload);

  // Per-lead tag names (payload) layer on top of the endpoint's configured tags.
  const { tagIds: payloadTagIds, tags: tagsAfter } = resolveTagNames(state.tags || [], payload.tags);
  const tagIds = [...new Set([...routing.tagIds, ...payloadTagIds])];
  let workingState = tagsAfter === (state.tags || []) ? state : { ...state, tags: tagsAfter };

  // One synthetic CSV row → reuse the importer's engine for match + account-tie +
  // fill-blanks enrichment. Lifecycle is the resolved default so normalizeContact
  // coerces it into the canonical set.
  const rowObj = {
    firstName: payload.firstName, lastName: payload.lastName, email: payload.email,
    phone: payload.phone, title: payload.title, company: payload.company,
    lifecycle: routing.lifecycle, notes: payload.notes,
    id: payload.contactId || payload.id,
  };
  const headers = FIELDS;
  const mapping = Object.fromEntries(FIELDS.map((f, i) => [i, f]));
  const row = FIELDS.map((f) => (rowObj[f] == null ? '' : String(rowObj[f])));

  const bulk = (tagIds.length || (routing.pipelineId && routing.stage))
    ? { tagIds, pipelineId: routing.pipelineId, stageKey: routing.stage, masterId: routing.masterId }
    : null;

  const plan = buildImportPlan({
    rows: [row], headers, mapping,
    existingContacts: workingState.contacts || [],
    existingClients: workingState.clients || [],
    mode: 'upsert',
    bulk,
  });
  const r = plan[0];

  if (r.action === 'invalid') {
    return { state, status: 'invalid', contactId: null, reason: r.reason };
  }
  if (r.action === 'skip') {
    // Matched but nothing to change, or a same-call duplicate — idempotent no-op.
    return { state: workingState, status: 'skipped', contactId: r.contactId || null, reason: r.reason };
  }

  if (r.action === 'create') {
    let clients = workingState.clients || [];
    const { companyId, clients: clients2 } = ensureAccount(clients, r.account, r.mapped.lifecycle);
    clients = clients2;

    const contactInput = { ...r.mapped };
    delete contactInput.company;
    delete contactInput.id; // never adopt a sender-supplied id as our internal id
    if (companyId) contactInput.companyId = companyId;
    if (tagIds.length) contactInput.tagIds = [...new Set([...(contactInput.tagIds || []), ...tagIds])];
    if (has(payload.source)) contactInput.customFields = { ...(contactInput.customFields || {}), source: String(payload.source).trim() };
    const route = routePatch(routing, null);
    if (route) Object.assign(contactInput, route);

    const { contact, clients: clients3 } = buildContact(contactInput, clients, workingState.pipelines);
    return {
      state: { ...workingState, clients: clients3, contacts: [...(workingState.contacts || []), contact] },
      status: 'created',
      contactId: contact.id,
    };
  }

  // r.action === 'update'
  let clients = workingState.clients || [];
  const existing = (workingState.contacts || []).find((c) => c.id === r.contactId);
  const patch = {};
  for (const ch of (r.changes || [])) {
    if (ch.field === 'companyId') {
      const { companyId, clients: c2 } = ensureAccount(clients, ch.to, r.mapped.lifecycle);
      clients = c2;
      if (companyId) patch.companyId = companyId;
    } else {
      patch[ch.field] = ch.to;
    }
  }
  if (tagIds.length) {
    const union = [...new Set([...((existing && existing.tagIds) || []), ...tagIds])];
    if (union.length !== ((existing && existing.tagIds) || []).length) patch.tagIds = union;
  }
  const route = routePatch(routing, existing);
  if (route) Object.assign(patch, route);

  if (Object.keys(patch).length === 0) {
    return { state: workingState, status: 'skipped', contactId: r.contactId, reason: 'Already up to date' };
  }

  const { contacts, clients: clientsAfter } = applyContactPatch(workingState, r.contactId, patch, clients);
  return {
    state: { ...workingState, contacts, clients: clientsAfter },
    status: 'updated',
    contactId: r.contactId,
  };
}
