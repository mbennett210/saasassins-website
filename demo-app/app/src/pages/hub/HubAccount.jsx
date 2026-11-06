import { useState } from 'react';
import { Link } from 'react-router-dom';
import BackLink from '../../components/BackLink';
import FormField from '../../components/FormField';
import { useToast } from '../../components/Toast';
import { useSession } from '../../auth/AuthProvider';
import { HUB_PREVIEW_NOTE } from '../../lib/hubPreview';
import { sectionPath } from './hubNav';
import { useHub } from './hubData';
import HubSectionHead from './HubSectionHead';
import HubEmailsCard from './HubEmailsCard';
import HubAlertsCard from './HubAlertsCard';
import { forgetHubAlerts } from '../../lib/hubAlerts';

// ACCOUNT (the client hub redesign, plan §3.1, 2026-10-08): who is signed in — name, email and
// phone, read-only (the office keeps a customer's details) — the buildings they can see, a new
// password, and Sign out (which moved here from the old top bar).
//
// CHANGE PASSWORD is the signed-in session's own `supabase.auth.updateUser({ password })`
// (AuthProvider.updatePassword) — the very call a customer's invite already makes when they set
// their first password (the set-password link lands on /login's recovery step), so it works for a
// customer session as it does for staff, and it touches nothing but the password (the role and
// the client-user id live in app_metadata, which only the service role writes). A project that
// asks for a recent sign-in before a password change answers with an error; the card then says
// how to do it from the sign-in page instead.
//
// ── MORE CARDS: one entry each, in order. ──────────────────────────────────────
//   Builder B: the Emails card — { key: 'emails', Card: HubEmailsCard } (a Card gets { hub, preview,
//   readOnly }: readOnly is the office's READ-ONLY preview, the layout's one flag, UI_RULES §151).
//   Crew on the way: the Phone alerts card — { key: 'alerts', Card: HubAlertsCard } (every Card
//   also gets viewerKey, what this browser remembers alerts by).
const CARDS = [
  { key: 'emails', Card: HubEmailsCard },
  { key: 'alerts', Card: HubAlertsCard },
];

export default function HubAccount() {
  const { hub, loading, error, onRetry, preview, readOnly, demo, exitPreview, currentId, viewerKey } = useHub();
  // No customer LOGIN is signed in, in the demo or in the office's preview (UI_RULES §151) — even
  // acting as the building's customer, the preview is its stand-in, which has no login: nothing here
  // changes a password or signs anyone out. A card gets `readOnly` for its own writes.
  const nobody = preview || demo;
  const { signOut } = useSession();
  const back = <BackLink to={currentId ? sectionPath(currentId, '') : '/hub'} label="Back to Dashboard" />;

  if (loading) return <div className="hub-page">{back}<p className="text-muted">Loading your account…</p></div>;
  if (error) {
    return (
      <div className="hub-page">
        {back}
        <div className="card hub-card">
          <p className="text-sm">{error}</p>
          {onRetry && <button type="button" className="btn btn-outline" onClick={onRetry}>Try again</button>}
        </div>
      </div>
    );
  }

  const viewer = hub?.viewer || {};
  const buildings = hub?.buildings || [];
  return (
    <div className="hub-page hub-account">
      <HubSectionHead back={back} title="Account" />

      <section className="card hub-card">
        <h2 className="hub-card-title">Your details</h2>
        <dl className="hub-dl">
          <div><dt className="text-xs">Name</dt><dd>{viewer.name || '—'}</dd></div>
          <div><dt className="text-xs">Email</dt><dd className="hub-dl-wrap">{viewer.email || '—'}</dd></div>
          <div><dt className="text-xs">Phone</dt><dd>{viewer.phone || '—'}</dd></div>
        </dl>
        <p className="text-xs text-muted">Contact your account manager to change these.</p>
      </section>

      <section className="card hub-card">
        <h2 className="hub-card-title">Your buildings</h2>
        {buildings.length ? (
          <ul className="hub-account-buildings">
            {buildings.map((b) => <li key={b.id} className="text-sm">{b.name}</li>)}
          </ul>
        ) : <p className="text-sm text-muted">No buildings yet. Contact the office and they will add one.</p>}
      </section>

      {CARDS.map((c) => <c.Card key={c.key} hub={hub} preview={!!preview} readOnly={readOnly} viewerKey={viewerKey} />)}

      <ChangePasswordCard noLogin={nobody} readOnly={readOnly} />

      <section className="card hub-card">
        <h2 className="hub-card-title">Sign out</h2>
        {nobody ? (
          <>
            <p className="text-sm text-muted">This is a preview of the customer hub. There is no customer signed in.</p>
            <div className="hub-actions">
              {preview && exitPreview
                ? <button type="button" className="btn btn-outline" onClick={exitPreview}>Exit preview</button>
                : <Link className="btn btn-outline" to="/">Back to the office</Link>}
            </div>
          </>
        ) : (
          <div className="hub-actions">
            {/* This phone's Crew on the way sign-up goes first, so the next person on it isn't sent the
                last one's alerts (lib/hubAlerts forgetHubAlerts: quick, never holds the sign-out up). */}
            <button type="button" className="btn btn-outline" onClick={async () => { await forgetHubAlerts(viewerKey); signOut(); }}>Sign out</button>
          </div>
        )}
      </section>
    </div>
  );
}

const PASSWORD_MIN = 8; // the sign-in page's own rule (Login.jsx, account settings)

// `noLogin`: the demo or the office's preview — there is no customer login to change.
function ChangePasswordCard({ noLogin, readOnly = false }) {
  const { updatePassword } = useSession();
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (noLogin || busy) return;
    if (pw.length < PASSWORD_MIN) { setProblem(`Use at least ${PASSWORD_MIN} characters.`); return; }
    if (pw !== confirm) { setProblem("The two passwords don't match."); return; }
    setProblem('');
    setBusy(true);
    let res;
    try { res = await updatePassword(pw); } catch (err) { res = { error: err }; }
    setBusy(false);
    if (res?.error) {
      setProblem(/reauthenticat|recent/i.test(String(res.error.message || res.error.code || ''))
        ? 'For your security, sign out and use "Forgot password" on the sign-in page to set a new one.'
        : "Your password couldn't be changed just now. Try again in a moment.");
      return;
    }
    setPw(''); setConfirm('');
    toast.success('Password changed.');
  };

  return (
    <form className="card hub-card hub-form" onSubmit={submit} noValidate>
      <h2 className="hub-card-title">Change password</h2>
      <FormField label="New password" name="new-password" type="password" value={pw} onChange={(e) => setPw(e.target.value)}
        help={`At least ${PASSWORD_MIN} characters.`} autoComplete="new-password" disabled={noLogin} />
      <FormField label="Confirm new password" name="confirm-password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
        autoComplete="new-password" disabled={noLogin} />
      {problem && <div className="form-error" role="alert">{problem}</div>}
      {noLogin && <p className="text-xs text-muted">{readOnly ? HUB_PREVIEW_NOTE : 'Preview: there is no customer login here to change.'}</p>}
      <div className="hub-actions hub-form-foot">
        <button type="submit" className="btn btn-primary" disabled={noLogin || busy}>{busy ? 'Saving…' : 'Change password'}</button>
      </div>
    </form>
  );
}
