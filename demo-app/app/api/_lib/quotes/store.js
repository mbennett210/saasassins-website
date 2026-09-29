// Service-role data layer for e-signature quote documents + their PDF/signature
// objects in Supabase Storage. Browser never touches these; only the quotes/
// public-sign serverless functions do.
import { getSupabase } from '../supabase.js';
import { randomToken } from '../tokens.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { requireSafeSegment } from '../storagePaths.js';
import { readOrgState, writeOrgState } from '../orgState.js';
import { fanOutManagerAlert } from '../../../src/lib/notifications.js';

const BUCKET = 'quote-documents';

// The quote's public_token IS the capability: holding it lets someone view AND
// legally sign a service agreement. Math.random() is not cryptographic, so these
// were guessable; same length/alphabet, CSPRNG source. Existing tokens are in
// links already sent to customers and stay valid — see _lib/tokens.js.
export function generateToken() {
  return randomToken(14);
}

// Default editable field values for a new quote — the 7 fields of the quote's
// pages (the brand pack's quote.html, UI_RULES §129). clientName/companyName auto-fill
// from the contact; the rest start blank for the rep to fill inline.
function seedFields(contact) {
  return {
    clientName: contact?.name || '',
    companyName: contact?.company || contact?.companyName || '',
    date: '',
    amount: '',
    frequency: '',
    dayOfWeek: '',
    restrooms: '',
  };
}

