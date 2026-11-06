// CS-075 — MIME header injection on the Gmail send path.
//
// api/_lib/google.js buildMime() interpolated To, Cc, Bcc, Reply-To, From, Message-ID and
// the extraHeaders KEYS straight into the header block. Only In-Reply-To, References and
// the extraHeaders VALUES were CR/LF-stripped. So a `to` of
//     "client@example.com\r\nBcc: attacker@evil.test"
// put a real Bcc header on mail leaving the company's own mailbox, and a crafted key did
// the same with any header it liked.
//
// These are pure tests of the builder, because the builder is the ONLY place headers are
// assembled: a caller-side check can be forgotten at the next call site, this cannot.
//
//   node scripts/test-mime-header-injection.mjs
import { buildMime } from '../api/_lib/google.js';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

const decode = (b64url) => Buffer.from(b64url, 'base64url').toString('utf8');
// The header block is everything before the first blank line.
const headersOf = (mime) => decode(mime).split('\r\n\r\n')[0].split('\r\n');
// Header lines that START a field (a leading space/tab is a folded continuation, not a
// new header) whose name is `name`.
const fieldLines = (mime, name) =>
  headersOf(mime).filter((l) => !/^[ \t]/.test(l) && l.toLowerCase().startsWith(`${name.toLowerCase()}:`));

const BASE = { from: 'Office <office@example.test>', to: 'client@example.test', subject: 'Hi', body: 'Text', messageId: '<a@b>' };

// ── the headline injection, one address field at a time ────────────────────────────
const CRLF = '\r\nBcc: attacker@evil.test';
for (const field of ['to', 'cc', 'bcc', 'replyTo', 'from']) {
  const mime = buildMime({ ...BASE, [field]: `victim@example.test${CRLF}` });
  const bccLines = fieldLines(mime, 'Bcc');
  // THE property: no NEW header field appears. For `bcc` itself one line legitimately
  // exists and the smuggled text is merged INTO its value (a malformed address list Gmail
  // rejects, not an extra recipient); for every other field there must be no Bcc line at all.
  const expectedBcc = field === 'bcc' ? 1 : 0;
  ok(`${field}: a smuggled CRLF does not add a Bcc header`,
    bccLines.length === expectedBcc,
    `Bcc lines: ${JSON.stringify(bccLines)}`);
  ok(`${field}: no raw CR/LF survives into the header block`,
    !headersOf(mime).some((l) => /[\r\n]/.test(l)));
}

// A bare LF (no CR) is the same attack — some MTAs accept it as a line break.
{
  const mime = buildMime({ ...BASE, to: 'victim@example.test\nBcc: attacker@evil.test' });
  ok('a bare LF does not add a Bcc header', fieldLines(mime, 'Bcc').length === 0,
    JSON.stringify(headersOf(mime)));
}

// A NUL byte terminates a C string in some MTAs; it must not reach the wire.
{
  const mime = buildMime({ ...BASE, to: 'victim@example.test\u0000Bcc: attacker@evil.test' });
  ok('a NUL byte is stripped from a header value', !decode(mime).includes('\u0000'));
}

// ── the Subject ──────────────────────────────────────────────────────────────────
// encodeHeader base64-encodes anything outside printable ASCII, which already covered a
// CRLF subject; assert it, because the protection is incidental and easy to lose.
{
  const mime = buildMime({ ...BASE, subject: 'Hello\r\nBcc: attacker@evil.test' });
  ok('a CRLF subject cannot add a Bcc header', fieldLines(mime, 'Bcc').length === 0,
    JSON.stringify(headersOf(mime)));
  ok('  ...and there is exactly one Subject line', fieldLines(mime, 'Subject').length === 1);
}

// ── extraHeaders KEYS (the half that was never stripped) ─────────────────────────
{
  const mime = buildMime({
    ...BASE,
    extraHeaders: { 'X-Tag\r\nBcc: attacker@evil.test': 'v' },
  });
  ok('a CRLF in an extraHeaders KEY does not add a Bcc header',
    fieldLines(mime, 'Bcc').length === 0, JSON.stringify(headersOf(mime)));
}
{
  const mime = buildMime({ ...BASE, extraHeaders: { 'X-A: injected\r\nBcc': 'x@y.test' } });
  ok('a colon inside an extraHeaders KEY cannot split it into two headers',
    fieldLines(mime, 'Bcc').length === 0 && fieldLines(mime, 'X-A').length <= 1,
    JSON.stringify(headersOf(mime)));
}
{
  // A key that sanitizes to nothing must be dropped, not written as ": value".
  const mime = buildMime({ ...BASE, extraHeaders: { '\r\n': 'x' } });
  ok('an extraHeaders key that sanitizes to nothing is dropped',
    !headersOf(mime).some((l) => l.startsWith(':')), JSON.stringify(headersOf(mime)));
}

// ── extraHeaders may not RESTATE a header the builder owns ────────────────────────
// A second `Bcc:`/`To:`/`From:` line is the same attack spelled as a key.
for (const owned of ['Bcc', 'To', 'From', 'Reply-To', 'Subject', 'Message-ID', 'Content-Type']) {
  const mime = buildMime({ ...BASE, extraHeaders: { [owned]: 'attacker@evil.test' } });
  ok(`extraHeaders cannot add a second ${owned} header`,
    fieldLines(mime, owned).filter((l) => l.includes('attacker@evil.test')).length === 0,
    JSON.stringify(fieldLines(mime, owned)));
  ok(`  ...and there is at most one ${owned} line`, fieldLines(mime, owned).length <= 1);
}
// Case does not let it through.
{
  const mime = buildMime({ ...BASE, extraHeaders: { bCc: 'attacker@evil.test' } });
  ok('the owned-header check is case-insensitive', fieldLines(mime, 'Bcc').length === 0);
}

// ── the legitimate headers still work ────────────────────────────────────────────
{
  const mime = buildMime({
    ...BASE,
    cc: 'cc@example.test',
    bcc: 'bcc@example.test',
    replyTo: 'reply@example.test',
    inReplyTo: '<prev@host>',
    references: '<first@host> <prev@host>',
    extraHeaders: { 'X-CleanSpace-Marketing-Sequence-Id': 'sq_1' },
  });
  const h = headersOf(mime).join('\n');
  ok('a normal message keeps every header it was given',
    h.includes('To: client@example.test')
    && h.includes('Cc: cc@example.test')
    && h.includes('Bcc: bcc@example.test')
    && h.includes('Reply-To: reply@example.test')
    && h.includes('In-Reply-To: <prev@host>')
    && h.includes('References: <first@host> <prev@host>')
    && h.includes('X-CleanSpace-Marketing-Sequence-Id: sq_1'),
    h);
  ok('  ...and the body still follows a blank line',
    decode(mime).includes('\r\n\r\n') && decode(mime).includes(Buffer.from('Text').toString('base64')));
}

console.log(`\nMIME header injection (CS-075): ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exitCode = 1; }
