import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSession } from '../auth/AuthProvider';
import { INITIAL_STATE } from '../data/seed';
import { friendlyAuthError, friendlyResetError, SESSION_EXPIRED_KEY } from '../lib/authErrors';
import { forgotEmail } from '../lib/passwordReset';
import { terminalAuthKey } from '../lib/terminalAuth';
import { useT } from '../i18n/react';
import { IDENTITY } from '../brand/identity.generated.js';
import { LIGHT_LOGO_URL } from '../brand/logo.js';
import { terrazzoStyle } from '../lib/terrazzo';
import InstallWelcome from '../components/InstallWelcome';
import { installWelcomeNow } from '../lib/installApp';

// Pre-auth there is no store, so the brand comes straight from the seed —
// per-client config, same place the rest of the shell gets its identity.
const company = INITIAL_STATE.company;

// Standalone sign-in screen (outside the app shell + store). Authenticates
// against Supabase, then routes to wherever the user was headed. Also handles
// the password-reset (recovery) link landing here: when the user arrives via a
// reset link, it shows a "set a new password" form instead of the sign-in form,
// and surfaces a clear message when a link is expired or already used.
export default function Login() {
  // Before sign-in there is no roster row, so the language is this phone's (or the choice
  // this device last saw) — a Spanish cleaner's sign-in screen is Spanish (CS-193).
  const t = useT();
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
  // "Forgot password?" in flight: the link is disabled and reads "Sending…" until the answer lands.
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // the terrazzo tiles, drawn once in the theme's own colours (lib/terrazzo.js)
  const [floor] = useState(terrazzoStyle);
  // A phone's browser that hasn't added the app sees the Home Screen welcome over this page first
  // (UI_RULES §178). Then the email box doesn't take the cursor on its own: its keyboard would come up
  // behind the welcome. Read once, as the page opens.
  const [welcomeDue] = useState(() => !!installWelcomeNow());

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
      if (err) { setError(friendlyAuthError(err, t)); return; }
      navigate(from, { replace: true });
    } catch (err) {
      // A thrown rejection (e.g. the auth backend is unreachable) must not leave
      // the button stuck on "Signing in…" with no feedback.
      setError(friendlyAuthError(err, t));
    } finally {
      setBusy(false);
    }
  }

  // "Forgot password?" (lib/passwordReset.js, the server's api/public/auth): one request at a time, so
  // a second tap while the first is on its way sends nothing (CS-122). The address is checked with the
  // server's own rule first. Every success reads the same neutral line, because the server's answer
  // never says whether the address has a login.
  async function onForgot() {
    if (resetting) return;
    clearAuthError();
    if (!email.trim()) { setError(t('login.enterEmailFirst')); return; }
    if (!forgotEmail(email)) { setError(t('login.badEmail')); return; }
    setError(''); setNotice('');
    setResetting(true);
    try {
      const { error: err } = await sendPasswordReset(email);
      if (err) setError(friendlyResetError(err, t));
      else setNotice(t('login.resetSent'));
    } catch (err) {
      setError(friendlyResetError(err, t));
    } finally {
      setResetting(false);
    }
  }

  async function onSetPassword(e) {
    e.preventDefault();
    setError(''); setNotice('');
    if (newPw.length < 8) { setError(t('login.tooShort')); return; }
    if (newPw !== confirmPw) { setError(t('login.mismatch')); return; }
    setBusy(true);
    const { error: err } = await updatePassword(newPw);
    setBusy(false);
    if (err) { setError(t('login.setFailed')); return; }
    clearRecovery();
    navigate('/', { replace: true });
  }

  const shownError = error || authError;

  const shell = (children) => (
    <div className="login-page" style={floor || undefined}>
      {/* The mark inlaid in a terrazzo floor (UI_RULES §18): two corner brackets, the brand's primary one owning
          the top-left corner and its accent one the bottom-right, each a chip-filled inlay inside a divider strip,
          with the card in the channel between them. Desktop turns the pair 6° at page scale; a phone sets them in its corners. */}
      <div className="login-mark" aria-hidden="true">
        <div className="login-inlay login-inlay-primary"><i /></div>
        <div className="login-inlay login-inlay-accent"><i /></div>
      </div>
      <div className="card login-card">
        {/* the logo made for a light ground: the sidebar's (company.logoUrl) is knocked out for the dark rail (CS-564).
            It is the SOFTWARE's (the brand pack's product, UI_RULES §129); the © line below is the company's. */}
        <img className="login-logo" src={LIGHT_LOGO_URL} alt={IDENTITY.product.name} />
        <div className="login-sub">{recovery ? t('login.setNew') : t('login.signInTo')}</div>
        {children}
        {accountDisabled && !recovery && !shownError && (
          <p className="text-xs login-msg login-msg-error">{t(terminalAuthKey(accountDisabled.code))}</p>
        )}
        {sessionExpired && !accountDisabled && !recovery && !shownError && !notice && (
          <p className="text-xs login-msg login-msg-notice">{t(SESSION_EXPIRED_KEY)}</p>
        )}
        {shownError && <p className="text-xs login-msg login-msg-error">{shownError}</p>}
        {notice && <p className="text-xs login-msg login-msg-notice">{notice}</p>}
      </div>
      <div className="login-foot">
        <span>© 2026 {company.name}</span>
        {IDENTITY.company.tagline && <span>{IDENTITY.company.tagline}</span>}
      </div>
    </div>
  );

  // Reset-link landing → choose a new password.
  if (recovery) {
    return shell(
      <>
        <form className="login-form" onSubmit={onSetPassword}>
          <div className="login-field">
            <label className="form-label">{t('login.newPassword')}</label>
            <input
              className="input" type="password" autoComplete="new-password" value={newPw}
              onChange={(e) => setNewPw(e.target.value)} placeholder={t('login.atLeast8')} required autoFocus
            />
          </div>
          <div className="login-field">
            <label className="form-label">{t('login.confirmNew')}</label>
            <input
              className="input" type="password" autoComplete="new-password" value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)} placeholder="••••••••" required
            />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}
            style={{ width: '100%', marginTop: 8, justifyContent: 'center' }}>
            {busy ? t('common.saving') : t('login.setAndSignIn')}
          </button>
        </form>
        <button type="button" className="btn btn-link" onClick={() => { clearRecovery(); setError(''); }}
          style={{ display: 'block', margin: '12px auto 0' }}>
          {t('login.backToSignIn')}
        </button>
      </>
    );
  }

  // Normal sign-in. The Home Screen welcome shows here, before sign-in: on an iPhone the Home Screen app
  // keeps its own sign-in, apart from Safari's, so adding it first means signing in once. Not on the
  // set-a-new-password screen above: an app added there would open without the link's token.
  return shell(
    <>
      <InstallWelcome />
      <form className="login-form" onSubmit={onSubmit}>
        <div className="login-field">
          <label className="form-label">{t('login.email')}</label>
          <input
            className="input" type="email" autoComplete="username" value={email}
            onChange={(e) => setEmail(e.target.value)} /* i18n-ok: an example address, not words */ placeholder={`you@${IDENTITY.company.domain}`}
            required autoFocus={!welcomeDue}
          />
        </div>
        <div className="login-field">
          <div className="login-label-row">
            <label className="form-label">{t('login.password')}</label>
            <button type="button" className="linklike login-forgot" onClick={onForgot} disabled={resetting} aria-busy={resetting || undefined}>
              {resetting ? t('login.sending') : t('login.forgot')}
            </button>
          </div>
          <input
            className="input" type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required
          />
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy || loading}
          style={{ width: '100%', marginTop: 8, justifyContent: 'center' }}>
          {busy ? t('login.signingIn') : t('login.signIn')}
        </button>
      </form>

      <div className="login-fine">{t('login.needAccount')}</div>
    </>
  );
}
