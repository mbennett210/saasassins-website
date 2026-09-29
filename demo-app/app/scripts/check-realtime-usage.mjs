// Read the live Supabase usage meters (Realtime messages above all) via the
// Management API — the Increment 0.1 gate in REMEDIATION_PLAN.md.
//
// Increment 0.1 asks two questions before any Broadcast dual-run is allowed to start,
// because a dual-run temporarily DOUBLES a channel's billed traffic:
//   1. Did the shipped write-frequency cuts pull the meter under the 5M quota?
//   2. Is there enough headroom left to absorb the dual-run bump?
//
// Reads SUPABASE_ACCESS_TOKEN / SUPABASE_TOKEN from app/.env.local. NEVER prints it.
//   node scripts/check-realtime-usage.mjs
import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_TOKEN;
if (!TOKEN) { console.error('Missing SUPABASE_ACCESS_TOKEN / SUPABASE_TOKEN in app/.env.local'); process.exit(1); }

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const REF = (url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/i) || [])[1];
if (!REF) { console.error('Could not derive project ref from SUPABASE_URL'); process.exit(1); }

const api = async (path) => {
  const res = await fetch(`https://api.supabase.com${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, json, text: text.slice(0, 300) };
};

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n));

async function main() {
  console.log(`\nProject ref: ${REF}\n`);

  // Which org owns this project (usage is billed per-org).
  const orgs = await api('/v1/organizations');
  let slug = null;
  if (orgs.ok && Array.isArray(orgs.json)) {
    for (const o of orgs.json) {
      const projects = await api(`/v1/projects`);
      if (projects.ok && Array.isArray(projects.json)) {
        const mine = projects.json.find((p) => p.id === REF || p.ref === REF);
        if (mine) { slug = mine.organization_id || o.id || o.slug; break; }
      }
    }
  }
  console.log(`Organization: ${slug || '(not resolved)'}\n`);

  // Try the documented usage surfaces, newest first. Endpoints have moved between
  // API versions, so probe several and report whichever answers.
  const candidates = [
    slug ? `/v1/organizations/${slug}/usage` : null,
    slug ? `/v1/organizations/${slug}/daily-stats` : null,
    `/v1/projects/${REF}/usage`,
    `/v1/projects/${REF}/billing/usage`,
  ].filter(Boolean);

  let found = false;
  for (const path of candidates) {
    const r = await api(path);
    console.log(`GET ${path} → ${r.status}`);
    if (!r.ok || !r.json) continue;
    found = true;
    const items = Array.isArray(r.json) ? r.json : (r.json.usages || r.json.data || []);
    const list = Array.isArray(items) ? items : [];
    const interesting = list.filter((u) => /realtime|egress|db_size|monthly_active/i.test(u.metric || u.name || ''));
    for (const u of (interesting.length ? interesting : list)) {
      const metric = u.metric || u.name;
      const used = u.usage ?? u.value ?? u.used;
      const limit = u.pricing_free_units ?? u.limit ?? u.quota;
      const pct = (typeof used === 'number' && typeof limit === 'number' && limit > 0)
        ? ` (${Math.round((used / limit) * 1000) / 10}%)` : '';
      console.log(`   ${metric}: ${fmt(used)}${limit ? ` / ${fmt(limit)}` : ''}${pct}`);
    }
    console.log('');
    break;
  }
  if (!found) {
    console.log('\nNo usage endpoint answered. The meter is still readable in the dashboard:');
    console.log(`  https://supabase.com/dashboard/project/${REF}/settings/billing/usage\n`);
  }
}

main().catch((e) => { console.error('FAILED:', e?.message || e); process.exit(1); });
