// Service-role data layer for the QR codes (QR-1..QR-6, HUB-15). One table,
// `area_scan_codes` (migration 20261004110000: RLS on, no policies, anon/authenticated
// revoked, service_role narrowed): one row per code ever minted, ONE live (unrevoked) code
// per (location, area) by a partial unique index. Nothing here is in the shared record:
// 750 buildings × several areas is a table, not a slice of org_state.
//
// 🔴 THE PUBLIC READ NEVER PULLS THE SHARED RECORD. An anonymous scan reads ONE location
// out of it through `area_scan_site` (migration 20261004110100, extended by 20261017100000) —
// its name, its customer's name, id and status, its areas' ids and labels, the org's zone and the
// company's phone, nothing else — so a stranger's phone costs a few kilobytes, not the whole
// ~1 MB document, and the location's other fields (access notes, codes, instructions) never even
// reach this process.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { isValidStoragePath } from '../storagePaths.js';
import { selectAll, exactCount } from '../pagedSelect.js';
import { areaStatusForSite } from '../qc/store.js';
import { getJobsAtSite } from '../jobsTable.js';
import { mintScanToken } from './token.js';
import {
  isScanToken, scanShowsPhoto, scanTimeZone, scanNextCleanDay, scanLastInspectionDay,
  SCAN_NEXT_CLEAN_DAYS, SCAN_INSPECTION_STATUSES,
} from '../../../src/lib/areaScan.js';
import { dayKey, addDaysKey, startOfDayKey } from '../../../src/lib/dates.js';
import { planScanCodes, scanAreasOf, scanLocationOf } from '../../../src/lib/scanCodes.js';

const TABLE = 'area_scan_codes';
const BUCKET = 'ops-media';
export const SCAN_CODE_COLUMNS = 'id,site_id,area_id,token,created_at,created_by,revoked_at,revoked_by';
// A batch insert is all-or-nothing, so a race with another office tab (23505 on the live
// index) is answered by re-reading and minting what is still missing. Three rounds is more
// than two tabs can lose.
const MINT_ROUNDS = 3;
// The org-wide mint (the all-buildings links, EP-412) inserts at most this many rows a
// statement: 750 buildings × 5 areas is a handful of statements, each a small body.
export const SCAN_MINT_BATCH = 500;
// A photo is served through the function, whose response is capped at 4.5 MB. The phone's
// own ~480 px thumbnail is what is sent; an original only when there is no thumbnail and it
// is small enough to fit.
export const SCAN_PHOTO_MAX_BYTES = Math.floor(3.5 * 1024 * 1024);
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const nowIso = () => new Date().toISOString();

// ONE location, as the scan needs it — `{ id, name, clientName, clientId, clientStatusOverride,
// cleaningAreas, timeZone, companyPhone }`, or null when the shared record has no such location.
//
// `clientId` / `clientStatusOverride` (the customer's `statusOverride`, what §163's
// isArchivedCustomer reads — QR-27) and `companyPhone` (org_state.company.phone — QR-31) arrive
// with migration 20261017100000. Until it is applied the function answers its older shape, and a
// missing key reads as "no customer status" (active, as every code was before) and "no phone" (no
// urgent line): the location's code answers exactly as it did.
const str = (v) => (typeof v === 'string' && v ? v : null);
export async function readScanSite(siteId, db = getSupabase()) {
  const { data, error } = await db.rpc('area_scan_site', { p_org: CLEANSPACE_ORG_ID, p_site_id: siteId });
  if (error) throw error;
  if (!data || typeof data !== 'object') return null;
  return {
    id: siteId,
    name: typeof data.siteName === 'string' ? data.siteName : null,
    clientName: typeof data.clientName === 'string' ? data.clientName : null,
    clientId: str(data.clientId),
    clientStatusOverride: str(data.clientStatusOverride),
    cleaningAreas: Array.isArray(data.areas) ? data.areas : [],
    timeZone: typeof data.timeZone === 'string' ? data.timeZone : null,
    companyPhone: str(data.companyPhone),
  };
}

