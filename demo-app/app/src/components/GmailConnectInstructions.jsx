// Shared Gmail-connect instructions rendered inside both the Settings
// (components/ConnectInboxModal.jsx) and the Marketing
// (components/ConnectMarketingInboxModal.jsx) connect flows. Single source of
// truth so both surfaces stay in sync.
//
// MODEL: Your installation's OAuth app is configured as "Internal" in Google
// Cloud — a single Workspace organization owns it, and only users in that
// Workspace can authorize. Connections are permanent (no 7-day expiry, no
// test-user cap), and authentication / password management stays with that
// Workspace upstream. Passwords are never seen; only a Google-issued OAuth
// refresh token is received.
//
// What this rules out:
//   - Connecting personal @gmail.com addresses (Internal blocks them).
//   - Connecting users from a different Workspace organization.
//   - Connecting users from a second Workspace org you also own (a separate
//     OAuth project would be required — out of scope for now).
//
// What's covered below:
//   1. Connecting your Workspace mailbox (per-user, every user does their own)
//   2. Errors you might see + what they mean
//   3. Admin setup — one-time per Workspace
//   4. Single-Workspace constraint callout
//
// All UI paths + button labels verified against current Google docs (May
// 2026). If Google renames anything (they do), update labels here so both
// modals get the fix.

import { useState } from 'react';
import Icon from './Icon';

function Section({ title, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderTop: '1px solid var(--color-border, #e5e7eb)' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          width: '100%',
          textAlign: 'left',
          padding: '10px 0',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13,
          fontWeight: 600,
          color: 'inherit',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            transform: open ? 'rotate(90deg)' : 'rotate(0)',
            transition: 'transform 0.15s ease',
          }}
          aria-hidden="true"
        >
          <Icon name="chevronRight" size={14} />
        </span>
        <span>{title}</span>
      </button>
      {open && (
        <div style={{ padding: '0 0 14px 22px', fontSize: 13, lineHeight: 1.55 }}>
          {children}
        </div>
      )}
    </div>
  );
}

