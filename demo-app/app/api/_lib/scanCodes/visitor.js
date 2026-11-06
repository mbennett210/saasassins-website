// Service-role data layer for a VISITOR's two writes from the public QR page (QR-22..QR-26, QR-30):
// a report of a problem (EP-414) and a thumbs up or down on the area (EP-415), and the office's read
// of the votes (EP-416). The route (api/public/scan) has already held the request to its shape
// (lib/visitorReports, lib/areaRatings) and its in-process allowance; everything here is about the
// DATABASE: the durable limits, the code's liveness, and the writes.
//
// 🔴 THE CODE DECIDES WHERE. The location, its customer and the area are the scanned code's —
// resolved from the token (store.resolveScanToken) and checked against the live record by the ONE
// location rule every scan resolver shares (lib/scanCodes scanLocationOf: a removed location or
// area, and whatever else that rule refuses, reads as "no longer active"). Nothing the visitor sent
// names a building, an area, a type or an origin.
//
// 🔴 A REPORT IS A TICKET LIKE ANY OTHER (QR-25): the office's own createProblem (origin 'visitor',
// the caller-minted id read back first), then the same supervisor-first bell (notifyTicketRaised),
// and from then on the same deadlines, repeats and queues as every ticket at that building. It is
// the office's alone (QR-26): the customer's hub reads only origin 'portal' (clientHub/reads), and
// the ticket volume leaves it out (lib/workOrders ticketCountsByClient).
//
// THE PHONE is the HMAC of the page's random device id (_lib/crypto purposeHmac, a key derived from
// a server secret for this purpose alone): counted, never reversible, never an IP. No secret, no
// write — the route answers "not available" rather than count nothing.
import { randomBytes, randomUUID } from 'node:crypto';
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { readOrgState, readProtectedSlices } from '../orgState.js';
import { purposeHmac } from '../crypto.js';
import { requireSafeSegment } from '../storagePaths.js';
import { isValidStoragePath } from '../accountMedia/refs.js';
import { confirmUpload } from '../accountMedia/store.js';
import { selectAll, exactCount } from '../pagedSelect.js';
import { createProblem, notifyTicketRaised, getProblem } from '../qc/store.js';
import { resolveScanToken } from './store.js';
import { scanLocationOf } from '../../../src/lib/scanCodes.js';
import { isVisitorReport } from '../../../src/lib/workOrders.js';
import {
  visitorLimitWindows, visitorLimitVerdict, visitorTicketInput, VISITOR_PHOTO_EXT, VISITOR_REPORT_CODES,
} from '../../../src/lib/visitorReports.js';
import {
  areaRatingLimitVerdict, ratingDay, ratingRetentionCutoffDay, voteOfValue,
} from '../../../src/lib/areaRatings.js';

const LEDGER = 'visitor_reports';
const RATINGS = 'area_scan_ratings';
const BUCKET = 'ops-media';
export const VISITOR_PHOTO_SCOPE = 'visitor_report';
export const DEVICE_HASH_PURPOSE = 'visitor-device/v1';
// Every vote one report may read: a year of a busy book's votes is far below this.
export const RATING_READ_MAX_ROWS = 200000;

// The phone's pseudonym.
export function deviceHash(deviceId) {
  return purposeHmac(deviceId, DEVICE_HASH_PURPOSE);
}

// The scanned code's location in the live record, or null: the shared location rule over the shared
// record's customers and locations. A REPORT reads the whole record once (request-cached: the ticket's
// names and its bell read the same snapshot, which they need anyway); a VOTE reads only the three
// slices it needs (`narrow`), never the whole document per tap.
async function liveLocation(code, { narrow = false } = {}) {
  if (narrow) {
    const slices = await readProtectedSlices('clients:state->clients,sites:state->sites,tz:state->company->>timezone');
    const loc = scanLocationOf({
      code,
      sites: Array.isArray(slices?.sites) ? slices.sites : [],
      clients: Array.isArray(slices?.clients) ? slices.clients : [],
    });
    return loc ? { loc, timeZone: typeof slices?.tz === 'string' && slices.tz ? slices.tz : null } : null;
  }
  const { state } = await readOrgState();
  const loc = scanLocationOf({ code, sites: state?.sites || [], clients: state?.clients || [] });
  return loc ? { loc, timeZone: state?.company?.timezone || null } : null;
}