// The location as the ONE location rule reads it (src/lib/scanCodes scanLocationOf): the site and
// its customer, rebuilt from what the RPC returned — so the public read asks exactly the question the
// staff and the hub resolvers ask (a removed area, an archived customer: QR-27).
function scanLocationOfSite(code, site) {
  return scanLocationOf({
    code,
    sites: [{ id: site.id, name: site.name, clientId: site.clientId, cleaningAreas: site.cleaningAreas }],
    clients: site.clientId ? [{ id: site.clientId, name: site.clientName, statusOverride: site.clientStatusOverride }] : [],
  });
}

async function liveCodes(siteId, db) {
  const { data, error } = await db.from(TABLE).select(SCAN_CODE_COLUMNS)
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .eq('site_id', siteId)
    .is('revoked_at', null);
  if (error) throw error;
  return data || [];
}

const newRow = (siteId, areaId, by) => ({
  organization_id: CLEANSPACE_ORG_ID, site_id: siteId, area_id: areaId, token: mintScanToken(), created_by: by || null,
});

// One live code for EVERY area of the location, minting only what is missing — opening the
// codes screen twice mints nothing the second time. → [{ area, code }] in the office's order.
export async function ensureCodesForSite({ site, createdBy = null }, db = getSupabase()) {
  const areas = scanAreasOf(site);
  if (!areas.length) return [];
  for (let round = 0; round < MINT_ROUNDS; round += 1) {
    const { live, missing } = planScanCodes({ areas, codes: await liveCodes(site.id, db) });
    if (!missing.length) return areas.map((area) => ({ area, code: live.get(area.id) }));
    const { error } = await db.from(TABLE).insert(missing.map((areaId) => newRow(site.id, areaId, createdBy)));
    if (error && error.code !== '23505') throw error;
  }
  const { live, missing } = planScanCodes({ areas, codes: await liveCodes(site.id, db) });
  if (missing.length) throw new Error(`scan codes: ${missing.length} area(s) still without a code after ${MINT_ROUNDS} rounds`);
  return areas.map((area) => ({ area, code: live.get(area.id) }));
}

// EVERY live code of the org — a COMPLETE read (count-first, pages ordered by id, bounded
// concurrency, per-page retry; _lib/pagedSelect selectAll throws rather than return a short
// set), for the all-buildings links (EP-412). Never a capped list: a code left off would be a
// label left unprinted.
export async function listLiveCodes(db = getSupabase()) {
  return selectAll({
    count: async () => {
      const { count, error } = await db.from(TABLE).select('id', { count: 'exact', head: true })
        .eq('organization_id', CLEANSPACE_ORG_ID)
        .is('revoked_at', null);
      if (error) throw error;
      return exactCount(count);
    },
    page: async (from, to) => {
      const { data, error } = await db.from(TABLE).select(SCAN_CODE_COLUMNS)
        .eq('organization_id', CLEANSPACE_ORG_ID)
        .is('revoked_at', null)
        .order('id', { ascending: true })
        .range(from, to);
      if (error) throw error;
      return data || [];
    },
  });
}

// ensureCodesForSite for MANY locations at once (the all-buildings links, EP-412): one live
// code for every area of every location given, minting only what is missing, in batches of
// SCAN_MINT_BATCH — idempotent, so asking twice mints nothing the second time. A batch the
// live partial unique index refuses (23505: another office tab minted one of its areas first)
// mints nothing; the next round re-reads and mints what is still missing.
// → { live: Map(siteId → Map(areaId → code row)), minted }
export async function ensureCodesForSites({ sites = [], createdBy = null } = {}, db = getSupabase()) {
  const wanted = (Array.isArray(sites) ? sites : [])
    .filter((s) => s && s.id)
    .map((s) => ({ siteId: s.id, areas: scanAreasOf(s) }))
    .filter((s) => s.areas.length);
  let minted = 0;
  for (let round = 0; ; round += 1) {
    const bySite = new Map();
    if (wanted.length) {
      for (const c of await listLiveCodes(db)) {
        if (!bySite.has(c.site_id)) bySite.set(c.site_id, []);
        bySite.get(c.site_id).push(c);
      }
    }
    const live = new Map();
    const missing = [];
    for (const { siteId, areas } of wanted) {
      const plan = planScanCodes({ areas, codes: bySite.get(siteId) || [] });
      live.set(siteId, plan.live);
      for (const areaId of plan.missing) missing.push({ siteId, areaId });
    }
    if (!missing.length) return { live, minted };
    if (round >= MINT_ROUNDS) throw new Error(`scan codes: ${missing.length} area(s) still without a code after ${MINT_ROUNDS} rounds`);
    for (let i = 0; i < missing.length; i += SCAN_MINT_BATCH) {
      const batch = missing.slice(i, i + SCAN_MINT_BATCH);
      const { error } = await db.from(TABLE).insert(batch.map((m) => newRow(m.siteId, m.areaId, createdBy)));
      if (error && error.code !== '23505') throw error;
      if (!error) minted += batch.length;
    }
  }
}

