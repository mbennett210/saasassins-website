// ─────────────────────────────────────────────────────────────────────────────
// Reminder scheduler — pure functions over state. The React component in
// components/ReminderScheduler.jsx wires this to dispatch + setInterval and
// the delivery adapters (twilio.js, email.js).
//
// Fire windows (one-time per job per template, deduped by hasFired):
//   booking_confirmation : on job creation, immediately (status=upcoming)
//   reminder_24h         : when startAt is 12–30h away (status=upcoming)
//   day_of_eta           : when startAt is 0–12h away (status=upcoming)
//   post_service         : when status flips to 'completed'
//
// Token interpolation: {client_contact} {company} {service} {site_name}
//                      {date} {time}
// ─────────────────────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;

export function hasFired(events, templateKey, jobId) {
  if (!jobId) return false;
  return (events || []).some((e) => e.templateKey === templateKey && e.jobId === jobId);
}

export function shouldFire(template, job, events, now = new Date()) {
  if (!template?.enabled) return false;
  if (hasFired(events, template.key, job.id)) return false;

  const startAt = new Date(job.startAt).getTime();
  const nowMs = now.getTime();
  const diffMs = startAt - nowMs;

  switch (template.key) {
    case 'booking_confirmation':
      // Fire on creation for any job that hasn't yet started.
      return job.status === 'upcoming';
    case 'reminder_24h':
      if (job.status !== 'upcoming') return false;
      return diffMs > 12 * HOUR && diffMs <= 30 * HOUR;
    case 'day_of_eta':
      if (job.status !== 'upcoming') return false;
      return diffMs > 0 && diffMs <= 12 * HOUR;
    case 'post_service':
      return job.status === 'completed';
    default:
      return false;
  }
}

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

export function buildTokens({ client, company, service, site, job, contact }) {
  const contactName = contact
    ? `${contact.firstName || ''} ${contact.lastName || ''}`.trim()
    : (client?.primaryContact || 'there');
  return {
    client_contact: contactName || (client?.primaryContact || 'there'),
    company: company?.name || '',
    service: service?.name || '',
    site_name: site?.name || (client?.name || ''),
    date: fmtDate(job?.startAt),
    time: fmtTime(job?.startAt),
  };
}

export function interpolate(template, tokens) {
  if (!template) return '';
  return Object.entries(tokens || {}).reduce(
    (out, [k, v]) => out.replaceAll(`{${k}}`, v ?? ''),
    template
  );
}

/**
 * Real retry: re-deliver an existing event through the matching adapter.
 * Returns a Promise resolving to a patch object suitable for UPDATE_REMINDER_EVENT.
 * The caller is expected to (1) dispatch UPDATE_REMINDER_EVENT with status='pending'
 * before awaiting, then (2) dispatch UPDATE_REMINDER_EVENT with this patch on resolve.
 *
 * Adapters are passed in (rather than imported here) so this stays test-friendly.
 */
export async function retryDelivery({ event, state, sendSMS, sendEmail }) {
  const recipient = event.recipient
    || (() => {
      // Fall back: re-resolve the recipient from the linked client/contact if missing.
      const client = (state.clients || []).find((c) => c.id === event.clientId);
      if (!client) return null;
      const contact = client.primaryContactId
        ? (state.contacts || []).find((c) => c.id === client.primaryContactId)
        : null;
      return event.channel === 'sms'
        ? (contact?.phone || client.phone || null)
        : (contact?.email || client.email || null);
    })();

  if (!recipient) {
    return {
      status: 'failed',
      failureReason: event.channel === 'sms'
        ? 'No phone number on client/contact'
        : 'No email address on client/contact',
    };
  }

  if (event.channel === 'sms') {
    const twilio = state.company?.integrations?.twilio;
    if (!twilio?.connected) return { status: 'failed', failureReason: 'Twilio not connected' };
    if (!twilio.phoneNumber) return { status: 'failed', failureReason: 'No Twilio number provisioned' };
    if (twilio.a2p?.status !== 'approved') {
      return {
        status: 'failed',
        failureReason: `A2P 10DLC not approved (status: ${twilio.a2p?.status || 'not_started'})`,
      };
    }
    try {
      const res = await sendSMS({ from: twilio.phoneNumber, to: recipient, body: event.body || '' });
      return { status: 'sent', providerMessageId: res.sid, failureReason: null, sentAt: new Date().toISOString() };
    } catch (err) {
      return { status: 'failed', failureReason: err.message || 'SMS send error' };
    }
  }

  if (event.channel === 'email') {
    try {
      const res = await sendEmail({
        to: recipient,
        from: state.company?.email || 'no-reply@example.com',
        subject: event.subject || '(no subject)',
        body: event.body || '',
      });
      return { status: 'sent', providerMessageId: res.id, failureReason: null, sentAt: new Date().toISOString() };
    } catch (err) {
      return { status: 'failed', failureReason: err.message || 'Email send error' };
    }
  }

  return { status: 'failed', failureReason: `Unsupported channel: ${event.channel}` };
}

/**
 * Given the full app state and a moment in time, return the list of reminders
 * that should fire RIGHT NOW. Does not mutate state. Caller is expected to
 * dispatch ADD_REMINDER_EVENT for each + call the matching delivery adapter.
 *
 * Each entry: {
 *   template, job, client, contact?, site?, service?,
 *   channel, recipient, fromAddress?, fromPhone?,
 *   subject, body, tokens
 * }
 */
export function getDueReminders(state, now = new Date()) {
  const templates = state.reminderTemplates || [];
  const jobs = state.jobs || [];
  const events = state.reminderEvents || [];
  const company = state.company || {};

  const due = [];
  for (const job of jobs) {
    const client = (state.clients || []).find((c) => c.id === job.clientId);
    if (!client) continue;
    const site = (state.sites || []).find((s) => s.id === job.siteId);
    const service = (state.services || []).find((s) => s.id === (job.serviceId || client.serviceId));
    const contact = job.siteContactId
      ? (state.contacts || []).find((c) => c.id === job.siteContactId)
      : (client.primaryContactId
          ? (state.contacts || []).find((c) => c.id === client.primaryContactId)
          : null);

    for (const template of templates) {
      if (!shouldFire(template, job, events, now)) continue;

      const tokens = buildTokens({ client, company, service, site, job, contact });
      const subject = interpolate(template.subject || '', tokens);
      const body = interpolate(template.body || '', tokens);

      // Resolve recipient by channel. SMS uses phone, email uses email.
      // Prefer the linked contact's contact info, fall back to client-level.
      const recipient = template.channel === 'sms'
        ? (contact?.phone || client.phone || null)
        : (contact?.email || client.email || null);

      due.push({
        template,
        job,
        client,
        contact,
        site,
        service,
        channel: template.channel,
        recipient,
        fromPhone: company.integrations?.twilio?.phoneNumber || null,
        fromEmail: company.email || null,
        subject,
        body,
        tokens,
      });
    }
  }
  return due;
}