export async function createFromTemplate({ contact, templateKey, createdBy }) {
  const db = getSupabase();
  const label = contact?.company || contact?.companyName || contact?.name || 'Quote';
  const { data, error } = await db
    .from('quotes')
    .insert({
      organization_id: CLEANSPACE_ORG_ID,
      public_token: generateToken(),
      contact_id: contact?.id ?? null,
      contact_name: contact?.name ?? null,
      contact_email: contact?.email ?? null,
      contact_phone: contact?.phone ?? null,
      title: `Quote — ${label}`,
      template_key: templateKey || 'cleanspace_quote_v1',
      fields: seedFields(contact),
      status: 'draft',
      created_by: createdBy || null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function listQuotes() {
  const db = getSupabase();
  const { data, error } = await db
    .from('quotes')
    .select('*')
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function getQuoteById(id) {
  const db = getSupabase();
  const { data, error } = await db.from('quotes').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function getQuoteByToken(token) {
  const db = getSupabase();
  const { data, error } = await db.from('quotes').select('*').eq('public_token', token).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

// A quote's terms FREEZE the moment it is sent (owner decision 2026-07-21):
// the signed PDF renders from live `fields`, so a post-send edit would let a
// customer sign one figure while the executed document shows another. The
// editor already renders read-only after send; this is the server-side law —
// it also closes the editor's own 600ms debounced save racing a quick Send.
// Thrown as a typed error so the route can answer 409 rather than 500.
export class QuoteFrozenError extends Error {
  constructor(status) {
    super(`This quote is ${status} — its fields are locked. Void it and create a new quote to change terms.`);
    this.code = 'QUOTE_FROZEN';
  }
}
function requireDraft(quote) {
  if (!quote) return; // absent row falls through to the caller's own 404/update-miss handling
  if (quote.status !== 'draft') throw new QuoteFrozenError(quote.status);
}

// The status predicate MUST live on the UPDATE itself (compare-and-set), not
// only on a prior SELECT: a check-then-write pair leaves a window where the
// editor's debounced save (or a double-fired serverless invocation) reads
// 'draft', a concurrent /send commits 'sent', and the late UPDATE then rewrites
// a frozen quote anyway. 0 rows updated = the state moved under us = frozen.
async function frozenErrorFor(db, id) {
  const { data } = await db.from('quotes').select('status').eq('id', id).maybeSingle();
  return new QuoteFrozenError(data?.status || 'no longer editable');
}

// Merge edited fields, bump doc_version. Draft-only (see QuoteFrozenError),
// enforced ON the write via .eq('status','draft').
export async function saveFields(id, fields) {
  const db = getSupabase();
  const { data: existing } = await db.from('quotes').select('fields, doc_version, status').eq('id', id).maybeSingle();
  requireDraft(existing);
  const merged = { ...(existing?.fields || {}), ...(fields || {}) };
  const { data, error } = await db
    .from('quotes')
    .update({ fields: merged, doc_version: (existing?.doc_version || 1) + 1, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'draft')
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw await frozenErrorFor(db, id);
  return data;
}

// Draft-only, same freeze law as saveFields: re-signing after send would swap
// the signature block on a document the customer is already reviewing.
// (The route also pre-checks status BEFORE uploading the signature PNG — the
// PNG lives at a fixed path with upsert, so a gate that only ran here would
// reject the row write after the stored image was already replaced.)
export async function recordAdminSignature(id, { signerName, signaturePath }) {
  const db = getSupabase();
  const { data: existing } = await db.from('quotes').select('status').eq('id', id).maybeSingle();
  requireDraft(existing);
  const { data, error } = await db
    .from('quotes')
    .update({
      admin_signed_at: new Date().toISOString(),
      admin_signer_name: signerName || null,
      admin_signature_path: signaturePath || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'draft')
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw await frozenErrorFor(db, id);
  return data;
}

export async function markSent(id) {
  const db = getSupabase();
  // Never regress a terminal state: re-marking a SIGNED quote as 'sent' would
  // un-execute an executed agreement (and 'void' is final). Re-sending an
  // already-'sent' quote stays allowed — it just refreshes sent_at. CAS on the
  // write: a customer signature landing mid-request must win, not be stomped.
  const { data, error } = await db
    .from('quotes')
    .update({ status: 'sent', sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .in('status', ['draft', 'sent'])
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw await frozenErrorFor(db, id);
  return data;
}

// CAS: only a quote still 'sent' can become 'signed'. The public sign flow's
// chromium PDF render takes multi-second wall time; without the status
// predicate, an admin void landing during the render was overwritten and the
// voided quote resurrected as an executed agreement.
export async function recordClientSignature(id, { signerName, signerEmail, signerIp, signaturePath, signedPdfPath }) {
  const db = getSupabase();
  const { data, error } = await db
    .from('quotes')
    .update({
      status: 'signed',
      client_signed_at: new Date().toISOString(),
      client_signer_name: signerName || null,
      client_signer_email: signerEmail || null,
      client_signer_ip: signerIp || null,
      client_signature_path: signaturePath || null,
      signed_pdf_path: signedPdfPath || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'sent')
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw await frozenErrorFor(db, id);
  return data;
}

// Notify the office that a client signed a quote — a server-side org_state write
// (the push-dispatch cron then delivers it), because signing happens on a public,
// auth-less, tab-less page. Recipients are managers via the shared manager-alert
// fan-out; the signer is an external client so there is no actor to exclude.
// CAS-guarded + best-effort: never fails the signature that was just recorded.
export async function notifyManagersOfSignedQuote(quote, tries = 4) {
  if (!quote) return;
  try {
    const who = quote.contact_name || quote.client_signer_name || 'a client';
    for (let i = 0; i < tries; i++) {
      const { state, version } = await readOrgState();
      const notifications = fanOutManagerAlert({ ...state, notifications: state.notifications || [] }, {
        eventKey: 'quoteSigned',
        title: `Quote signed — ${who}`,
        body: quote.client_signer_name ? `Signed by ${quote.client_signer_name}` : '',
        url: '/quotes',
        actorUserId: null,
      });
      const ok = await writeOrgState({ ...state, notifications }, version);
      if (ok) return;
    }
  } catch { /* best-effort — the signature is already recorded */ }
}

export async function voidQuote(id) {
  const db = getSupabase();
  const { data, error } = await db
    .from('quotes')
    .update({ status: 'void', updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

// Hard delete: remove the quote's storage objects (sigs + PDFs), then the row.
export async function deleteQuote(id) {
  const db = getSupabase();
  try {
    // Same validation as storagePaths — this branch builds the folder itself and would
    // otherwise be the one unguarded way in, on the destructive path of all things.
    requireSafeSegment(id, 'quoteId');
    const folder = `${CLEANSPACE_ORG_ID}/${id}`;
    const { data: objs } = await db.storage.from(BUCKET).list(folder);
    if (objs && objs.length) {
      await db.storage.from(BUCKET).remove(objs.map((o) => `${folder}/${o.name}`));
    }
  } catch { /* best-effort storage cleanup — never block the row delete */ }
  const { error } = await db.from('quotes').delete().eq('id', id);
  if (error) throw error;
  return { ok: true };
}

// ── Storage (private quote-documents bucket) ────────────────────────────────
export async function uploadObject(path, bytes, contentType) {
  const db = getSupabase();
  const body = bytes instanceof Buffer ? bytes : Buffer.from(bytes);
  const { error } = await db.storage.from(BUCKET).upload(path, body, { contentType, upsert: true });
  if (error) throw error;
  return path;
}

export async function downloadObject(path) {
  const db = getSupabase();
  const { data, error } = await db.storage.from(BUCKET).download(path);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

export async function signedUrl(path, expiresSeconds = 600) {
  if (!path) return null;
  const db = getSupabase();
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, expiresSeconds);
  if (error) throw error;
  return data.signedUrl;
}

export function storagePaths(quoteId, version = 1) {
  // `quoteId` reaches here from the request path. Every key below is derived from it,
  // and deleteQuote() lists + REMOVES everything under the same folder, so an
  // unvalidated value is a cross-resource read AND delete inside the private bucket.
  requireSafeSegment(quoteId, 'quoteId');
  const base = `${CLEANSPACE_ORG_ID}/${quoteId}`;
  return {
    adminSig: `${base}/sig-admin.png`,
    clientSig: `${base}/sig-client.png`,
    previewPdf: `${base}/preview.pdf`,     // admin-signed, client block blank (for review)
    signedPdf: `${base}/signed-${version}.pdf`, // fully signed
  };
}