// REPLACE a stolen or moved label: revoke the area's live code (the old label answers "no
// longer active" from this moment) and mint a new one. `{ notFound: true }` when the area is
// not on the location any more. A concurrent mint that wins the insert stands.
export async function replaceCode({ site, areaId, by = null }, db = getSupabase()) {
  const area = scanAreasOf(site).find((a) => a.id === areaId);
  if (!area) return { notFound: true };
  const { error: revokeErr } = await db.from(TABLE)
    .update({ revoked_at: nowIso(), revoked_by: by || null })
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .eq('site_id', site.id)
    .eq('area_id', areaId)
    .is('revoked_at', null);
  if (revokeErr) throw revokeErr;
  const { data, error } = await db.from(TABLE).insert(newRow(site.id, areaId, by)).select(SCAN_CODE_COLUMNS).single();
  if (error) {
    if (error.code === '23505') {
      const winner = (await liveCodes(site.id, db)).find((c) => c.area_id === areaId);
      if (winner) return { area, code: winner };
    }
    throw error;
  }
  return { area, code: data };
}

// A token → the location and area it names, or null (unknown, malformed or replaced). `id` is the
// code's own row id — the visitor's report and rating ledgers name the code that was scanned.
export async function resolveScanToken(token, db = getSupabase()) {
  if (!isScanToken(token)) return null;
  const { data, error } = await db.from(TABLE).select('id,site_id,area_id')
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .eq('token', token)
    .is('revoked_at', null)
    .maybeSingle();
  if (error) throw error;
  return data ? { siteId: data.site_id, areaId: data.area_id, id: data.id } : null;
}

// THE public read: a token → { siteName, clientName, timeZone, row, nextCleanOn, lastInspectionOn,
// phone } where `row` is the ONE area's `siteAreaStatus` row from the same function the office's
// EP-200 and the client hub read (api/_lib/qc/store.areaStatusForSite) — or null when the code does
// not resolve: not a token, never minted, replaced, its area or location since removed, or its
// customer archived (QR-27; the one location rule, scanLocationOf). Signs nothing: the public
// answer carries no URL.
//
// The next clean (QR-28) and the last inspection (QR-15) are DISPLAY EXTRAS read beside the area:
// a read that fails is logged and left out (no line on the page), never a scan page that will not
// open — the last clean is the answer, these only add to it. `extras: false` (the photo route)
// skips them.
export async function scanAreaStatus(token, db = getSupabase(), { nowMs = Date.now(), extras = true } = {}) {
  const code = await resolveScanToken(token, db);
  if (!code) return null;
  const site = await readScanSite(code.siteId, db);
  if (!site) return null;
  const loc = scanLocationOfSite(code, site);
  if (!loc) return null;
  const area = { id: loc.areaId, label: loc.area };
  const [status, cleans, lastInspectionOn] = await Promise.all([
    areaStatusForSite({
      siteId: site.id,
      site: { id: site.id, name: site.name, cleaningAreas: [area] },
      sign: false,
    }, db),
    extras ? scanCleansAhead(site, { nowMs }).catch((e) => extraFailed('next clean', e)) : null,
    extras ? scanLastInspectionAt(site, db).catch((e) => extraFailed('last inspection', e)) : null,
  ]);
  const row = (status?.areas || []).find((a) => a.areaId === area.id) || { areaId: area.id, label: area.label, items: [], photo: null };
  // The visit that already did THIS area is not its next clean (scanNextCleanDay's lastCleanedAt).
  const nextCleanOn = cleans
    ? scanNextCleanDay({ jobs: cleans, siteId: site.id, timeZone: site.timeZone, nowMs, lastCleanedAt: row.lastCleanedAt ?? null })
    : null;
  return {
    siteName: site.name, clientName: site.clientName, timeZone: site.timeZone, row,
    nextCleanOn, lastInspectionOn, phone: site.companyPhone,
  };
}

