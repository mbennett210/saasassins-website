// A one-time set-password ("sign-in") link the app could not email, handed to the office to send
// themselves: GO-10 for customer logins (2026-10-03), and since S128 (CS-661) for staff too — the
// live app has no sending mailbox, and a new cleaner otherwise had no way in. ONE vocabulary for
// the server (api/_lib/users.js, api/_lib/teamAuthority.js) and the screens that show the link
// (components/SignInLinkPanel.jsx). Pure; no imports.

// HOW LONG A LINK LASTS, as the screens say it. The real figure is Supabase Auth's "Email OTP
// Expiration" — an Auth setting, not a database row, so the app cannot read it, and it is not in
// the repo. Supabase's default is 3,600 seconds and SEC-18 keeps it at most that, so the screens
// say "expires in 1 hour" from this one number: change it here if the dashboard setting changes.
export const SIGN_IN_LINK_HOURS = 1;

// Why a link did not leave by email (the server's `why`):
//   not-set-up  no sending mailbox is connected (or it needs reconnecting): every send is skipped
//   failed      the mailbox tried and the send failed
//   no-link     the link itself couldn't be made, so there is nothing to send or hand over
export const LINK_NOT_SENT = Object.freeze({ notSetUp: 'not-set-up', failed: 'failed', noLink: 'no-link' });

// The refusal code when the caller may not be HANDED a member's link: it signs in as that member,
// and the member holds permissions the caller doesn't (api/_lib/teamAuthority linkHandoverRefusal).
export const LINK_WITHHELD = 'link-withheld';
