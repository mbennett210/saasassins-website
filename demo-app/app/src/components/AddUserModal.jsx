import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import BuildingMultiPicker from './BuildingMultiPicker';
import Toggle from './Toggle';
import Badge from './Badge';
import PopMenu from './PopMenu';
import PickerCapNote from './PickerCapNote';
import SignInLinkPanel from './SignInLinkPanel';
import AvatarPhotoControl from './AvatarPhotoControl';
import Centred from './Centred';
import { useT } from '../i18n/react';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import {
  selectUserByEmail,
  selectCompany,
  selectCurrentUser,
  selectSystemEmailReplyTo,
  selectPermissions,
  selectUserPermissionOverrides,
} from '../store/selectors';
import { useToast } from './Toast';
import { useSession } from '../auth/AuthProvider';
import { usePermission } from '../hooks/usePermission';
import { memberRoleEnglish, canGrantPermission, PERMISSIONS, PERM_GROUPS } from '../lib/roles';
import { capOptions, PICKER_MAX_VISIBLE } from '../lib/pickerOptions';
import { roleChoices, choiceRole } from '../lib/teamLimits';
import { sendEmail, buildInviteEmail } from '../lib/email';
import { createTeamLogin, bindRosterId } from '../lib/teamApi';
import { newId } from '../lib/ids';
import { nextEmployeeId } from '../lib/employeeId';
import { IDENTITY } from '../brand/identity.generated.js';
import { PAY_TYPES, payTypeOf } from '../lib/payTypes';
import { isActiveBuilding } from '../lib/customerStatus';
import { customerLabel } from '../lib/customerNumber';
import { newMemberFields, newMemberOverride, crewAccessKeys, giveChoices } from '../lib/newMemberSetup';

// The crew fields (task 470): Works at, Access and the pay type with its rate, Hourly first with no
// rate typed. Access is `access` { [key]: on } for the switches set (a key left out is as the crew
// column gives it) and `given`, the keys given from "Give another permission", in the order given.
const EMPTY = { name: '', email: '', phone: '', role: 'crew', worksAt: [], access: {}, given: [], payType: 'hourly', payRate: '' };

// "Give another permission" (UI_RULES §189): the permissions the crew column lacks and this viewer
// may give, in the kit's searchable picker (PopMenu, as FilterSelect: a menu at the button through a
// portal on a computer, a sheet on a phone). Picking one gives it; the menu closes, as a picker does.
const GROUP_OF = Object.fromEntries(PERM_GROUPS.flatMap((g) => g.keys.map((k) => [k, g.label])));
const permLabel = (key) => PERMISSIONS[key]?.label || key;
function GivePermission({ keys, onGive }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);
  useEffect(() => { if (!open) setQuery(''); }, [open]);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? keys.filter((k) => `${permLabel(k)} ${GROUP_OF[k] || ''}`.toLowerCase().includes(q)) : keys;
  }, [keys, query]);
  const { shown, noteMsg } = capOptions(results, PICKER_MAX_VISIBLE);
  const give = (key) => { onGive(key); setOpen(false); };
  return (
    <div className="add-member-give" ref={wrapRef}>
      <button type="button" className="btn btn-outline" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Centred>Give another permission</Centred>
      </button>
      <PopMenu open={open} onClose={() => setOpen(false)} anchorRef={wrapRef} className="select-menu add-member-give-menu" role="listbox" sheetTitle="Give another permission" float>
        <input
          className="input select-search"
          placeholder={`Search ${keys.length} more permissions…`}
          aria-label="Search permissions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (shown[0]) give(shown[0]); } }}
          autoFocus
        />
        <div className="select-search-list">
          {results.length === 0 && <div className="select-search-empty">No matches</div>}
          {shown.map((k) => (
            <button key={k} type="button" role="option" aria-selected={false} className="menu-option add-member-give-option" onClick={() => give(k)}>
              <span className="add-member-give-label">{permLabel(k)}</span>
              <span className="text-xs text-muted">{GROUP_OF[k]}</span>
            </button>
          ))}
        </div>
        <PickerCapNote note={noteMsg} />
      </PopMenu>
    </div>
  );
}