function extraFailed(what, e) {
  console.error('[scanCodes] public read:', what, 'unreadable:', e?.code || e?.name || 'error');
  return null;
}

// QR-28: the location's cleans the next clean is chosen from — ONE bounded read of its cleans that
// are not cancelled, from the start of today in the org's zone to SCAN_NEXT_CLEAN_DAYS ahead
// (jobsTable getJobsAtSite: the indexed site_id and start_at, paged by id). The choice is
// src/lib/areaScan scanNextCleanDay's, made with the AREA's own last clean once the area status is
// known (the read runs beside it): the public read above and the hub's area page (EP-421).
export async function scanCleansAhead(site, { nowMs = Date.now() } = {}) {
  if (!site?.id) return [];
  const zone = scanTimeZone(site.timeZone);
  const today = dayKey(nowMs, zone);
  return getJobsAtSite(site.id, {
    startFrom: startOfDayKey(today, zone).toISOString(),
    startTo: new Date(startOfDayKey(addDaysKey(today, SCAN_NEXT_CLEAN_DAYS + 1), zone).getTime() - 1).toISOString(),
  });
}

// QR-15 (his note): the day the location was last inspected. ONE row: the newest submitted
// inspection by `site_id` (the inspection_records_site_idx order), never a draft, and only its
// time — no score, result or inspector is read.
export async function scanLastInspectionAt(site, db = getSupabase()) {
  if (!site?.id) return null;
  const { data, error } = await db.from('inspection_records').select('status,performed_at')
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .eq('site_id', site.id)
    .in('status', SCAN_INSPECTION_STATUSES)
    .not('performed_at', 'is', null)
    .order('performed_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return scanLastInspectionDay(data || [], site.timeZone);
}

// The area's newest checklist photo as BYTES — the scan page's only way to it, so no storage
// path ever reaches a stranger. → { bytes, contentType } | { none: true } | { inactive: true }.
// The stored path is re-validated before Storage is asked for it (a tampered row must not
// walk the multi-tenant bucket: _lib/storagePaths.js).
export async function scanPhoto(token, db = getSupabase()) {
  const st = await scanAreaStatus(token, db, { extras: false });
  if (!st) return { inactive: true };
  // The same rule the answer uses: no recorded clean of the area, no picture (lib/areaScan).
  if (!scanShowsPhoto(st.row)) return { none: true };
  const photoId = st.row?.photo?.id;
  if (!photoId) return { none: true };
  const { data: m, error } = await db.from('account_media')
    .select('kind,mime_type,storage_path,thumb_path,size_bytes')
    .eq('organization_id', CLEANSPACE_ORG_ID)
    .eq('id', photoId)
    .eq('scope', 'checklist')
    .maybeSingle();
  if (error) throw error;
  if (!m || m.kind !== 'image') return { none: true };
  let path = null;
  let contentType = null;
  if (m.thumb_path) { path = m.thumb_path; contentType = 'image/jpeg'; }
  else if (Number(m.size_bytes) > 0 && Number(m.size_bytes) <= SCAN_PHOTO_MAX_BYTES && PHOTO_TYPES.has(m.mime_type)) {
    path = m.storage_path;
    contentType = m.mime_type;
  }
  if (!path || !isValidStoragePath(path)) return { none: true };
  const { data: blob, error: dlErr } = await db.storage.from(BUCKET).download(path);
  if (dlErr || !blob) return { none: true };
  const bytes = Buffer.from(await blob.arrayBuffer());
  if (bytes.length > SCAN_PHOTO_MAX_BYTES) return { none: true };
  return { bytes, contentType };
}
