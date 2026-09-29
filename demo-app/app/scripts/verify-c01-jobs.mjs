// READ-ONLY verification that the C01 fix works: the server-side jobs-table helpers
// resolve real jobs (they previously read the empty state.jobs → clock-in 404).
import { readFileSync } from 'node:fs';
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const { createClient } = await import('@supabase/supabase-js');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
// grab a real job id + a site id + a crew id from the live table to test against
const { data: sample } = await db.from('jobs').select('id, site_id, data').not('site_id', 'is', null).limit(1);
const jobId = sample?.[0]?.id;
const siteId = sample?.[0]?.site_id;
const someCrew = (sample?.[0]?.data?.crewIds || [])[0] || null;

const { getJobById, getJobsAtSite, getCrewJobs, getJobsInWindow } = await import('../api/_lib/jobsTable.js');

const j = await getJobById(jobId);
console.log('getJobById(', jobId, ') ->', j ? `FOUND id=${j.id} status=${j.status} site=${j.siteId||'-'}` : 'NULL (BROKEN)');
console.log('  matches requested id:', j?.id === jobId);

const siteJobs = await getJobsAtSite(siteId);
console.log('getJobsAtSite(', siteId, ') ->', siteJobs.length, 'non-cancelled jobs');

const win = await getJobsInWindow({ backDays: 7, forwardDays: 45 });
console.log('getJobsInWindow(-7/+45d) ->', win.length, 'jobs (reminders scan set)');

if (someCrew) {
  const crewJobs = await getCrewJobs(someCrew);
  console.log('getCrewJobs(', someCrew, ') ->', crewJobs.length, 'jobs; all include the crew:', crewJobs.every((x) => (x.crewIds || []).includes(someCrew)));
} else {
  console.log('getCrewJobs: no crew id in sample to test');
}
console.log('\nC01 result:', (j && j.id === jobId) ? 'PASS — server resolves jobs from public.jobs (clock-in no longer 404s)' : 'FAIL');
