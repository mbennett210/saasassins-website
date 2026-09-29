// Branded transactional emails for the e-signature quote flow. Pure template
// builders — each returns { subject, html } for the shared sendEmail() in
// ../email.js. Colours come from the document palette (src/brand/doc.js), so the emails follow the app
// brand the way the quote PDF does.
import { escapeHtml } from '../email.js';
import { DOC } from '../../../src/brand/doc.js';
import { IDENTITY } from '../../../src/brand/identity.generated.js';

const SHELL = (inner) =>
  `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:${DOC.ink}">
     <div style="background:${DOC.brand};color:${DOC.onBrand};padding:16px 22px;border-radius:10px 10px 0 0;font-size:17px;font-weight:700;letter-spacing:.2px">${escapeHtml(IDENTITY.name)}</div>
     <div style="border:1px solid ${DOC.divider};border-top:none;border-radius:0 0 10px 10px;padding:24px">${inner}</div>
   </div>`;

const BUTTON = (href, label) =>
  `<p style="margin:22px 0"><a href="${escapeHtml(href)}" style="display:inline-block;background:${DOC.brand};color:${DOC.onBrand};padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">${escapeHtml(label)}</a></p>`;

// Sent when the admin clicks "Send" — links the contact to the public sign page.
export function signRequestEmail({ quote, link }) {
  const first = String(quote.contact_name || quote.fields?.clientName || '').trim().split(' ')[0];
  const greeting = first ? `Hi ${escapeHtml(first)},` : 'Hi there,';
  const company = quote.fields?.companyName ? ` on behalf of ${escapeHtml(quote.fields.companyName)}` : '';
  return {
    subject: `Please review & sign your ${IDENTITY.name} agreement`,
    html: SHELL(
      `<h1 style="margin:0 0 14px;font-size:20px">Your service agreement is ready</h1>
       <p style="margin:0 0 10px;color:${DOC.body};font-size:14px;line-height:1.55">${greeting}</p>
       <p style="margin:0 0 10px;color:${DOC.body};font-size:14px;line-height:1.55">Thank you${company} for considering ${escapeHtml(IDENTITY.name)}. Your service agreement has been prepared and signed by our team — please review the details and add your signature to get started.</p>
       ${BUTTON(link, 'Review & sign')}
       <p style="margin:14px 0 0;color:${DOC.muted};font-size:12px;line-height:1.55">It only takes a minute, and a signed copy will be emailed to you for your records.<br>If the button doesn't work, paste this link into your browser:<br><span style="color:${DOC.pen};word-break:break-all">${escapeHtml(link)}</span></p>`
    ),
  };
}

// Sent after the client signs. toClient=true → message to the signer (PDF
// attached); false → internal copy to CleanSpace.
export function signedCopyEmail({ quote, toClient }) {
  const company = quote.fields?.companyName ? escapeHtml(quote.fields.companyName) : '';
  const who = escapeHtml(quote.client_signer_name || quote.contact_name || 'the client');
  if (toClient) {
    return {
      subject: `Signed — your ${IDENTITY.name} agreement`,
      html: SHELL(
        `<h1 style="margin:0 0 14px;font-size:20px">Thank you — all signed</h1>
         <p style="margin:0 0 10px;color:${DOC.body};font-size:14px;line-height:1.55">Your service agreement${company ? ` for ${company}` : ''} is now fully signed. A copy is attached to this email for your records.</p>
         <p style="margin:0 0 10px;color:${DOC.body};font-size:14px;line-height:1.55">We're glad to welcome you to ${escapeHtml(IDENTITY.name)}. Your account team will be in touch shortly with next steps.</p>`
      ),
    };
  }
  return {
    subject: `Quote signed — ${company || who}`,
    html: SHELL(
      `<h1 style="margin:0 0 14px;font-size:20px">A quote was just signed</h1>
       <p style="margin:0 0 10px;color:${DOC.body};font-size:14px;line-height:1.55"><strong>${who}</strong>${company ? ` (${company})` : ''} signed their service agreement. The fully-signed PDF is attached.</p>`
    ),
  };
}
