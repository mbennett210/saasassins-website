// "Report an issue" proxy — pure-shape semantics + source invariants.
//
//   node scripts/test-support-report.mjs
//
// Behavior half imports the PURE core (api/_lib/support/shape.js — no IO).
// Wiring half reads route/component SOURCE as text (never imports it — the
// route files import authz/orgState and this suite must stay offline).
// The invariants pinned here are the ones that rot silently:
//   • flat single-segment routes (a [...path] catch-all 404s in prod without a
//     vercel.json rewrite — bit the CRM)
//   • identity from the JWT, never the body
//   • the portal token never reaches a log line or the client bundle
import { readFileSync, readdirSync } from 'node:fs';
import {
  clampPriority, sanitizeAttachments, buildContext, mapCrmFailure,
  ATTACHMENT_MAX_COUNT, SUPPORT_PRIORITIES,
} from '../api/_lib/support/shape.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ── clampPriority — the public-path vocabulary ────────────────────────────
ok('normal passes', clampPriority('normal') === 'normal');
ok('high passes', clampPriority('high') === 'high');
ok('low passes', clampPriority('low') === 'low');
ok("urgent clamps to high (CRM public-path rule, mirrored)", clampPriority('urgent') === 'high');
ok('junk falls to normal', clampPriority('asap!!') === 'normal');
ok('undefined falls to normal', clampPriority(undefined) === 'normal');
ok('null falls to normal', clampPriority(null) === 'normal');
ok('vocabulary is exactly normal/high/low', SUPPORT_PRIORITIES.join(',') === 'normal,high,low');

// ── sanitizeAttachments — untrusted metadata rows ─────────────────────────
const att = (i) => ({ id: `a${i}`, path: `p/${i}`, name: `f${i}.png`, mimeType: 'image/png', sizeBytes: 10 });
ok('null input → []', Array.isArray(sanitizeAttachments(null)) && sanitizeAttachments(null).length === 0);
ok('non-array input → []', sanitizeAttachments('x').length === 0);
ok(`caps at ${ATTACHMENT_MAX_COUNT}`, sanitizeAttachments([1, 2, 3, 4, 5, 6, 7, 8].map(att)).length === ATTACHMENT_MAX_COUNT);
ok('row without path is dropped', sanitizeAttachments([{ id: 'a', name: 'n' }]).length === 0);
ok('row without id is dropped', sanitizeAttachments([{ path: 'p', name: 'n' }]).length === 0);
ok('row without name is dropped', sanitizeAttachments([{ id: 'a', path: 'p' }]).length === 0);
const longName = sanitizeAttachments([{ id: 'a', path: 'p', name: 'x'.repeat(300) }])[0];
ok('name sliced to 200', longName.name.length === 200);
ok('sizeBytes coerced to a number', sanitizeAttachments([{ ...att(1), sizeBytes: 'zzz' }])[0].sizeBytes === 0);
ok('mimeType defaults to empty string', sanitizeAttachments([{ id: 'a', path: 'p', name: 'n' }])[0].mimeType === '');

// ── buildContext — whitelisted, server-authored identity ──────────────────
const me = { name: 'Kyle Boyden', email: 'kyle@example.com' };
const ctx = buildContext({
  source: 'portal-spoof',
  route: '/schedule?view=week',
  appVersion: 'cleanspace-app@abc1234',
  userAgent: 'UA',
  viewport: '390x844',
  user: 'Forged <evil@example.com>',
  consoleErrors: ['boom'],
  extraKey: 'dropped',
}, me);
ok('source is forced to in-app', ctx.source === 'in-app');
ok('user is server-authored, never the body value', ctx.user === 'Kyle Boyden <kyle@example.com>');
ok('unknown keys are dropped', !('extraKey' in ctx));
ok('route rides through', ctx.route === '/schedule?view=week');
ok('appVersion rides through', ctx.appVersion === 'cleanspace-app@abc1234');
ok('userAgent rides through', ctx.userAgent === 'UA');
ok('viewport rides through', ctx.viewport === '390x844');
ok('consoleErrors ride through', ctx.consoleErrors.length === 1 && ctx.consoleErrors[0] === 'boom');

ok('email-only identity → bare email', buildContext({}, { email: 'a@b.c' }).user === 'a@b.c');
ok('no identity → user key absent', !('user' in buildContext({}, {})));
ok('null client context → still stamps source', buildContext(null, me).source === 'in-app');
ok('empty route is dropped, not sent as blank', !('route' in buildContext({ route: '   ' }, me)));

