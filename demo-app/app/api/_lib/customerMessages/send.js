// THE ONE SEND STEP FOR EVERY CUSTOMER MESSAGE (Matt's approved messages, 2026-10-19).
//
// Every automated message to a customer, a prospect or a customer's hub login leaves through
// `sendCustomerMessage`: the reminders cron (api/reminders/run.js), the cleaner's "On my way"
// text and the office's answer texted back to a customer who texted (api/_lib/clientHub/
// messages.js). Nothing else in app/api may hand a customer message to the email or text
// transport, so the rules below hold for all of them at once. (Sign-in links go by email only,
// 2026-10-28: they are not customer messages and never leave through here.)
//
// 🔴 1. NEVER A SAMPLE RECORD. Production still holds the seed's 13 customers, their 13
//    contacts (each with an email at a real-looking company domain) and their 406 cleans. A
//    message whose customer, contact, clean, location or deal is a seed record
//    (`<prefix>_seed_<key>`, src/lib/ids.js isSeedId) is REFUSED here, before any transport is
//    touched, and the refusal is logged. Real records Matt's team enters get everything.
//    THE guard is this one call; the walkers do not repeat it, so no path can skip it by
//    building its own due list. Pinned by app/scripts/test-sample-record-guard.mjs.
// 2. Email leaves from the Google system sender (api/_lib/email.js sendTransactional); with no
//    mailbox marked it is skipped there, never an error.
// 3. Texts go through api/_lib/sms/twilio.js. With Twilio not configured the text is skipped
//    with one log line, never an error.
// 🔴 4. EVERY TEXT ENDS WITH THE STOP LINE, ONCE (src/lib/customerMessages.js SMS_STOP_LINE, the
//    A2P campaign's own words; Daniel, 2026-10-28). Appended here, as the text leaves, so no
//    template edit and no caller can lose it or double it.
// 🔴 5. NEVER A NUMBER THAT SAID STOP. Before Twilio is called the number is looked up in
//    sms_opt_outs (api/_lib/sms/optOuts.js, keyed by E.164): an opted-out number is refused with
//    { optedOut: true } and nothing leaves. When that list cannot be read nothing is texted
//    (fail closed). A text Twilio refuses with 21610 (the number replied STOP before the app
//    heard it) records the number, so the next one is refused here. Email is never affected.
// Never throws: the action a message belongs to never fails because delivery did.
import { sendTransactional } from '../email.js';
import { sendSms, smsConfigured } from '../sms/twilio.js';
import { readOptOut, recordOptOut } from '../sms/optOuts.js';
import { seedRecordIn } from '../../../src/lib/ids.js';
import { withSmsStopLine } from '../../../src/lib/customerMessages.js';
import { OPT_OUT_SOURCE } from '../../../src/lib/texting.js';

export const SAMPLE_RECORD_REFUSAL = 'sample-record';
export const CHANNELS = Object.freeze({ email: 'email', sms: 'sms' });
const OPTED_OUT_ERROR = 'The number has opted out of texts';

// `message`:
//   { templateKey, channel: 'email' | 'sms', to, subject?, body, from?, replyTo?, headers?,
//     attachments? ([{ filename, content (base64) }]), tags?,
//     refs: { clientId?, contactId?, jobId?, siteId?, opportunityId?, … } }
// `refs` names every record the message is about; each one is checked.
// → { ok: true, id }                                   sent (the provider's id)
//   { ok: false, refused: 'sample-record', recordId }  a sample record: nothing left
//   { ok: false, skipped: <why> }                      the channel is off, or nothing to send to
//   { ok: false, error }                               the provider refused it, or the
//                                                      opt-out list could not be read
//   { ok: false, optedOut: true }                      the number replied STOP (sms_opt_outs,
//                                                      or Twilio 21610): nothing left
export async function sendCustomerMessage(message = {}) {
  const what = message.templateKey || 'message';
  const recordId = seedRecordIn(message.refs);
  if (recordId) {
    console.warn(`[customer-messages] refused ${what}: ${recordId} is a sample record, so nothing was sent`);
    return { ok: false, refused: SAMPLE_RECORD_REFUSAL, recordId };
  }
  try {
    if (message.channel === CHANNELS.sms) {
      if (!smsConfigured()) {
        console.warn(`[customer-messages] ${what} text not sent: texting is not set up`);
        return { ok: false, skipped: 'sms_unconfigured' };
      }
      let stopped;
      try { stopped = await readOptOut(message.to); } catch (e) {
        console.error(`[customer-messages] ${what} text not sent: the opt-out list could not be read:`, e?.message || e);
        return { ok: false, error: 'The opt-out list could not be read' };
      }
      if (stopped) {
        console.warn(`[customer-messages] refused ${what}: the number replied STOP, so nothing was sent`);
        return { ok: false, optedOut: true, error: OPTED_OUT_ERROR };
      }
      const r = await sendSms({ to: message.to, body: withSmsStopLine(message.body) });
      if (r?.ok) return { ok: true, id: r.sid || null };
      if (r?.skipped === 'sms_unconfigured') return { ok: false, skipped: 'sms_unconfigured' };
      if (r?.skipped) return { ok: false, skipped: r.skipped };
      if (r?.optedOut) {
        try { await recordOptOut({ phone: message.to, source: OPT_OUT_SOURCE.carrier }); } catch (e) {
          console.error('[customer-messages] could not record a number Twilio says replied STOP:', e?.message || e);
        }
        return { ok: false, optedOut: true, error: OPTED_OUT_ERROR };
      }
      return { ok: false, error: r?.error || 'Text send failed' };
    }
    if (message.channel === CHANNELS.email) {
      const r = await sendTransactional({
        to: message.to,
        from: message.from,
        replyTo: message.replyTo || undefined,
        subject: message.subject || '(no subject)',
        body: message.body,
        tags: message.tags || ['reminder', what],
        headers: message.headers,
        attachments: message.attachments,
      });
      if (r?.ok) return { ok: true, id: r.id || null };
      if (r?.skipped) return { ok: false, skipped: 'email_unconfigured', error: r.error || null };
      return { ok: false, error: r?.error || 'Email send failed' };
    }
    return { ok: false, error: `Unsupported channel: ${message.channel}` };
  } catch (err) {
    return { ok: false, error: err?.message || 'Send error' };
  }
}
