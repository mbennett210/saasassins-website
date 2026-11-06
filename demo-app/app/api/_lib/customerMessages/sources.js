// WHAT THE CUSTOMER-MESSAGE RUN READS BESIDES THE SHARED RECORD AND THE JOBS WINDOW
// (api/reminders/run.js). Each reader is asked only when a message that needs it is switched on,
// reads a narrow, time-bounded slice through an index, and FAILS CLOSED: a read that errors
// answers null, and the run then has nothing of that kind due (never "nothing was there before,
// so everything is new").
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { getClientUserById } from '../clientHub/store.js';
import { clientUserHasAccess } from '../../../src/lib/clientHub.js';
import { hubEmailEnabled } from '../../../src/lib/hubEmailPrefs.js';

const ORG = CLEANSPACE_ORG_ID;
const JOBS_ORG = process.env.CLEANSPACE_ORG_ID || CLEANSPACE_ORG_ID;
const PAGE = 1000;
const MAX_PAGES = 10;

async function pages(build, what) {
  const out = [];
  for (let p = 0; p < MAX_PAGES; p += 1) {
    // paging-lint:allow — every builder handed in orders by its sort column, then id (below)
    const { data, error } = await build().range(p * PAGE, p * PAGE + PAGE - 1);
    if (error) { console.error(`[reminders] ${what} read failed:`, error.message); return null; }
    out.push(...(data || []));
    if (!data || data.length < PAGE) return out;
  }
  console.error(`[reminders] ${what} read stopped at ${MAX_PAGES * PAGE} rows`);
  return out;
}

// The recurring schedules whose FIRST visit (the master, the row carrying `recurrence`) started
// between `fromIso` and `toIso`: the upsell's "service started N days ago". `createdAt` is when the
// schedule was entered (the walker sends no upsell for one entered on or after its upsell day).
export async function readSeriesStarts(fromIso, toIso) {
  const rows = await pages(() => getSupabase().from('jobs')
    .select('id, client_id, site_id, series_id, start_at, recurrence:data->recurrence, created_at:data->createdAt')
    .eq('organization_id', JOBS_ORG).not('series_id', 'is', null)
    .gte('start_at', fromIso).lte('start_at', toIso)
    .order('start_at', { ascending: true }).order('id', { ascending: true }), 'series starts');
  if (!rows) return null;
  return rows.filter((r) => r.recurrence).map((r) => ({ jobId: r.id, clientId: r.client_id, siteId: r.site_id, seriesId: r.series_id, startAt: r.start_at, createdAt: r.created_at || null }));
}

// The complaints logged OR resolved since `sinceIso` (two indexed reads, merged by id).
export async function readComplaints(sinceIso) {
  const cols = 'id, client_id, site_id, type, origin, status, created_at, resolved_at, raised_by_client_user_id';
  const logged = await pages(() => getSupabase().from('problem_reports').select(cols)
    .eq('organization_id', ORG).eq('type', 'complaint').gte('created_at', sinceIso)
    .order('created_at', { ascending: true }).order('id', { ascending: true }), 'complaints');
  const resolved = await pages(() => getSupabase().from('problem_reports').select(cols)
    .eq('organization_id', ORG).eq('type', 'complaint').eq('status', 'resolved').gte('resolved_at', sinceIso)
    .order('resolved_at', { ascending: true }).order('id', { ascending: true }), 'resolved complaints');
  if (!logged || !resolved) return null;
  const byId = new Map([...logged, ...resolved].map((r) => [r.id, r]));
  return [...byId.values()];
}

// For each resolved complaint raised from the customer hub: the login that raised it, its address,
// and whether it gets the hub's request emails (HUB-11 told it of the resolution then).
export async function readRaisers(complaints) {
  const out = new Map();
  for (const p of complaints || []) {
    if (p.origin !== 'portal' || !p.raised_by_client_user_id || p.status !== 'resolved') continue;
    try {
      const u = await getClientUserById(p.raised_by_client_user_id);
      if (u) out.set(p.id, { email: u.email || '', receives: !!u.email && clientUserHasAccess(u.status) && hubEmailEnabled(u.email_prefs, 'requests') });
    } catch { /* unreadable: the resolution email goes (better twice than never) */ }
  }
  return out;
}