const ledgerCount = async (db, narrow) => {
  const { count, error } = await narrow(db.from(LEDGER).select('problem_id', { count: 'exact', head: true })
    .eq('organization_id', CLEANSPACE_ORG_ID));
  if (error) throw error;
  return exactCount(count);
};

// A caller-minted id that already names a ticket: this phone's own report again (a retry after a
// lost answer, a double send) when it is a visitor's ticket at THIS code's location and area — else
// it is not ours to answer about.
function isOwnReplay(ticket, code) {
  return isVisitorReport(ticket) && ticket.site_id === code.siteId
    && (ticket.site_area_id == null || ticket.site_area_id === code.areaId);
}

// ── EP-414: file a visitor's report ─────────────────────────────────────────────────────────
// `input` is lib/visitorReports visitorReportInput's value; `photo` is { bytes, mimeType } already
// checked by the route, or null.
// → { outcome: 'filed', ticketId, photoSaved, replay? } | { outcome: 'duplicate' }
//   | { outcome: 'inactive' } | { outcome: 'refused', code }
export async function fileVisitorReport({ token, input, photo = null, nowMs = Date.now() }, db = getSupabase()) {
  const code = await resolveScanToken(token, db);
  if (!code || !code.id) return { outcome: 'inactive' };
  const hash = deviceHash(input.deviceId);
  // A retry of a report already filed is answered as filed, before any limit could refuse it.
  if (input.id) {
    const existing = await getProblem(input.id);
    if (existing) {
      return isOwnReplay(existing, code)
        ? { outcome: 'filed', ticketId: existing.id, photoSaved: null, replay: true }
        : { outcome: 'refused', code: VISITOR_REPORT_CODES.id, status: 409 };
    }
  }
  const w = visitorLimitWindows(nowMs);
  const [sameRecent, phoneCodeHour, phoneDay, codeHour] = await Promise.all([
    ledgerCount(db, (q) => q.eq('code_id', code.id).eq('device_hash', hash).eq('choice', input.choice).gte('created_at', w.sameSinceIso)),
    ledgerCount(db, (q) => q.eq('code_id', code.id).eq('device_hash', hash).gte('created_at', w.hourAgoIso)),
    ledgerCount(db, (q) => q.eq('device_hash', hash).gte('created_at', w.dayAgoIso)),
    ledgerCount(db, (q) => q.eq('code_id', code.id).gte('created_at', w.hourAgoIso)),
  ]);
  const verdict = visitorLimitVerdict({ sameRecent, phoneCodeHour, phoneDay, codeHour });
  if (verdict.duplicate) return { outcome: 'duplicate' };
  if (verdict.refused) return { outcome: 'refused', code: verdict.code };

  const live = await liveLocation(code);
  if (!live) return { outcome: 'inactive' };
  const { loc } = live;
  const ticketInput = visitorTicketInput({ choice: input.choice, text: input.text, areaLabel: loc.area });
  const id = input.id || randomUUID();
  let ticket;
  try {
    ticket = await createProblem({
      id,
      clientId: loc.clientId,
      siteId: loc.siteId,
      jobId: null,
      ...ticketInput,
      assigneeUserId: null,
      reportedByUserId: null,
      siteAreaId: loc.areaId,
      reporterName: input.name,
      reporterContact: input.contact,
    });
  } catch (e) {
    // The same id won a race (a double send): answer the winner.
    if (e?.code === '23505') {
      const winner = await getProblem(id);
      if (winner && isOwnReplay(winner, code)) return { outcome: 'filed', ticketId: winner.id, photoSaved: null, replay: true };
      return { outcome: 'refused', code: VISITOR_REPORT_CODES.id, status: 409 };
    }
    throw e;
  }

  // The ledger row the limits count. Best-effort after the ticket (the ticket is the record): a lost
  // row costs one report's worth of allowance, never the report.
  const { error: ledgerError } = await db.from(LEDGER).insert({
    problem_id: ticket.id,
    organization_id: CLEANSPACE_ORG_ID,
    code_id: code.id,
    site_id: loc.siteId,
    area_id: loc.areaId,
    device_hash: hash,
    choice: input.choice,
  });
  if (ledgerError) console.error('[scanCodes/visitor] ledger row not written:', ledgerError.code || 'error');
  // Retention at the write point (THE LAW II.8): the limits read a day; the ledger keeps 30.
  try {
    await db.from(LEDGER).delete().eq('organization_id', CLEANSPACE_ORG_ID).lt('created_at', w.retentionCutoffIso);
  } catch { /* best-effort */ }

  const photoSaved = photo ? await storeVisitorPhoto({ ticket, loc, photo }, db) : null;
  // The same supervisor-first bell as any new ticket (best-effort; never fails the saved report).
  await notifyTicketRaised(ticket);
  return { outcome: 'filed', ticketId: ticket.id, photoSaved };
}

