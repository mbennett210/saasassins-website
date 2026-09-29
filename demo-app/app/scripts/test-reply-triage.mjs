// Unit test for the rule-based reply-triage classifier (src/lib/replyTriage.js).
// Covers the four buckets + that the 'unsubscribe' bucket and the CAN-SPAM
// opt-out flag stay in lockstep. Run: node app/scripts/test-reply-triage.mjs
import { classifyReply, OPT_OUT_RE } from '../src/lib/replyTriage.js';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };

// ── unsubscribe ──────────────────────────────────────────────────────────────
{
  const r = classifyReply({ subject: 'Re: Spring cleaning offer', body: 'Please unsubscribe me from this list.' });
  ok(r.category === 'unsubscribe', 'body "unsubscribe" → unsubscribe bucket');
  ok(r.isOptOut === true, 'unsubscribe sets isOptOut (drives CAN-SPAM suppress)');
}
{
  const r = classifyReply({ body: 'take me off your emails' });
  ok(r.category === 'unsubscribe' && r.isOptOut, '"take me off" → unsubscribe + opt-out');
}
{
  const r = classifyReply({ body: 'STOP emailing me please' });
  ok(r.category === 'unsubscribe', '"stop emailing" → unsubscribe');
}
{
  // Opt-out phrase in the SUBJECT is caught too.
  const r = classifyReply({ subject: 'Unsubscribe', body: '' });
  ok(r.category === 'unsubscribe' && r.isOptOut, 'opt-out in subject → unsubscribe');
}

// ── bounce / DSN ─────────────────────────────────────────────────────────────
{
  const r = classifyReply({ fromEmail: 'MAILER-DAEMON@googlemail.com', subject: 'Delivery Status Notification (Failure)', body: 'Your message wasn\'t delivered.' });
  ok(r.category === 'bounce', 'mailer-daemon DSN → bounce');
  ok(r.isOptOut === false, 'a bounce is not an opt-out');
}
{
  const r = classifyReply({ subject: 'Undeliverable: Your quote', body: 'The email account that you tried to reach does not exist.' });
  ok(r.category === 'bounce', '"Undeliverable" subject → bounce');
}
{
  const r = classifyReply({ fromEmail: 'postmaster@corp.com', subject: 'Returned mail', body: 'smtp; 550 5.1.1 user unknown' });
  ok(r.category === 'bounce', 'postmaster + 550 → bounce');
}

// ── auto-reply / OOO ─────────────────────────────────────────────────────────
{
  const r = classifyReply({ subject: 'Out of Office: Re: your email', body: 'I am currently out of the office and will return Monday.' });
  ok(r.category === 'auto_reply', 'OOO subject → auto_reply');
}
{
  const r = classifyReply({ subject: 'Automatic reply: Inquiry', body: 'Thank you for your email. I will respond when I return.' });
  ok(r.category === 'auto_reply', '"Automatic reply" → auto_reply');
}
{
  const r = classifyReply({ body: 'I am on vacation until the 15th with limited access to my email.' });
  ok(r.category === 'auto_reply', 'vacation body → auto_reply');
}

// ── human ────────────────────────────────────────────────────────────────────
{
  const r = classifyReply({ subject: 'Re: Cleaning proposal', body: 'Yes! We\'d love a quote for our two buildings. When can you visit?' });
  ok(r.category === 'human', 'a genuine reply → human');
  ok(r.isOptOut === false, 'human reply is not an opt-out');
}
{
  const r = classifyReply({ subject: 'Re: hello', body: 'Not interested right now, maybe next quarter.' });
  ok(r.category === 'human', '"not interested" (no unsub phrase) stays human — a person to read');
}

// ── ordering: opt-out wins even if it also looks auto ────────────────────────
{
  const r = classifyReply({ subject: 'Out of office', body: 'Auto-reply. Also, please remove me from your list.' });
  ok(r.category === 'unsubscribe', 'opt-out beats auto-reply when both present (most consequential wins)');
}

// ── shared regex sanity ──────────────────────────────────────────────────────
ok(OPT_OUT_RE.test('please unsubscribe'), 'OPT_OUT_RE matches unsubscribe');
ok(!OPT_OUT_RE.test('happy to chat'), 'OPT_OUT_RE does not match a normal reply');

console.log(`\nreply-triage classifier: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