const many = buildContext({ consoleErrors: Array.from({ length: 15 }, (_, i) => `e${i}`) }, me);
ok('consoleErrors keep the LAST 10', many.consoleErrors.length === 10 && many.consoleErrors[0] === 'e5' && many.consoleErrors[9] === 'e14');
const fat = buildContext({ consoleErrors: ['x'.repeat(5000)] }, me);
ok('each console error truncated to 2000', fat.consoleErrors[0].length === 2000);
ok('non-string console entries dropped', buildContext({ consoleErrors: [1, {}, 'real'] }, me).consoleErrors.length === 1);
ok('non-array consoleErrors → key absent', !('consoleErrors' in buildContext({ consoleErrors: 'boom' }, me)));
ok('empty consoleErrors → key absent', !('consoleErrors' in buildContext({ consoleErrors: [] }, me)));
const longRoute = buildContext({ route: `/x?${'q'.repeat(900)}` }, me);
ok('route sliced to 500', longRoute.route.length === 500);

// ── buildContext — organic diagnostics packet (env + server-authored identity) ──
const idArgs = { name: 'Kyle Boyden', email: 'kyle@example.com', userId: 'u_1', role: 'owner', roleSource: 'claim', identitySource: 'roster' };
const rich = buildContext({
  appBuild: 1234,
  clientTime: '2026-08-04T12:00:00.000Z',
  timezone: 'America/Los_Angeles',
  locale: 'en-US',
  dpr: 2,
  colorScheme: 'dark',
  online: false,
  syncStatus: 'offline',
  tabId: 't_abc',
  tabAgeSec: 3600.7,
}, idArgs);
ok('appBuild rides as a number', rich.appBuild === 1234);
ok('clientTime rides through', rich.clientTime === '2026-08-04T12:00:00.000Z');
ok('timezone rides through', rich.timezone === 'America/Los_Angeles');
ok('locale rides through', rich.locale === 'en-US');
ok('dpr rides as a number', rich.dpr === 2);
ok('colorScheme rides through', rich.colorScheme === 'dark');
ok('online:false is preserved (a real signal, not dropped as falsy)', rich.online === false);
ok('syncStatus rides through', rich.syncStatus === 'offline');
ok('tabId rides through', rich.tabId === 't_abc');
ok('tabAgeSec coerced + rounded', rich.tabAgeSec === 3601);
ok('userId is server-authored', rich.userId === 'u_1');
ok('role is server-authored', rich.role === 'owner');
ok('roleSource is server-authored', rich.roleSource === 'claim');
ok('identitySource is server-authored', rich.identitySource === 'roster');

// Identity + provenance NEVER from the body — a reporter can't self-declare a role.
const idSpoof = buildContext({ role: 'owner', userId: 'forged', roleSource: 'claim', identitySource: 'roster' }, { email: 'a@b.c' });
ok('body-supplied role is ignored', !('role' in idSpoof));
ok('body-supplied userId is ignored', !('userId' in idSpoof));
ok('body-supplied roleSource is ignored', !('roleSource' in idSpoof));
ok('body-supplied identitySource is ignored', !('identitySource' in idSpoof));

// Typing + caps on the new fields.
ok('non-numeric appBuild dropped', !('appBuild' in buildContext({ appBuild: 'x' }, me)));
ok('null appBuild not coerced to 0', !('appBuild' in buildContext({ appBuild: null }, me)));
ok('non-boolean online dropped', !('online' in buildContext({ online: 'yes' }, me)));
ok('timezone capped to 60', buildContext({ timezone: 'z'.repeat(200) }, me).timezone.length === 60);
ok('clientTime capped to 40', buildContext({ clientTime: 'z'.repeat(200) }, me).clientTime.length === 40);
ok('tabId capped to 40', buildContext({ tabId: 'z'.repeat(200) }, me).tabId.length === 40);
ok('negative tabAgeSec floored at 0', buildContext({ tabAgeSec: -5 }, me).tabAgeSec === 0);
ok('unknown env key still dropped', !('extraKey' in buildContext({ extraKey: 'x', online: true }, me)));

// deeper sync internals — org_state CAS version, pending/dirty, offline queue depths
const syncCtx = buildContext({ orgStateVersion: 70471, pendingWrites: 3, dirty: true, mediaQueueDepth: 12, checklistQueueDepth: 0 }, me);
ok('orgStateVersion rides as a number', syncCtx.orgStateVersion === 70471);
ok('pendingWrites rides as a number', syncCtx.pendingWrites === 3);
ok('dirty rides as a boolean', syncCtx.dirty === true);
ok('mediaQueueDepth rides as a number', syncCtx.mediaQueueDepth === 12);
ok('checklistQueueDepth:0 preserved (a real "none queued" signal)', syncCtx.checklistQueueDepth === 0);
ok('pendingWrites:0 preserved (not dropped as falsy)', buildContext({ pendingWrites: 0 }, me).pendingWrites === 0);
ok('dirty:false preserved', buildContext({ dirty: false }, me).dirty === false);
ok('non-numeric orgStateVersion dropped', !('orgStateVersion' in buildContext({ orgStateVersion: 'x' }, me)));