// The visitor's one photo, filed the way a ticket's photos are (the private ops-media bucket, an
// account_media row owned by the ticket) at its own scope — never a completion photo (WO-10), never
// the customer's. The PATH is built here from safe ids (the org, the code's location, random bytes),
// never from anything sent. → true when filed; false (logged) otherwise — the report stands either way.
async function storeVisitorPhoto({ ticket, loc, photo }, db) {
  const ext = VISITOR_PHOTO_EXT[photo.mimeType];
  if (!ext) return false;
  let path;
  try {
    path = `${CLEANSPACE_ORG_ID}/${requireSafeSegment(loc.siteId, 'visitor photo siteId')}/${randomBytes(10).toString('hex')}.${ext}`;
  } catch {
    return false;
  }
  if (!isValidStoragePath(path, loc.siteId)) return false;
  try {
    const up = await db.storage.from(BUCKET).upload(path, photo.bytes, { contentType: photo.mimeType, upsert: false });
    if (up.error) throw up.error;
  } catch (e) {
    console.error('[scanCodes/visitor] photo not uploaded:', e?.statusCode || e?.code || 'error');
    return false;
  }
  try {
    await confirmUpload({
      scope: VISITOR_PHOTO_SCOPE,
      clientId: loc.clientId,
      siteId: loc.siteId,
      areaId: null,
      refId: ticket.id,
      kind: 'image',
      mimeType: photo.mimeType,
      storagePath: path,
      thumbPath: null,
      sizeBytes: photo.bytes.length,
      caption: null,
      uploadedByUserId: null,
      // One photo per report: a replayed send can never file a second.
      clientMediaId: `visitor_${ticket.id}`,
    });
    return true;
  } catch (e) {
    console.error('[scanCodes/visitor] photo not recorded:', e?.code || 'error');
    try { await db.storage.from(BUCKET).remove([path]); } catch { /* best-effort */ }
    return false;
  }
}

