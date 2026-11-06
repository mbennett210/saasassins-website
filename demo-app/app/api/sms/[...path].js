// TEXTS TO OUR NUMBER — Twilio's inbound webhook (Daniel, 2026-10-28: "Yes, add the Reply STOP
// functionality." and, for replies, "Customer thread, texted back").
//
//   POST /api/sms/inbound   (application/x-www-form-urlencoded, as Twilio sends it)
//        -> 200 text/xml  <Response></Response>   (an empty TwiML answer: this route never texts
//           back on its own; Twilio's Messaging Service answers STOP, START and HELP itself)
//
// Set as the Messaging Service's "incoming message" webhook, at the app's PUBLIC address:
// https://www.cleancorner.app/api/sms/inbound (APP_PUBLIC_URL, api/_lib/appUrl.js).
//
// AUTH STANCE: public to the internet, read only when Twilio signed it. `requireTwilioSignature`
// (api/_lib/sms/signature.js) checks X-Twilio-Signature — HMAC-SHA1 of the public URL and the
// sorted form, keyed by TWILIO_AUTH_TOKEN, compared in constant time — before a byte of the form
// is used: unsigned or wrongly signed is a 403 that changes nothing; no token configured is a 503
// (fail closed). The answer never echoes the form, a number or a secret.
//
// What a text does (api/_lib/sms/inbound.js): STOP and its siblings put the number on the
// opted-out list (sms_opt_outs) and START takes it off; anything else is a customer line in its
// building's thread, marked as a text from that number (or, when no one building has that number,
// an email to the office). A text that could not be filed (a database failure) is emailed to the
// office as it came, so it is not lost; only when that email fails too does the route answer 500
// (Twilio's debugger then logs it; Twilio does not redeliver an incoming text on its own). A text
// Twilio does deliver twice is still one line: the line's id is minted from the MessageSid.
//
// Multi-segment catch-all rewritten in via ?subpath= (vercel.json), as every catch-all here.
// bodyParser is off: the signature is over the form exactly as sent.
import { requireTwilioSignature } from '../_lib/sms/signature.js';
import { handleInboundText, emailOffice } from '../_lib/sms/inbound.js';
import { inboundTextBody } from '../../src/lib/texting.js';
import { toE164 } from '../../src/lib/alertDelivery.js';

export const config = { api: { bodyParser: false } };

// Twilio's form is small (a text is at most 1,600 characters, plus up to ten media URLs).
const MAX_FORM_BYTES = 64 * 1024;
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function readForm(req) {
  return new Promise((resolve) => {
    const parts = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_FORM_BYTES) { over = true; return; }
      parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(parts).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

export default async function handler(req, res) {
  const path = (typeof req.query?.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query?.path) ? req.query.path
      : (req.query?.path ? String(req.query.path).split('/').filter(Boolean) : []);
  if (path.length !== 1 || path[0] !== 'inbound') return res.status(404).json({ error: 'Unknown route.' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  res.setHeader('Cache-Control', 'no-store');

  const raw = await readForm(req);
  if (raw === null) return res.status(413).json({ error: 'Too large.' });
  const params = Object.fromEntries(new URLSearchParams(raw));
  if (!requireTwilioSignature(req, res, params)) return undefined; // 403 / 503 already written

  try {
    const done = await handleInboundText(params);
    console.log('[api/sms] inbound text:', done.kind, done.reason || '');
  } catch (e) {
    console.error('[api/sms] inbound text failed:', e?.code || '', e?.message || e);
    // Nothing is lost: the office gets the text as it came.
    let mailed = false;
    try {
      const from = toE164(String(params.From || ''));
      if (from) mailed = !!(await emailOffice({ from, body: inboundTextBody(params.Body, params.NumMedia), why: 'It could not be filed just now.' }))?.ok;
    } catch (mailErr) {
      console.error('[api/sms] inbound text office email failed:', mailErr?.message || mailErr);
    }
    if (!mailed) return res.status(500).json({ error: 'Not filed.' });
  }
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(EMPTY_TWIML);
}
