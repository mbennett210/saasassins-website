// Public inbound LEAD webhook: POST /api/webhooks/leads/:slug
//
// A 3rd party (Zapier / Make / n8n / native) POSTs a flat JSON contact; we upsert
// it through the SAME matching engine the CSV importer uses (api/_lib/leads/upsert
// → src/lib/csv.js) and route it to the webhook's configured ingestion point
// (Master New Leads intake by default, or any pipeline + stage). No session auth —
// the per-webhook bearer token authorizes (HMAC optional for advanced senders),
// exactly like the financial-snapshot inbound receiver self-verifies.
//
// Multi-segment catch-all is rewritten in via ?subpath= (see vercel.json), same
// as the other catch-all handlers. bodyParser is disabled so the raw body is
// available for the optional HMAC check, then JSON-parsed manually.
import crypto from 'node:crypto';
import { getEndpointBySlug, touchEndpoint, recordDelivery } from '../_lib/integrations/store.js';
import { verifyInbound } from '../_lib/integrations/hmac.js';
import { readOrgState, writeOrgState } from '../_lib/orgState.js';
import { ingestLead } from '../_lib/leads/upsert.js';
import { fanOutManagerAlert } from '../../src/lib/notifications.js';

// Build the newLead bell-row title/body from the just-created contact. Kept out
// of ingestLead (which the CSV importer also drives) so a bulk import doesn't
// ping per row — only the inbound-webhook boundary notifies.
function withLeadNotification(state, contactId) {
  const contact = (state.contacts || []).find((c) => c.id === contactId);
  if (!contact) return state;
  const name = `${contact.firstName || ''} ${contact.lastName || ''}`.trim();
  const company = contact.companyId
    ? ((state.clients || []).find((c) => c.id === contact.companyId)?.name || '')
    : '';
  const who = name || company || contact.email || contact.phone || 'someone';
  const source = contact.customFields?.source ? `via ${contact.customFields.source}` : null;
  return {
    ...state,
    notifications: fanOutManagerAlert(state, {
      eventKey: 'newLead',
      title: `New lead — ${who}`,
      body: [company && name ? company : null, contact.email || contact.phone || null, source].filter(Boolean).join(' · '),
      url: `/contacts/${contactId}`,
      actorUserId: null,
    }),
  };
}

export const config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(d));
    req.on('error', () => resolve(''));
  });
}

function bearerToken(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false;
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}

export default async function handler(req, res) {
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
    : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [seg0, slug] = path;

  if (seg0 !== 'leads') return res.status(404).json({ error: 'Unknown route' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!slug) return res.status(400).json({ error: 'Missing webhook id in URL' });

  let ep;
  try {
    ep = await getEndpointBySlug(slug);
  } catch (err) {
    console.error('[webhooks/leads] endpoint lookup failed', err);
    return res.status(500).json({ error: 'Server error' });
  }
  // 404 (not 401) for unknown/paused/wrong-purpose so we don't confirm a slug exists.
  if (!ep || !ep.is_active || ep.purpose !== 'lead_intake') {
    return res.status(404).json({ error: 'Webhook not found' });
  }

  const raw = await readRaw(req);

  // Auth: bearer token is primary (Zapier-friendly). HMAC is optional — only
  // verified when a signature header is present, for senders that can sign.
  const okBearer = ep.bearer_token ? safeEqual(bearerToken(req), ep.bearer_token) : false;
  const sig = req.headers['x-cleanspace-signature'] || req.headers['x-webhook-signature'];
  const okHmac = sig ? verifyInbound(raw, sig, ep.signing_secret) : false;
  if (!okBearer && !okHmac) {
    await recordDelivery({ webhookId: ep.id, direction: 'inbound', ok: false, statusCode: 401, error: 'bad auth' });
    return res.status(401).json({ error: 'Invalid or missing token' });
  }

  let body;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    await recordDelivery({ webhookId: ep.id, direction: 'inbound', ok: false, statusCode: 400, error: 'bad json' });
    return res.status(400).json({ error: 'Request body must be a JSON object' });
  }

  // CAS loop: read blob → apply upsert → write; retry on a version conflict
  // (another writer moved under us). 5 tries is plenty for a single-org store.
  let result = null;
  try {
    for (let attempt = 0; attempt < 5 && !result; attempt++) {
      const { state, version } = await readOrgState();
      const out = ingestLead(state, body, ep.lead_config || {});

      if (out.status === 'invalid') {
        await recordDelivery({ webhookId: ep.id, direction: 'inbound', ok: false, statusCode: 400, error: out.reason || 'invalid' });
        return res.status(400).json({ error: out.reason || 'At least one of email, phone, name, or company is required' });
      }
      if (out.status === 'skipped') {
        // No state change (nothing to enrich / duplicate) — don't write; idempotent.
        result = out;
        break;
      }
      // Ping the office ONLY on a genuinely new lead (not an enrichment of an
      // existing contact) — written atomically with the upsert in the same CAS.
      const nextState = out.status === 'created'
        ? withLeadNotification(out.state, out.contactId)
        : out.state;
      // `prev`: a lead naming a company the org doesn't have adds a customer, and customer
      // ids are in the org_state digest, so writeOrgState needs the read this was made from
      // to keep the digest current; without it the next save raised a baseline alarm.
      const wrote = await writeOrgState(nextState, version, { prev: state });
      if (wrote) result = out;
      // else loop: re-read the bumped version and re-apply
    }
  } catch (err) {
    console.error('[webhooks/leads] ingest failed', err);
    await recordDelivery({ webhookId: ep.id, direction: 'inbound', ok: false, statusCode: 500, error: err.message });
    // 5xx so Zapier/Make retry rather than dropping the lead.
    return res.status(500).json({ error: 'Server error' });
  }

  if (!result) {
    await recordDelivery({ webhookId: ep.id, direction: 'inbound', ok: false, statusCode: 503, error: 'write conflict' });
    return res.status(503).json({ error: 'Store busy — please retry' });
  }

  await touchEndpoint(ep.id);
  await recordDelivery({ webhookId: ep.id, direction: 'inbound', ok: true, statusCode: 200 });
  return res.status(200).json({ status: result.status, contactId: result.contactId || null });
}
