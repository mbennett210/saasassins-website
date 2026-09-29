// From-allowlist for transactional email — AUTHORIZATION_AUDIT.md §2026-07-20 OPEN #3.
//
// THE HOLE: resolveFromAndReplyTo passed through any From ending in
// `@<verifiedDomain>` unmodified. /api/email/send only asks for a team member, and BOTH
// callers derive their requested From from `state.company` — the browser-writable
// org_state blob. So any authenticated user could send DKIM-signed, SPF-passing mail
// as steve@<verifiedDomain> from the company's real domain. Domain verification
// proves the domain is ours; it never proved which mailbox on it the caller may
// speak as.
//
// The fix is an ADDRESS allowlist sourced from env (service-controlled), never from
// the blob. These tests exist mostly to stop someone "simplifying" it back into a
// domain check.
//
//   node scripts/test-email-from-allowlist.mjs
import { resolveFromAndReplyTo, allowedFromAddresses, addressOf, verifiedDomain } from '../api/_lib/email.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const DOMAIN = 'billing.cleanspaceonline.com';
const DEFAULT_FROM = `Clean Space <quotes@${DOMAIN}>`;

// env is read per call by defaultFrom()/allowedFromAddresses(), so each block below
// re-points it rather than needing module reloading.
process.env.RESEND_DEFAULT_FROM = DEFAULT_FROM;
delete process.env.RESEND_ALLOWED_FROM;
delete process.env.RESEND_VERIFIED_DOMAIN;

// ── THE headline impersonation ─────────────────────────────────────────────
const steve = `Steve <steve@${DOMAIN}>`;
const r1 = resolveFromAndReplyTo({ from: steve, replyTo: null });
ok('an arbitrary mailbox on the VERIFIED DOMAIN is rewritten, not passed through', r1.rewritten === true);
ok('  ...and the send goes out as the verified default', addressOf(r1.from) === `quotes@${DOMAIN}`);
ok('  ...with the requested address preserved as Reply-To', r1.replyTo === `steve@${DOMAIN}`);
ok('  ...so the From is never attacker-chosen', addressOf(r1.from) !== `steve@${DOMAIN}`);

// The same address bare, and in other casings — addressOf lowercases.
ok('bare owner address is rewritten', resolveFromAndReplyTo({ from: `steve@${DOMAIN}` }).rewritten === true);
ok('UPPERCASE owner address is rewritten', resolveFromAndReplyTo({ from: `STEVE@${DOMAIN.toUpperCase()}` }).rewritten === true);
ok('subdomain-lookalike is rewritten', resolveFromAndReplyTo({ from: `x@evil.${DOMAIN}` }).rewritten === true);
ok('domain-suffix lookalike is rewritten', resolveFromAndReplyTo({ from: `x@not-${DOMAIN}` }).rewritten === true);

// ── the default From still works (nothing legitimate broke) ───────────────
const r2 = resolveFromAndReplyTo({ from: DEFAULT_FROM, replyTo: null });
ok('the configured default From passes through unmodified', r2.rewritten === false);
ok('  ...preserving its display name', r2.from === DEFAULT_FROM);
ok('the default address alone passes through', resolveFromAndReplyTo({ from: `quotes@${DOMAIN}` }).rewritten === false);
ok('allowedFromAddresses always contains the default', allowedFromAddresses().has(`quotes@${DOMAIN}`));

// ── env-configured widening (the operator escape hatch) ───────────────────
process.env.RESEND_ALLOWED_FROM = `office@${DOMAIN}, Billing <billing@${DOMAIN}>`;
ok('an env-allowlisted address passes through', resolveFromAndReplyTo({ from: `office@${DOMAIN}` }).rewritten === false);
ok('an env-allowlisted address given with a display name passes through', resolveFromAndReplyTo({ from: `Office <office@${DOMAIN}>` }).rewritten === false);
ok('an env entry written as "Name <addr>" is matched by address', allowedFromAddresses().has(`billing@${DOMAIN}`));
ok('a NON-listed address on the same domain is STILL rewritten', resolveFromAndReplyTo({ from: `steve@${DOMAIN}` }).rewritten === true);
ok('the allowlist has exactly default + 2', allowedFromAddresses().size === 3);
delete process.env.RESEND_ALLOWED_FROM;
ok('clearing the env narrows back to the default alone', allowedFromAddresses().size === 1);
ok('  ...and the previously-allowed address is rewritten again', resolveFromAndReplyTo({ from: `office@${DOMAIN}` }).rewritten === true);

// ── off-domain fallback: never fail the send, keep replies reachable ──────
const r3 = resolveFromAndReplyTo({ from: 'Company <hello@some-other-co.com>', replyTo: null });
ok('an off-domain From is rewritten', r3.rewritten === true);
ok('  ...and preserved as Reply-To so replies still land', r3.replyTo === 'hello@some-other-co.com');

// The stub fallback the client adapters use when nothing is configured.
const r4 = resolveFromAndReplyTo({ from: 'no-reply@example.com', replyTo: null });
ok('the example.com stub From is rewritten', r4.rewritten === true);
ok('  ...and never becomes a Reply-To', r4.replyTo === null);

// An explicit Reply-To always wins over the derived one.
const r5 = resolveFromAndReplyTo({ from: `steve@${DOMAIN}`, replyTo: 'office@cleanspaceonline.com' });
ok('an explicit replyTo wins on the rewritten path', r5.replyTo === 'office@cleanspaceonline.com');
const r6 = resolveFromAndReplyTo({ from: DEFAULT_FROM, replyTo: 'office@cleanspaceonline.com' });
ok('an explicit replyTo is kept on the pass-through path', r6.replyTo === 'office@cleanspaceonline.com');

// ── header injection ──────────────────────────────────────────────────────
// `from` reaches the Resend payload unsanitised (only `subject` was stripped).
process.env.RESEND_ALLOWED_FROM = `office@${DOMAIN}`;
const inj = resolveFromAndReplyTo({ from: `Evil\r\nBcc: victim@elsewhere.com <office@${DOMAIN}>` });
ok('CRLF in an allowlisted display name is stripped', !/[\r\n]/.test(inj.from));
ok('  ...and the injected header text cannot start a new line', inj.from.indexOf('\n') === -1);
delete process.env.RESEND_ALLOWED_FROM;

// ── degenerate input ──────────────────────────────────────────────────────
ok('missing From falls back to the default', resolveFromAndReplyTo({}).rewritten === true);
ok('  ...with no Reply-To invented', resolveFromAndReplyTo({}).replyTo === null);
ok('empty From falls back to the default', resolveFromAndReplyTo({ from: '' }).rewritten === true);
ok('null From falls back to the default', resolveFromAndReplyTo({ from: null }).rewritten === true);
ok('a non-address string falls back and is not used as Reply-To', resolveFromAndReplyTo({ from: 'not an email' }).replyTo === null);

// ── the domain check must not creep back in ───────────────────────────────
// verifiedDomain() still exists for /api/email/health; it must no longer be what
// decides who may send.
process.env.RESEND_VERIFIED_DOMAIN = DOMAIN;
ok('verifiedDomain() still resolves (health card)', verifiedDomain() === DOMAIN);
ok('but being ON that domain does NOT grant pass-through', resolveFromAndReplyTo({ from: `anyone@${DOMAIN}` }).rewritten === true);
delete process.env.RESEND_VERIFIED_DOMAIN;

console.log(`\nemail From-allowlist: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