// The crew fields come and go with the Role without a jump (the styling vault's "transitions"),
// opacity only, the card holding its size meanwhile (below). Turning away from Crew they fade out,
// kept on the page until they have; turning to Crew they fade in. Where they overflow the card,
// the buttons (the kit's footer, at the form's end) move between the card's foot and below its
// scroll, so they fade too: in at the foot once the fields are gone, and out before the fields
// come back. The phases: 'out' (fields fading out), then 'settle' (buttons fading in); 'clear'
// (buttons fading out), then 'in' (fields, and buttons where they moved, fading in). Index.css
// .add-member-crew / .add-member-actions draw them. A pop-up that opens on Crew shows them at once.
const CREW_FADE_OUT_MS = 160;
const ACTIONS_FADE_OUT_MS = 120;
const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};
function useCrewMotion(crew, overflows) {
  // Set as `crew` changes, in that same render, so the first frame drawn already has its fade.
  const [prev, setPrev] = useState(crew);
  const [phase, setPhase] = useState(null);
  if (prev !== crew) {
    setPrev(crew);
    setPhase(crew ? (overflows ? 'clear' : 'in') : 'out');
  }
  useEffect(() => {
    if (phase !== 'out' && phase !== 'clear') return undefined;
    const ms = reducedMotion() ? 0 : phase === 'out' ? CREW_FADE_OUT_MS : ACTIONS_FADE_OUT_MS;
    const next = phase === 'clear' ? 'in' : overflows ? 'settle' : null;
    const id = setTimeout(() => setPhase(next), ms);
    return () => clearTimeout(id);
  }, [phase, overflows]);
  return {
    phase,
    showFields: phase === 'out' || (crew && phase !== 'clear'),
    fieldsClass: `add-member-crew${phase === 'out' ? ' is-out' : phase === 'in' ? ' is-in' : ''}`,
    actionsClass: phase === 'clear' ? ' add-member-actions is-out'
      : phase === 'settle' || (phase === 'in' && overflows) ? ' add-member-actions is-in' : '',
  };
}

// `nextEmployeeId` moved to lib/employeeId (CS-229 / PAY-9) so the MINT and the UNIQUENESS
// rule that judges it live together and can never disagree about the EMP-#### format.