// ── EP-415: a thumbs up or down ─────────────────────────────────────────────────────────────
// `input` is lib/areaRatings areaRatingInput's value.
// → { outcome: 'rated', vote, changed } | { outcome: 'inactive' } | { outcome: 'refused', code }
export async function rateScannedArea({ token, input, nowMs = Date.now() }, db = getSupabase()) {
  const code = await resolveScanToken(token, db);
  if (!code || !code.id) return { outcome: 'inactive' };
  const hash = deviceHash(input.deviceId);
  const live = await liveLocation(code, { narrow: true });
  if (!live) return { outcome: 'inactive' };
  const { loc, timeZone } = live;
  const day = ratingDay(nowMs, timeZone);
  const today = () => db.from(RATINGS).select('id,value')
    .eq('organization_id', CLEANSPACE_ORG_ID).eq('site_id', loc.siteId).eq('area_id', loc.areaId)
    .eq('device_hash', hash).eq('day', day).maybeSingle();
  const change = async (row) => {
    if (Number(row.value) === input.value) return { outcome: 'rated', vote: input.vote, changed: false };
    const { error } = await db.from(RATINGS).update({ value: input.value, updated_at: new Date(nowMs).toISOString() })
      .eq('organization_id', CLEANSPACE_ORG_ID).eq('id', row.id);
    if (error) throw error;
    return { outcome: 'rated', vote: input.vote, changed: true };
  };
  const { data: existing, error: readError } = await today();
  if (readError) throw readError;
  // Today's vote, changed (or the same again): one per phone per area per day, never a second row.
  if (existing) return change(existing);

  const hourAgoIso = new Date(nowMs - 3600e3).toISOString();
  const dayAgoIso = new Date(nowMs - 86400e3).toISOString();
  const count = async (narrow) => {
    const { count: n, error } = await narrow(db.from(RATINGS).select('id', { count: 'exact', head: true })
      .eq('organization_id', CLEANSPACE_ORG_ID));
    if (error) throw error;
    return exactCount(n);
  };
  const [codeHour, phoneDay] = await Promise.all([
    count((q) => q.eq('code_id', code.id).gte('created_at', hourAgoIso)),
    count((q) => q.eq('device_hash', hash).gte('created_at', dayAgoIso)),
  ]);
  const verdict = areaRatingLimitVerdict({ codeHour, phoneDay });
  if (verdict.refused) return { outcome: 'refused', code: verdict.code };

  const stamp = new Date(nowMs).toISOString();
  const { error: insertError } = await db.from(RATINGS).insert({
    organization_id: CLEANSPACE_ORG_ID,
    code_id: code.id,
    site_id: loc.siteId,
    client_id: loc.clientId,
    area_id: loc.areaId,
    value: input.value,
    device_hash: hash,
    day,
    created_at: stamp,
    updated_at: stamp,
  });
  if (insertError) {
    // Two taps raced the day's first vote: the other one is the row; this one changes it.
    if (insertError.code === '23505') {
      const { data: winner, error } = await today();
      if (error) throw error;
      if (winner) return change(winner);
    }
    throw insertError;
  }
  // Retention at the write point (THE LAW II.8).
  try {
    await db.from(RATINGS).delete().eq('organization_id', CLEANSPACE_ORG_ID).lt('day', ratingRetentionCutoffDay(nowMs, timeZone));
  } catch { /* best-effort */ }
  return { outcome: 'rated', vote: input.vote, changed: false };
}

// ── EP-416: every vote in a period, for the office's report ─────────────────────────────────
// COMPLETE (count-first, pages ordered by id; selectAll throws rather than return a short set) and
// bounded. Narrow: what the tally reads, and nothing about the phone.
// BEFORE migration 20261017110100 the table is not there, so no vote can exist yet: the read is
// empty rather than an error on a report the picker lists (the code keeps working on the old
// database shape). Only a MISSING TABLE reads as empty; any other failure still throws.
export const RATING_REPORT_COLUMNS = 'id,site_id,client_id,area_id,value,day';
const isMissingTable = (e) => e?.code === '42P01' || e?.code === 'PGRST205'
  || /relation .* does not exist|could not find the table/i.test(e?.message || '');
export async function listRatingsInPeriod({ fromDay, toDay, maxRows = RATING_READ_MAX_ROWS } = {}, db = getSupabase()) {
  const base = (cols, opts) => db.from(RATINGS).select(cols, opts)
    .eq('organization_id', CLEANSPACE_ORG_ID).gte('day', fromDay).lte('day', toDay);
  let rows;
  try {
    rows = await selectAll({
      count: async () => {
        const { count, error } = await base('id', { count: 'exact', head: true });
        if (error) throw error;
        return exactCount(count);
      },
      page: async (from, to) => {
        const { data, error } = await base(RATING_REPORT_COLUMNS).order('id', { ascending: true }).range(from, to);
        if (error) throw error;
        return data || [];
      },
      maxRows,
    });
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    console.warn('[visitor-ratings] no area_scan_ratings table yet (migration 20261017110100 unapplied): an empty report');
    return [];
  }
  return rows.filter((r) => voteOfValue(r.value));
}
