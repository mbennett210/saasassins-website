// THE CLIENT HUB'S EMAILS — the words only (HUB-11). Who is sent one, and the sending, live in
// api/_lib/clientHub/notify.js; this module is pure so the copy is tested on its own.
//
// Matt, 2026-09-29: "Which updates should clients get by email? — (a) A ticket they sent changes
// status or gets a reply; (b) A new inspection is posted." ★ So three messages, and each one:
//   · calls a ticket a REQUEST — Matt's word on the customer side (decision D6, 2026-10-08);
//     the office keeps "ticket", and the builders keep their names;
//   · is ENGLISH ONLY (LANG-8: "Documents for clients… — (a) English only");
//   · links to the hub page it is about — but only when the app's public address is CONFIGURED
//     (DEV_PLAYBOOK 3.4.18: links in emails come from configuration and fail closed; never from a
//     request's Host header). With none, the email says what happened and carries no link;
//   · 🔴 takes no comment, note or message field it could leak: a status email gets the stage,
//     an inspection email the result and score, a reply email the one STAFF REPLY the caller
//     passes (never an internal note — the caller sends no email for one at all). The suite
//     checks the builders' parameter lists for exactly that.
//   · escapes everything a person typed (a ticket title, a reply) in its HTML.
//
// No colour, no logo, no styles: a plain message, so nothing here can drift from the brand
// (UI_RULES §121 — the document palette is for documents, and an email needs none).

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// The hub's page paths — ONE spelling, shared with the screens' routes (App.jsx `/hub/b/…`).
// A request's page stays at /tickets/<id>: emails already sent link there.
export const hubTicketPath = (buildingId, ticketId) => `/hub/b/${encodeURIComponent(buildingId)}/tickets/${encodeURIComponent(ticketId)}`;
export const hubInspectionPath = (buildingId, inspectionId) => `/hub/b/${encodeURIComponent(buildingId)}/inspections/${encodeURIComponent(inspectionId)}`;

// An absolute link from a CONFIGURED base, or null. http(s) only; a trailing slash is dropped.
export function hubAppLink(base, path) {
  const b = typeof base === 'string' ? base.trim().replace(/\/+$/, '') : '';
  if (!/^https?:\/\/[^\s/]+/i.test(b)) return null;
  return `${b}${path}`;
}

function compose({ subject, lines, link, linkLabel, brandName }) {
  const sign = brandName ? `The ${brandName} team` : 'Your cleaning team';
  const text = [...lines, ...(link ? ['', `${linkLabel}: ${link}`] : []), '', sign].join('\n');
  const html = [
    ...lines.map((l) => (l ? `<p>${esc(l).replace(/\n/g, '<br>')}</p>` : '')),
    link ? `<p><a href="${esc(link)}">${esc(linkLabel)}</a></p>` : '',
    `<p>${esc(sign)}</p>`,
  ].filter(Boolean).join('\n');
  return { subject, text, html };
}

// A request the client raised moved to a new stage (WO-8's words).
export function hubTicketStatusEmail({ brandName = '', buildingName = '', ticketTitle = '', stageLabel = '', link = null } = {}) {
  return compose({
    brandName,
    subject: `${buildingName}: an update on your request`,
    lines: [
      `Your request "${ticketTitle}" at ${buildingName} is now: ${stageLabel}.`,
    ],
    link,
    linkLabel: 'Open the request',
  });
}

// Our team replied on a request the client raised. `author` is already first name + last initial.
export function hubTicketReplyEmail({ brandName = '', buildingName = '', ticketTitle = '', author = '', replyBody = '', link = null } = {}) {
  return compose({
    brandName,
    subject: `${buildingName}: a reply on your request`,
    lines: [
      `${author || 'Our team'} replied on your request "${ticketTitle}" at ${buildingName}:`,
      String(replyBody ?? ''),
    ],
    link,
    linkLabel: 'Reply in the customer hub',
  });
}

// A new inspection was posted for a building the client can see.
export function hubInspectionEmail({ brandName = '', buildingName = '', inspectionName = '', resultLabel = '', score = null, link = null } = {}) {
  const scored = Number.isFinite(score) ? ` (${score}%)` : '';
  return compose({
    brandName,
    subject: `${buildingName}: a new inspection was posted`,
    lines: [
      `A new inspection was posted for ${buildingName}: ${inspectionName} — ${resultLabel}${scored}.`,
    ],
    link,
    linkLabel: 'Read the report',
  });
}

// ── Builder B: the building's Messages (client hub redesign, plan §3.4) ───────────────────────
// The hub page a building's thread lives on — ONE spelling, shared with the bell's links
// (lib/hubMessages.js) and the screens' route (App.jsx `/hub/b/:id/messages`).
export const hubMessagesPath = (buildingId) => `/hub/b/${encodeURIComponent(buildingId)}/messages`;

// The office answered in the building's thread. Sent to every customer login that can see the
// building and kept "Replies from the office" on (lib/hubEmailPrefs.js). `author` is already
// first name + last initial; `replyBody` is the office's one line, never anything else.
export function hubMessageReplyEmail({ brandName = '', buildingName = '', author = '', replyBody = '', link = null } = {}) {
  return compose({
    brandName,
    subject: `${buildingName}: a new message from the office`,
    lines: [
      `${author || 'Our team'} wrote in the ${buildingName} messages:`,
      String(replyBody ?? ''),
    ],
    link,
    linkLabel: 'Reply in the customer hub',
  });
}