// ── mapCrmFailure — token state never leaks to the reporter ───────────────
const f404 = mapCrmFailure(404, 'This support link is not valid.');
ok('404 (bad token) → 503, not 404', f404.status === 503);
ok("404 message says 'unavailable', never mentions the link/token", /unavailable/i.test(f404.error) && !/link|token/i.test(f404.error));
ok('410 (revoked token) → 503', mapCrmFailure(410, 'turned off').status === 503);
const f400 = mapCrmFailure(400, 'Please give the issue a short title.');
ok('400 with a message relays it', f400.status === 400 && f400.error === 'Please give the issue a short title.');
ok('400 without a message degrades to 502', mapCrmFailure(400, null).status === 502);
ok('500 → 502', mapCrmFailure(500, 'boom').status === 502);
ok('relayed 400 message is capped', mapCrmFailure(400, 'x'.repeat(900)).error.length === 300);

// ── source invariants (read as text, never imported) ──────────────────────
const report = read('api/support/report.js');
const upload = read('api/support/upload.js');
const supportDir = readdirSync(new URL('../api/support/', import.meta.url));

ok('api/support/ holds exactly the two flat routes', supportDir.sort().join(',') === 'report.js,upload.js');
ok('no catch-all in api/support (would 404 in prod without a rewrite)', !supportDir.some((f) => f.includes('[')));
const vercel = JSON.parse(read('vercel.json'));
ok('vercel.json has NO /api/support rewrite (flat routes need none)', !(vercel.rewrites || []).some((r) => String(r.source).includes('/api/support')));

for (const [label, src] of [['report', report], ['upload', upload]]) {
  ok(`${label}: gated by requireAuthority`, src.includes('requireAuthority(req, res)'));
  ok(`${label}: rate limited`, src.includes('allow(req, res, {'));
  ok(`${label}: POST-only`, src.includes("req.method !== 'POST'"));
  ok(`${label}: reads SUPPORT_PORTAL_TOKEN from env`, src.includes('process.env.SUPPORT_PORTAL_TOKEN'));
  ok(`${label}: reads SUPPORT_API_BASE from env`, src.includes('process.env.SUPPORT_API_BASE'));
  ok(`${label}: token is URL-encoded into the fetch`, src.includes('encodeURIComponent(token)'));
  ok(`${label}: no console.log at all`, !src.includes('console.log'));
  // A console.* call that interpolates anything is one refactor away from
  // printing the token URL. Every log line must be a bare literal.
  const logCalls = src.match(/console\.\w+\([^)]*\)/g) || [];
  ok(`${label}: every log line is a literal (no interpolation near the token)`, logCalls.every((c) => !c.includes('${') && !/\b(token|base|url|signedUrl)\b/.test(c.replace(/'[^']*'/g, ''))));
}
ok('report: identity comes from the JWT, never the body', !/body\.submitter/.test(report) && report.includes('a.email'));
ok('report: clamps priority through the pure core', report.includes('clampPriority(body.priority)'));
ok('report: context is rebuilt server-side', report.includes('buildContext(body.context'));
ok('report: identity provenance is authored server-side into context', report.includes('identitySource') && report.includes('a.roleSource'));

// ── client bundle never sees the token; wiring is mounted ─────────────────
const supportApi = read('src/lib/supportApi.js');
ok('client lib never references the portal token', !/SUPPORT_PORTAL_TOKEN|PORTAL_TOKEN/.test(supportApi));
ok('client lib talks only to the same-origin proxy', supportApi.includes("'/support/upload'") && supportApi.includes("'/support/report'"));
const clientMax = Number((supportApi.match(/TICKET_ATTACHMENT_MAX_COUNT = (\d+)/) || [])[1]);
ok('client and server agree on the attachment cap', clientMax === ATTACHMENT_MAX_COUNT);

const sidebar = read('src/components/Sidebar.jsx');
ok('sidebar mounts the button + modal', sidebar.includes('sidebar-report-btn') && sidebar.includes('<ReportIssueModal'));
const main = read('src/main.jsx');
ok('error ring buffer installs at app root', main.includes('installErrorBuffer()'));
const modal = read('src/components/ReportIssueModal.jsx');
ok('modal captures the ring buffer into context', modal.includes('getRecentErrors()'));
ok('modal captures build + timezone + sync diagnostics', modal.includes('APP_BUILD') && modal.includes('timezone') && modal.includes('useSyncStatus'));
ok('modal captures sync internals + offline queue depths', modal.includes('getSyncDiagnostics') && modal.includes('countMedia') && modal.includes('countChecklists'));
ok('modal never builds a portal URL (reference only, v1 rule)', !/support\/\$\{|portalUrl/.test(modal));

console.log(`\nsupport report: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
