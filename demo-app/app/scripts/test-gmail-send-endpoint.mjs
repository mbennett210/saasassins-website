// Gmail send must use the UPLOAD endpoint — §8 G3 (E8).
//
// gmailSend POSTed `{ raw }` as JSON to the STANDARD endpoint, which Google caps at
// 5 MB per request. Attachments are base64 INSIDE the MIME (+33%) and headers add
// more, so the real ceiling was ~3.7 MB of actual file — while the composer advertises
// 10 MB per file and 25 MB total. Everything in between was promised by the UI and
// rejected by the transport, with an error the user could not act on.
//
// Being precise about the earlier fix: 605b840 moved attachment bytes out of the
// Vercel request body (which 413'd at ~4.5 MB) into Storage. Real, but it did not move
// the user-visible ceiling at all, because Gmail's own 5 MB limit binds first.
//
// Source-level assertions: this cannot be exercised without a live Gmail token, and a
// live send is exactly what must NOT happen from a test.
//
//   node scripts/test-gmail-send-endpoint.mjs
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const src = readFileSync(new URL('../api/_lib/google.js', import.meta.url), 'utf8');
const att = readFileSync(new URL('../src/lib/attachments.js', import.meta.url), 'utf8');
const body = (src.match(/export async function gmailSend[\s\S]*?\n}/) || [])[0] || '';

ok('gmailSend exists', body.length > 0);

// ── 🔴 the endpoint ──────────────────────────────────────────────────────
ok('targets the UPLOAD host', /upload\/gmail\/v1\/users\/me/.test(src));
ok('gmailSend uses it', /GMAIL_UPLOAD_API|upload\/gmail/.test(body));
ok('passes uploadType=media', /uploadType=media/.test(body));
ok('no longer POSTs JSON `{ raw }`', !/JSON\.stringify\(\{\s*raw/.test(body));
ok('sends message/rfc822', /message\/rfc822/.test(body));
ok('decodes the base64url back to bytes', /base64url'\)/.test(body) || /from\(rawBase64Url, 'base64url'\)/.test(body));
ok('still authorises the request', /Authorization/.test(body));
ok('still surfaces the API error message', /Gmail send failed/.test(body));

// The standard host must not be what the send path resolves to. gmailFetch still uses
// it for profile/get/list, which is correct — those are small reads.
ok('the standard host is still used for the small read calls', /const GMAIL_API = /.test(src));
ok('  ...but gmailSend does not route through gmailFetch any more', !/gmailFetch\(accessToken, '\/messages\/send'/.test(src));

// ── the caller contract is unchanged ────────────────────────────────────
// buildMime still returns base64url and sender.js still passes it, so this change is
// contained to one function.
ok('buildMime still returns base64url', /toString\('base64url'\)/.test(src));
ok('gmailSend still takes rawBase64Url', /gmailSend\(accessToken, rawBase64Url\)/.test(body));

// ── the advertised caps are now reachable ───────────────────────────────
// 35 MB request, minus base64's +33% inside the MIME, leaves ~26 MB of real file —
// so the composer's 25 MB total finally fits. Pin the numbers so a future cap raise
// has to revisit this arithmetic rather than silently exceed the transport again.
{
  const perFile = Number((att.match(/ATTACHMENT_MAX_BYTES = (\d+) \* 1024 \* 1024/) || [])[1]);
  const total = Number((att.match(/ATTACHMENT_TOTAL_MAX_BYTES = (\d+) \* 1024 \* 1024/) || [])[1]);
  ok(`composer per-file cap parsed (${perFile} MB)`, Number.isFinite(perFile));
  ok(`composer total cap parsed (${total} MB)`, Number.isFinite(total));
  const usableMB = 35 / (4 / 3); // ~26 MB of raw file inside a 35 MB request
  ok(`the advertised total (${total} MB) now fits the transport (~${usableMB.toFixed(0)} MB)`, total <= usableMB);
  ok('  ...and it did NOT fit the old 5 MB endpoint (~3.7 MB)', total > 5 / (4 / 3));
  ok('per-file cap does not exceed the total', perFile <= total);
}

console.log(`\ngmail send endpoint: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
