import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSession } from '../auth/AuthProvider';
import { INITIAL_STATE } from '../data/seed';
import { assetUrl } from '../lib/assetUrl';
import { friendlyAuthError, SESSION_EXPIRED_MESSAGE } from '../lib/authErrors';
import { IDENTITY } from '../brand/identity.generated.js';

// Pre-auth there is no store, so the brand comes straight from the seed —
// per-client config, same place the rest of the shell gets its identity.
const company = INITIAL_STATE.company;

// Standalone sign-in screen (outside the app shell + store). Authenticates
// against Supabase, then routes to wherever the user was headed. Also handles
// the password-reset (recovery) link landing here: when the user arrives via a
// reset link, it shows a "set a new password" form instead of the sign-in form,
// and surfaces a clear message when a link is expired or already used.
export default function Login() {
  const {
    signIn, sendPasswordReset, updatePassword,
    recovery, clearRecovery, authError, clearAuthError,
    session, loading, sessionExpired, clearSessionExpired,
    accountDisabled, clearAccountDisabled,
  } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from?.pathname || '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Already signed in (and NOT mid password-reset) → don't show the form.
  useEffect(() => {
    if (session && !recovery) navigate(from, { replace: true });
  }, [session, recovery, from, navigate]);

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true); setError(''); setNotice(''); clearAuthError(); clearSessionExpired(); clearAccountDisabled();
    try {
      const { error: err } = await signIn(email, password);
      // Map Supabase's terse errors to a clear, actionable line — a wrong password,
      // an unactivated invite, and a rate-limit must not all read the same (the
      // 2026-08-03 "is it me or the system?" confusion). See lib/authErrors.js.
      if (err) { setError(friendlyAuthError(err)); return; }
      navigate(from, { replace: true });
    } catch (err) {
      // A thrown rejection (e.g. the auth backend is unreachable) must not leave
      // the button stuck on "Signing in…" with no feedback.
      setError(friendlyAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  async function onForgot() {
    clearAuthError();
    if (!email.trim()) { setError('Enter your email above, then tap “Forgot password”.'); return; }
    setError(''); setNotice('');
    const { error: err } = await sendPasswordReset(email);
    if (err) setError(err.message || 'Could not send reset email.');
    else setNotice('If that email has an account, a password-reset link is on its way.');
  }

  async function onSetPassword(e) {
    e.preventDefault();
    setError(''); setNotice('');
    if (newPw.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (newPw !== confirmPw) { setError('Passwords do not match.'); return; }
    setBusy(true);
    const { error: err } = await updatePassword(newPw);
    setBusy(false);
    if (err) { setError(err.message || 'Could not set the new password. The link may have expired. Go back and request a new one.'); return; }
    clearRecovery();
    navigate('/', { replace: true });
  }

  const shownError = error || authError;

  const shell = (children) => (
    <div className="login-page">
      <svg className="login-mtn" viewBox="0 0 1440 280" preserveAspectRatio="none" aria-hidden="true">
        <path className="login-mtn-far" d="M0 280 L210 150 L350 215 L520 90 L660 190 L760 148 L930 230 L1090 160 L1260 235 L1440 170 L1440 280 Z" />
        <path className="login-mtn-near" d="M0 280 L130 225 L330 130 L470 200 L700 48 L800 120 L880 95 L1060 210 L1230 155 L1440 225 L1440 280 Z" />
        <path className="login-mtn-cap" d="M640 128 L700 48 L758 120 L738 108 L720 122 L700 102 L672 124 L654 112 Z" />
      </svg>
      <div className="card login-card">
        {company.logoUrl
          ? <img className="login-logo" src={assetUrl(company.logoUrl)} alt={company.name} />
          : <div className="login-brand-name">{company.name}</div>}
        <div className="login-sub">{recovery ? 'Set a new password' : 'Sign in to your workspace'}</div>
        {children}
        {accountDisabled && !recovery && !shownError && (
          <p className="text-xs login-msg login-msg-error">{accountDisabled.message}</p>
        )}
        {sessionExpired && !accountDisabled && !recovery && !shownError && !notice && (
          <p className="text-xs login-msg login-msg-notice">{SESSION_EXPIRED_MESSAGE}</p>
        )}
        {shownError && <p className="text-xs login-msg login-msg-error">{shownError}</p>}
        {notice && <p className="text-xs login-msg login-msg-notice">{notice}</p>}
      </div>
      <div className="login-foot">© 2026 {company.name}</div>
    </div>
  );

  // Reset-link landing → choose a new password.
  if (recovery) {
    return shell(
      <>
        <form className="login-form" onSubmit={onSetPassword}>
          <div className="login-field">
            <label className="form-label">New password</label>
            <input
              className="input" type="password" autoComplete="new-password" value={newPw}
              onChange={(e) => setNewPw(e.target.value)} placeholder="At least 8 characters" required autoFocus
            />
          </div>
          <div className="login-field">
            <label className="form-label">Confirm new password</label>
            <input
              className="input" type="password" autoComplete="new-password" value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)} placeholder="••••••••" required
            />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}
            style={{ width: '100%', marginTop: 8, justifyContent: 'center' }}>
            {busy ? 'Saving…' : 'Set password & sign in'}
          </button>
        </form>
        <button type="button" className="btn btn-link" onClick={() => { clearRecovery(); setError(''); }}
          style={{ display: 'block', margin: '12px auto 0' }}>
          Back to sign in
        </button>
      </>
    );
  }

  // Normal sign-in.
  return shell(
    <>
      <form className="login-form" onSubmit={onSubmit}>
        <div className="login-field">
          <label className="form-label">Email</label>
          <input
            className="input" type="email" autoComplete="username" value={email}
            onChange={(e) => setEmail(e.target.value)} placeholder={`you@${IDENTITY.company.domain}`}
            required autoFocus
          />
        </div>
        <div className="login-field">
          <div className="login-label-row">
            <label className="form-label">Password</label>
            <button type="button" className="linklike login-forgot" onClick={onForgot}>Forgot password?</button>
          </div>
          <input
            className="input" type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required
          />
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy || loading}
          style={{ width: '100%', marginTop: 8, justifyContent: 'center' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <div className="login-fine">Need an account? Access is provisioned by your administrator.</div>
    </>
  );
}
