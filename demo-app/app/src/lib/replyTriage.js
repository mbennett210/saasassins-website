// ─────────────────────────────────────────────────────────────────────────────
// Reply triage — rule-based bucketing of inbound MARKETING replies. Pure, no
// side effects, so it runs identically in the browser (RepliesTab render) and
// server-side (ingestMarketingReply / the reducer stamp a `category` on each
// reply row as it's recorded). There is no ML classifier — these are the same
// heuristics a human uses skimming the inbox: is this a bounce, an auto-reply,
// an unsubscribe request, or a real human?
//
// Buckets (first match wins, most-decisive first):
//   unsubscribe — explicit opt-out language (also drives CAN-SPAM auto-suppress)
//   bounce      — a DSN / mailer-daemon non-delivery report
//   auto_reply  — out-of-office / vacation / auto-acknowledgement autoresponders
//   human       — everything else (the replies that actually need a person)
// ─────────────────────────────────────────────────────────────────────────────

// Explicit opt-out language. Exported so the auto-suppress paths (reducer +
// server ingest) share ONE definition with the classifier — an "unsubscribe"
// bucket and a CAN-SPAM suppression can never disagree about what counts.
export const OPT_OUT_RE =
  /\b(unsubscribe|unsub|opt[\s-]?out|remove me|take me off|stop (?:emailing|contacting)|do not (?:e-?mail|contact)|no longer wish)\b/i;

// Bounce / non-delivery reports. Matched against subject + from-address.
const BOUNCE_FROM_RE = /(mailer-daemon|postmaster|no-?reply@.*(?:mail|smtp|delivery)|microsoftexchange)/i;
const BOUNCE_SUBJECT_RE =
  /(mail delivery (?:failed|subsystem)|delivery status notification|undeliverable|returned mail|failure notice|delivery has failed|message not delivered|address (?:not found|rejected)|550 |quota exceeded)/i;
const BOUNCE_BODY_RE =
  /(delivery to the following recipient|permanent (?:error|failure)|your message (?:couldn'?t be|was not|wasn'?t) delivered|the email account that you tried to reach|smtp;? ?5\d\d|diagnostic-code)/i;

// Out-of-office / autoresponder signals. Subject line carries most of these.
const AUTO_SUBJECT_RE =
  /(out of (?:the )?office|auto(?:matic)?[\s-]?reply|autoresponse|automatic response|away from (?:my|the) (?:desk|office)|on (?:vacation|holiday|leave|maternity|paternity|annual leave)|vacation reply|absence|ooo\b)/i;
const AUTO_BODY_RE =
  /(i am (?:currently )?(?:out of (?:the )?office|away|on (?:vacation|leave|holiday)|unavailable)|will be (?:out|away|back)|return(?:ing)? (?:to the office|on)|thank you for your email(?:[^.]*)(?:respond|reply|return)|this is an automated|automatic reply|limited access to (?:my )?email)/i;

/**
 * Classify one inbound reply.
 * @param {{subject?:string, body?:string, fromEmail?:string}} reply
 * @returns {{category:'unsubscribe'|'bounce'|'auto_reply'|'human', isOptOut:boolean}}
 */
export function classifyReply({ subject = '', body = '', fromEmail = '' } = {}) {
  const subj = String(subject || '');
  const text = String(body || '');
  const from = String(fromEmail || '');

  const isOptOut = OPT_OUT_RE.test(text) || OPT_OUT_RE.test(subj);

  // 1. Explicit opt-out wins — it's the most consequential (CAN-SPAM suppress).
  if (isOptOut) return { category: 'unsubscribe', isOptOut: true };

  // 2. Bounces — a machine, not the contact. Check from-address + subject + body.
  if (BOUNCE_FROM_RE.test(from) || BOUNCE_SUBJECT_RE.test(subj) || BOUNCE_BODY_RE.test(text)) {
    return { category: 'bounce', isOptOut: false };
  }

  // 3. Auto-replies / OOO — a person, but not actually engaging right now.
  if (AUTO_SUBJECT_RE.test(subj) || AUTO_BODY_RE.test(text)) {
    return { category: 'auto_reply', isOptOut: false };
  }

  // 4. Everything else is a genuine human reply that needs review.
  return { category: 'human', isOptOut: false };
}

// Convenience — just the bucket string. Used where the reply row already knows
// its opt-out status (the row stores `category`).
export function replyCategory(reply) {
  return classifyReply(reply).category;
}

// UI metadata for the four buckets — label + Badge variant. Kept here so the
// RepliesTab filter chips and row badges read from one vocabulary.
export const REPLY_CATEGORY_META = {
  human:       { label: 'Human',       variant: 'green' },
  auto_reply:  { label: 'Auto-reply',  variant: 'slate' },
  bounce:      { label: 'Bounce',      variant: 'red' },
  unsubscribe: { label: 'Unsubscribe', variant: 'amber' },
};

// Stable display order for the filter chips (most-actionable first).
export const REPLY_CATEGORY_ORDER = ['human', 'auto_reply', 'bounce', 'unsubscribe'];