// `initial` prefills the form — used by the Settings → Team reconciliation banner
// to re-invite an orphan login with its email + claimed role already filled in.
// Only the name is left for the admin, because a Supabase account carries none.
export default function AddUserModal({ open, onClose, initial = null }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const t = useT();
  const { configured: authConfigured } = useSession();
  const company = selectCompany(state);
  const currentUser = selectCurrentUser(state);
  // Gmail sends as the system-sender mailbox, so there is no From to choose here — only
  // where replies should land (api/_lib/email.js resolveFromAndReplyTo).
  const emailDefaultReplyTo = selectSystemEmailReplyTo(state);

  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [rateError, setRateError] = useState('');
  const [sending, setSending] = useState(false);
  // { userId, name, email, invited, role, adopted, local } and, when nothing was emailed, the
  // server's `why` and either the one-time `link` to hand over (CS-661) or `linkWithheld`. The link
  // lives in this state only — never stored.
  const [created, setCreated] = useState(null);
  // The new member's photo (HUB-19, Matt: the photo option on adding a member): their row as the
  // store has it, so the photo shows the moment it is saved. Setting another member's photo is the
  // Team key's (the upload route's own rule), the key this pop-up's button needs anyway.
  const canSetPhoto = usePermission('settings.team.edit');
  // A new cleaner's pay and their "Can request supplies" switch (task 470) take the keys their own
  // page's Pay tab and Time tab take, the server's rules for a new member's pay and override row.
  const canSetPay = usePermission('payroll.rates.edit');
  const canSetAccess = usePermission('staff.editOverrides');
  const member = created?.userId ? (state.users || []).find((u) => u.id === created.userId) || null : null;

  useEffect(() => {
    if (!open) return;
    setForm({ ...EMPTY, ...(initial || {}) });
    setError('');
    setRateError('');
    setSending(false);
    setCreated(null);
    // `initial` is an object literal at the call site, so depending on it would
    // reset the form on every parent render — including mid-typing. Key off the
    // fields that actually identify a prefill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial?.email, initial?.role]);

  // The levels this viewer may give (lib/teamLimits roleChoices — lib/roles canGiveRole, owner's
  // rule 2026-09-23 — with the Manager role shown as its two levels, S131): a Super Admin any;
  // anyone else only a level whose every permission they hold themselves (with the default matrix
  // an Admin invites Admin, Supply Manager or Crew, a Manager Admin, Account Manager, Supply
  // Manager or Crew), and "Operations Manager" only for owner / admin with ops.edit. TeamDetail's
  // Role field offers the same list, and the server runs the same rules on the invite
  // (/api/settings/users) and on the roster save (the org_state guard). `form.role` holds the
  // choice's value; the role and level saved are choiceRole's.
  const choices = roleChoices(currentUser, selectPermissions(state), selectUserPermissionOverrides(state));
  const picked = choiceRole(form.role);

  // The crew fields (task 470, lib/newMemberSetup): shown, and saved, only while the role is Crew.
  const crew = picked.role === 'crew';
  const permissions = selectPermissions(state);
  const overrides = selectUserPermissionOverrides(state);
  const clients = state.clients;
  const worksAtOptions = useMemo(() => (clients || []).filter(isActiveBuilding)
    .map((c) => ({ value: c.id, label: customerLabel(c) }))
    .sort((a, b) => a.label.localeCompare(b.label)), [clients]);
  // Access (UI_RULES §189, Daniel's pick "B · Crew's switches up front"): every permission the crew
  // column holds as a switch, all on, then the ones given; each marked where it differs from Crew's.
  // Giving one where the crew column lacks it is a grant: only for a holder of the key (CS-331).
  const canGrant = (key) => canGrantPermission(currentUser, key, permissions, overrides);
  const crewKeys = useMemo(() => crewAccessKeys(permissions), [permissions]);
  const accessOn = (key) => form.access[key] ?? crewKeys.includes(key);
  const accessRows = [...crewKeys, ...form.given.filter((k) => !crewKeys.includes(k))];
  const accessChanged = accessRows.filter((k) => accessOn(k) !== crewKeys.includes(k)).length;
  const toGive = giveChoices({ permissions, mayGrant: canGrant }).filter((k) => !form.given.includes(k));
  const setAccess = (key, on) => setForm((f) => ({ ...f, access: { ...f.access, [key]: on } }));
  const giveKey = (key) => setForm((f) => ({ ...f, access: { ...f.access, [key]: true }, given: f.given.includes(key) ? f.given : [...f.given, key] }));
  const rateField = payTypeOf(form.payType)?.field ? payTypeOf(form.payType) : null;

  // The card holds the tallest it has been since it opened, up to its 90vh cap: the kit card's own
  // locked dimensions (index.css .modal-card, its 540px floor) carried past the floor, which the
  // crew fields outgrow. Without it the card snapped from 720px to 540px in one frame as the Role
  // turned away from Crew, Send invite jumping 274px (measured at 1280×800). Whether the fields
  // overflow the card is read here too, for useCrewMotion's buttons.
  const bodyRef = useRef(null);
  const cardTallest = useRef(0);
  const [crewOverflows, setCrewOverflows] = useState(false);
  const motion = useCrewMotion(crew, crewOverflows);
  useLayoutEffect(() => {
    if (!open) return;
    cardTallest.current = 0;
    setCrewOverflows(false);
  }, [open]);
  useLayoutEffect(() => {
    const card = bodyRef.current?.closest('.modal-card');
    if (!card) return;
    if (!created && motion.showFields) setCrewOverflows(card.scrollHeight > card.clientHeight + 1);
    if (card.offsetHeight <= cardTallest.current) return;
    cardTallest.current = card.offsetHeight;
    card.style.minHeight = `min(${cardTallest.current}px, 90vh)`;
  });

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setRateError('');
    const name = form.name.trim();
    const email = form.email.trim().toLowerCase();
    if (!name) { setError('Name is required.'); return; }
    if (!email) { setError('Email is required.'); return; }
    const dup = selectUserByEmail(state, email);
    if (dup) { setError(`Email already in use by ${dup.name}.`); return; }
    if (!choices.some((c) => c.value === form.role)) {
      setError(picked.role === 'owner'
        ? 'Only a Super Admin can create a Super Admin.'
        : `You can't give someone the ${memberRoleEnglish({ role: picked.role, managerLevel: picked.managerLevel })} access level: it includes permissions you don't have.`);
      return;
    }
    // What is saved: the role, and a manager's level only when it is the operations one (a missing
    // level reads as Account Manager — lib/teamScope).
    const role = picked.role;
    const level = role === 'manager' && picked.managerLevel === 'operations' ? { managerLevel: 'operations' } : {};
    // A cleaner's Works at and pay ride the ADD_USER; a bad rate stops here, before any login is made.
    const setup = newMemberFields({ role, worksAt: form.worksAt, payType: form.payType, payRate: form.payRate, canSetPay });
    if (setup.error) { setRateError(setup.error); return; }
    // The Access's override row, for the id the member is saved under (an adopted login's may have one).
    const saveAccess = (id) => {
      const existing = overrides.find((o) => o.userId === id) || null;
      const next = newMemberOverride({ role, access: form.access, permissions, existing, canSetAccess, mayGrant: canGrant });
      if (next) dispatch({ type: ACTIONS.SET_USER_PERMISSION_OVERRIDE, userId: id, ...next });
    };

    const initials = name.split(' ').filter(Boolean).map((p) => p[0]).join('').toUpperCase().slice(0, 2);
    const userId = newId('u');

    // ── Authed (Supabase) mode: create a REAL login + the team record, then
    //    email the new member a "set your password" link through the Google system sender (the admin
    //    never sees or shares a password). ──────────────────────────────────
    if (authConfigured) {
      setSending(true);
      let result;
      try {
        result = await createTeamLogin(email, role, userId);
      } catch (err) {
        setSending(false);
        setError(`Couldn't create login: ${err.message || 'failed.'}`);
        return;
      }
      // The SERVER decides the id. On an adopt it returns the one already stamped
      // into that login's JWT; using the locally-minted id instead would leave the
      // claim — which every server gate reads — pointing at nobody.
      const boundId = bindRosterId(result, userId);
      dispatch({
        type: ACTIONS.ADD_USER,
        user: { id: boundId, name, email, phone: form.phone.trim(), role, ...level, ...setup.fields, status: 'active', initials, hr: { employeeId: nextEmployeeId(state.users) } },
      });
      saveAccess(boundId);
      setSending(false);
      setCreated({
        userId: boundId,
        name, email, invited: result.invited !== false, role, managerLevel: level.managerLevel || null,
        adopted: result.adopted === true,
        link: result.link || null, why: result.why || null, linkWithheld: result.linkWithheld === true,
      });
      return;
    }

    // ── Local mode: original invite-email flow (no real auth backend). ──────
    const token = `tok_${Math.random().toString(36).slice(2, 14)}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    setSending(true);
    try {
      const { subject, body } = buildInviteEmail({
        inviteeName: name,
        inviterName: currentUser?.name || 'Your team',
        companyName: company.name,
        roleLabel: memberRoleEnglish({ role, ...level }),
        token,
        expiresAt,
      });
      await sendEmail({
        to: email,
        subject,
        body,
        replyTo: currentUser?.email || emailDefaultReplyTo,
        tags: ['invitation'],
      });
    } catch (err) {
      setSending(false);
      setError(`Couldn't send invitation: ${err.message || 'Email send failed.'}`);
      return;
    }
    dispatch({
      type: ACTIONS.ADD_USER,
      user: { id: userId, name, email, phone: form.phone.trim(), role, ...level, ...setup.fields, status: 'invited', initials, hr: { employeeId: nextEmployeeId(state.users) } },
    });
    saveAccess(userId);
    dispatch({ type: ACTIONS.SEND_INVITATION, userId, email, role, invitedBy: currentUser?.id });
    toast.success(`Invitation sent to ${email}`);
    setSending(false);
    // The last step, with the photo option (HUB-19), as the authed path's.
    setCreated({ userId, name, email, invited: true, role, managerLevel: level.managerLevel || null, local: true });
  };

  // `centred` and <Centred>: this pop-up's × and its buttons have their words in their middle by
  // code (components/Centred; Daniel's pick, 2026-11-02, "Only this pop-up", after Forge's styling
  // check measured the × 1.46px low and the words 0.5px high here; the first step's Cancel and Send
  // invite too since task 470, which Forge measures with the crew fields). 600px wide (`md`), so
  // Access's two columns of switches keep a permission's name on one line (UI_RULES §189).
  return (
    <Modal open={open} onClose={onClose} title={created ? 'Member added' : 'Add Team Member'} size="md" centred>
      {created ? (
        <div ref={bodyRef}>
          <p className="text-sm" style={{ marginBottom: 12 }}>
            {created.local
              ? <><strong>{created.name}</strong> was added to the team.</>
              : created.adopted
                ? <><strong>{created.name}</strong> already had a login here. It’s now reconnected to the team.</>
                : <><strong>{created.name}</strong>’s login was created.</>}
          </p>
          {created.adopted && (
            <div className="callout callout-info text-sm" style={{ marginBottom: 12 }}>
              An earlier invite created their login but never finished adding them to the team, so
              they didn’t appear on this list. Their existing account was kept. Anything already
              recorded under it stays theirs. And their access level is now <strong>{memberRoleEnglish(created)}</strong>.
            </div>
          )}
          {created.role === 'crew' && (
            <p className="text-sm" style={{ marginBottom: 12 }}>
              They'll see an account's cleans, keys, and contacts once they're scheduled on a clean there. Put them on a clean from the <strong>Schedule</strong>.
            </p>
          )}
          {created.invited && !created.local && (
            <div style={{ padding: '10px 12px', border: '1px solid var(--color-semantic-success-200)', borderRadius: 8, background: 'var(--color-semantic-success-50)', fontSize: 13, color: 'var(--color-semantic-success-700)' }}>
              We emailed <strong>{created.email}</strong> a secure link to set their password and sign in. Nothing to share.
            </div>
          )}
          {created.local && (
            <div className="callout callout-info text-sm">
              We emailed <strong>{created.email}</strong> an invitation to join.
            </div>
          )}
          {/* CS-661: nothing was emailed (the live app has no sending mailbox), so the office sends
              the one-time link itself — the link, or why it can't be shown, never a dead end. */}
          {!created.invited && created.link && (
            <SignInLinkPanel name={created.name} link={created.link} why={created.why} />
          )}
          {!created.invited && !created.link && (
            <div className="callout callout-warning text-sm">
              {created.linkWithheld ? t('signInLink.withheld', { name: created.name }) : t('signInLink.noLink', { name: created.name })}
            </div>
          )}
          {member && canSetPhoto && (
            <div className="add-member-photo">
              <AvatarPhotoControl user={member} canEdit justAdded centred>
                <div className="text-sm font-semi">Photo (optional)</div>
                <div className="text-xs text-muted">It shows beside their name in the app and in the customer hub.</div>
              </AvatarPhotoControl>
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}><Centred>Done</Centred></button>
          </div>
        </div>
      ) : (
        <form ref={bodyRef} onSubmit={submit}>
          <div className="form-row">
            <FormField label="Name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Jordan Tate" />
            <FormField label="Email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@company.com" />
          </div>
          {error && <div className="form-error" style={{ marginTop: -8, marginBottom: 10 }}>{error}</div>}
          <div className="form-row">
            <FormField label="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder={`(${IDENTITY.company.areaCode}) 555-0100`} />
            <FormField
              label="Role"
              as="select"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              options={choices.map((c) => ({ value: c.value, label: t(c.labelKey) }))}
              help={crew && canSetAccess ? "Crew's permissions are in Access below." : 'Permissions can be changed after adding.'}
            />
          </div>
          {/* A cleaner set up in one step (task 470): Works at, Access and pay, the three things their
              own page's Profile, Access and Pay tabs hold, with those tabs' words. */}
          {motion.showFields && (
            <div className={motion.fieldsClass} inert={motion.phase === 'out'}>
              <div className="form-group">
                <BuildingMultiPicker
                  label={t('worksAt.label')}
                  emptyNote={t('worksAt.empty')}
                  options={worksAtOptions}
                  value={form.worksAt}
                  onChange={(ids) => setForm({ ...form, worksAt: ids })}
                />
                <div className="form-help">{t('worksAt.hint')}</div>
              </div>
              {canSetAccess && (
                <div className="add-member-access">
                  <div className="add-member-access-head">
                    <span className="form-label">Access</span>
                    <span className="text-xs text-muted">
                      What Crew can do, all on. {accessChanged ? `${accessChanged} changed for this person.` : 'No changes.'}
                    </span>
                  </div>
                  <div className="add-member-access-grid">
                    {accessRows.map((key) => {
                      const on = accessOn(key);
                      const roleHas = crewKeys.includes(key);
                      return (
                        <div key={key} className="pref-row">
                          <div className="pref-row-text">
                            <div className="pref-row-label add-member-access-label">
                              <span>{permLabel(key)}</span>
                              {on !== roleHas && <Badge variant="amber">{roleHas ? 'Changed' : 'Added'}</Badge>}
                            </div>
                          </div>
                          <Toggle on={on} onChange={(next) => setAccess(key, next)} />
                        </div>
                      );
                    })}
                  </div>
                  {toGive.length > 0 && <GivePermission keys={toGive} onGive={giveKey} />}
                </div>
              )}
              {canSetPay ? (
                <div className="form-row">
                  <FormField
                    label="Pay type"
                    as="select"
                    value={form.payType}
                    onChange={(e) => { setRateError(''); setForm({ ...form, payType: e.target.value, payRate: '' }); }}
                    options={PAY_TYPES.map((p) => ({ value: p.value, label: p.label }))}
                  />
                  {rateField && (
                    <FormField
                      label={rateField.rateLabel}
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      value={form.payRate}
                      onChange={(e) => { setRateError(''); setForm({ ...form, payRate: e.target.value }); }}
                      placeholder="0.00"
                      error={rateError || undefined}
                    />
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted add-member-note">Their pay is set on their Pay tab, by someone who can set pay rates.</p>
              )}
            </div>
          )}
          <div className={`modal-actions${motion.actionsClass}`}>
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={sending}><Centred>Cancel</Centred></button>
            <button type="submit" className="btn btn-primary" disabled={sending}>
              <Centred>{sending ? 'Sending…' : 'Send invite'}</Centred>
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