export default function GmailConnectInstructions() {
  return (
    <div style={{ marginTop: 6 }}>
      <p style={{
        margin: '0 0 10px',
        padding: '8px 10px',
        background: 'var(--color-info-bg, #eff6ff)',
        borderRadius: 4,
        fontSize: 13,
        lineHeight: 1.5,
      }}>
        Each user connects their <strong>own</strong> Workspace mailbox here.
        Authentication, 2-step verification, and password rotation stay with
        your Workspace upstream — only the Google-issued token is stored,
        never a password.
      </p>

      <Section title="Connecting your Workspace mailbox" defaultOpen={true}>
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          <li>Click <strong>Connect with Google</strong> below — a Google sign-in popup opens.</li>
          <li>Pick your Workspace address (e.g. <code>you@yourcompany.com</code>).</li>
          <li>Approve the two requested scopes:
            <ul style={{ marginTop: 4 }}>
              <li><em>Send email on your behalf</em> — required to send.</li>
              <li><em>View your email messages and settings</em> — required for reply detection. Nothing is auto-modified or auto-sent without your action.</li>
            </ul>
          </li>
          <li>You&apos;re done — the connection is permanent. No weekly reconnects, no expiring tokens.</li>
        </ol>
        <p style={{ marginTop: 10, fontSize: 12, color: 'var(--color-text-muted, #6b7280)' }}>
          The default sender name on every send from this mailbox is your
          User Profile name (e.g. <em>&quot;Alex Morgan&quot; &lt;alex@…&gt;</em>) —
          no per-inbox setup needed.
        </p>
      </Section>

      <Section title='If you see "Access blocked" or a sign-in error'>
        <p style={{ margin: 0 }}>
          Two messages people sometimes hit, with their causes:
        </p>
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          <li>
            <strong>&quot;Access blocked: This app&apos;s request is invalid&quot;</strong> or{' '}
            <strong>&quot;Error 403: org_internal&quot;</strong>
            <div style={{ marginTop: 2 }}>
              Your Google account isn&apos;t in the Workspace org that owns
              the OAuth project. Either you&apos;re trying with a personal{' '}
              <code>@gmail.com</code> address (not supported — see callout
              below), or you&apos;re in a different Workspace from the one the
              installation is set up under. Talk to your admin.
            </div>
          </li>
          <li style={{ marginTop: 6 }}>
            <strong>&quot;This app isn&apos;t verified&quot;</strong>
            <div style={{ marginTop: 2 }}>
              Shouldn&apos;t happen with the current setup — the OAuth project
              runs in Internal mode, which bypasses verification entirely. If
              you see this, the project has been switched to External and the
              admin instructions below probably need to expand. Tell your
              admin.
            </div>
          </li>
        </ul>
      </Section>

      <Section title="Admin setup — one-time per Workspace">
        <p style={{ margin: '0 0 8px' }}>
          For the Workspace super admin (or any admin delegated{' '}
          <em>Manage Third-Party App Access</em>). This is a one-time setup
          for the whole org, NOT per-user.
        </p>
        <p style={{ margin: '0 0 8px' }}>
          <strong>Goal:</strong> mark your installation&apos;s OAuth app as
          Trusted so users in your Workspace can connect without seeing a
          security warning or being blocked.
        </p>
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          <li>Sign in to <a href="https://admin.google.com" target="_blank" rel="noreferrer">admin.google.com</a> as a super admin.</li>
          <li>Open <strong>Menu (☰) → Security → Access and data control → API controls</strong>.</li>
          <li>Click <strong>Manage Third-Party App Access</strong>.</li>
          <li>Click <strong>Configure new app</strong>.</li>
          <li>In the search box, paste your installation&apos;s OAuth <strong>Client ID</strong> — it lives in <code>GOOGLE_OAUTH_CLIENT_ID</code> in your deployment environment. It ends in <code>.apps.googleusercontent.com</code>.</li>
          <li>Select the app from results → <strong>Select</strong>.</li>
          <li>Scope: <strong>Entire organization</strong>, or use <strong>Select org units</strong> to limit to specific OUs / groups.</li>
          <li>Access level: <strong>Trusted: Can access all Google services</strong>. (Other options — Limited, Specific Google data, Blocked — are not what you want here.)</li>
          <li><strong>Continue → Finish</strong> (or <strong>Save</strong>).</li>
          <li>Effective within minutes (Google allows up to 24 hours). Users can now connect their own mailboxes from Settings → Connected Inboxes.</li>
        </ol>
        <p style={{ marginTop: 10, fontSize: 12, color: 'var(--color-text-muted, #6b7280)' }}>
          Confirm every domain you use (e.g. <code>yourcompany.com</code> and
          any additional domains) is listed under your Workspace at{' '}
          <em>admin.google.com → Account → Domains → Manage domains</em>.
          Anyone with a mailbox under those domains can then connect.
        </p>
      </Section>

      <Section title="One Workspace per OAuth project (current constraint)">
        <p style={{ margin: 0 }}>
          Because the OAuth project is configured as <strong>Internal</strong>,
          it accepts users from exactly <strong>one</strong> Google Workspace
          organization — the one that owns the Cloud project. That covers:
        </p>
        <ul style={{ margin: '8px 0', paddingLeft: 18 }}>
          <li>All users with mailboxes under any domain registered to that Workspace org (primary + secondary + alias).</li>
        </ul>
        <p style={{ margin: '0 0 8px' }}>
          That excludes:
        </p>
        <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
          <li>Personal <code>@gmail.com</code> addresses (no Workspace).</li>
          <li>Users from a different Workspace org — even one you also own. Each additional Workspace org would need its own OAuth project + Client ID + a multi-tenant rewrite of the inbox auth layer — meaningful work, not in scope today.</li>
        </ul>
        <p style={{
          margin: 0,
          padding: '8px 10px',
          background: 'var(--color-warning-bg, #fef3c7)',
          borderRadius: 4,
        }}>
          ⚠️ If you ever need to switch which Workspace owns the OAuth
          project (e.g. moving from a setup Workspace to your primary
          company domain), every currently-connected inbox needs to be
          disconnected first and reconnected afterwards — tokens are scoped
          to the project that issued them.
        </p>
      </Section>

      <p className="text-xs text-muted" style={{ marginTop: 14, marginBottom: 0 }}>
        2-step verification works as long as you complete sign-in inside the
        popup window — don&apos;t navigate away before approving. Steps
        verified against Google&apos;s docs as of May 2026.
      </p>
    </div>
  );
}
