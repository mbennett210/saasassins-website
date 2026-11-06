// The NEW-CUSTOMER ONBOARDING BAR (task 471 from Clean Corner's queue; UI_RULES §190), drawn on a
// customer's page above its tabs while it is onboarding (lib/onboarding isOnboarding).
//
// Seven parts, in the order of Matt's list ("clean corner", 2026-11-03): Company, Primary contact,
// Cleaning schedule, Assigned cleaners, Supplies, Documents & contracts, then Special services from
// the same email (task 507, UI_RULES §192: green once a service is entered or the building is
// marked as having none, Daniel's pick 2026-11-04). Each part's fill reads its
// step from the real records (lib/onboarding onboardingFacts): green done, amber skipped with a
// note, grey to do. Tapping a part opens that step below the bar: what it still needs, the button
// that does it (the part the app already has: the Overview's Edit, Add / Edit contact, New clean,
// this pop-up's cleaner picker, the Supplies tab's switches, the Contract tab, the special-service
// pop-up and "None at this building") and, on a step that
// may be skipped, Skip with a note / Undo skip. Daniel's pick: a skipped step STAYS OPEN, so the
// customer reads "Onboarding" until every part is green. Then this bar stamps the finish once
// (`onboarding.doneAt`) and stays drawn, all green, until the page is left.
//
// Writes: the skip notes and the finish stamp are ONE UPDATE_CLIENT each (the customer's ordinary
// data, the server's existing rule); a cleaner's Works at is UPDATE_USER (settings.team.edit, the
// key the server holds it to); a special service is SAVE_SPECIAL_SERVICE and "None at this building"
// SET_NO_SPECIAL_SERVICES (clients.edit, like the skips). Every word is a catalog line
// (`onboarding.*`, UI_RULES §140).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectAssignedCleanersForClient, selectUpcomingJobsForClient, selectUserById, selectCurrentUser } from '../store/selectors';
import { usePermission, useCanEditJobs } from '../hooks/usePermission';
import { useT } from '../i18n/react';
import { fmtDate } from '../lib/dates';
import * as contractsApi from '../lib/contractsApi';
import { worksAtOf } from '../lib/worksAt';
import { specialServicesOf, hasNoSpecialServices } from '../lib/specialServices';
import {
  STEP_STATE, ONBOARDING_NOTE_MAX, onboardingFacts, onboardingSteps, onboardingProgress, firstOpenStep,
  missingCompanyFields, missingContactFields, skipStepPatch, unskipStepPatch, finishPatch,
  STEP_TITLE_KEY, STEP_SEGMENT_KEY, STEP_STATE_KEY, FIELD_KEY,
} from '../lib/onboarding';
import Badge from './Badge';
import Centred from './Centred';
import Modal from './Modal';
import FormField from './FormField';
import CrewPicker from './CrewPicker';
import NewJobModal from './NewJobModal';
import AddUserModal from './AddUserModal';
import SpecialServiceModal from './SpecialServiceModal';
import { useToast } from './Toast';

// The building's contracts for the Documents & contracts step: null while the read is out (or for a
// viewer without contracts.view, who can't read them), `error` when it failed. `reload` is handed to
// the Contract tab so a contract added or signed there turns the step green at once.
export function useOnboardingContracts(clientId, enabled) {
  const [contracts, setContracts] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    if (!enabled || !clientId) { setContracts(null); setError(null); return undefined; }
    let live = true;
    setError(null);
    contractsApi.contractsForClient(clientId)
      .then((list) => { if (live) setContracts(list || []); })
      .catch((e) => { if (live) { setContracts(null); setError(e); } });
    return () => { live = false; };
  }, [clientId, enabled, tick]);
  return { contracts, error, reload };
}

const STATE_VARIANT = { done: 'green', skipped: 'amber', todo: 'slate', unknown: 'slate' };

/**
 * @param client, location, primaryContact  the customer, its one site, its primary contact
 * @param jobsReady       the customer's cleans are loaded (useClientJobs)
 * @param supply          { items, error, reload } — the page's one read of its supply list
 * @param contractsRead   useOnboardingContracts' result
 * @param canEdit         clients.edit: skip, undo and the finish stamp
 * @param onEditDetails   () => void — the Overview's Edit (name, number)
 * @param onOpenTab       (key, { edit }) => void — a section tab (`access`, `supplies` with its
 *                        switches open, `contract`)
 * @param onAddContact / onEditContact(contact)
 * @param onFinished      () => void — every part green and the finish stamped
 */
export default function OnboardingBar({
  client, location, primaryContact, jobsReady, supply, contractsRead, canEdit,
  onEditDetails, onOpenTab, onAddContact, onEditContact, onFinished,
}) {
  const t = useT();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const currentUser = selectCurrentUser(state);
  const canEditContacts = usePermission('contacts.edit');
  const canEditJobs = useCanEditJobs();
  const canEditTeam = usePermission('settings.team.edit');
  const canViewSupplies = usePermission('supplies.view');
  const canManageSupplies = usePermission('supplies.manage');
  const canViewContracts = usePermission('contracts.view');

  const upcoming = useMemo(() => selectUpcomingJobsForClient(state, client.id), [state, client.id]);
  const cleaners = useMemo(() => selectAssignedCleanersForClient(state, client.id), [state, client.id]);
  const facts = onboardingFacts({
    client, location, primaryContact,
    upcomingCleans: jobsReady ? upcoming.length : null,
    cleaners: jobsReady ? cleaners.length : null,
    supplyItems: canViewSupplies ? supply?.items : null,
    contracts: canViewContracts ? contractsRead?.contracts : null,
  });
  const steps = onboardingSteps(client, facts);
  const progress = onboardingProgress(steps);
  const finished = !!client.onboarding?.doneAt;

  const [openStep, setOpenStep] = useState(() => firstOpenStep(steps) || 'company');
  const [skipping, setSkipping] = useState(null);
  const [newCleanOpen, setNewCleanOpen] = useState(false);
  const [cleanersOpen, setCleanersOpen] = useState(false);
  const [specialOpen, setSpecialOpen] = useState(false);

  // Every part green: stamp the finish ONCE (its notes cleared), say so, and keep the bar drawn
  // all green until the page is left (the page holds that), so nothing jumps under the office.
  const stamped = useRef(false);
  useEffect(() => {
    if (!canEdit || stamped.current) return;
    const patch = finishPatch(client, steps, { at: new Date().toISOString() });
    if (!patch) return;
    stamped.current = true;
    dispatch({ type: ACTIONS.UPDATE_CLIENT, id: client.id, patch });
    toast.success(t('onboarding.finished', { customer: client.name }));
    onFinished?.();
  });

  const stepLabel = (step) => t(STEP_TITLE_KEY[step]);
  const fieldList = (keys) => keys.map((k) => t(FIELD_KEY[k]));
  const open = steps.find((s) => s.step === openStep) || steps[0];

  const unskip = (step) => {
    const patch = unskipStepPatch(client, step);
    if (!patch) return;
    dispatch({ type: ACTIONS.UPDATE_CLIENT, id: client.id, patch });
    toast.success(t('onboarding.unskipped', { step: stepLabel(step) }));
  };
  const skip = (step, note) => {
    const patch = skipStepPatch(client, step, { note, at: new Date().toISOString(), by: currentUser?.id || null });
    if (!patch) return;
    dispatch({ type: ACTIONS.UPDATE_CLIENT, id: client.id, patch });
    toast.success(t('onboarding.skippedToast', { step: stepLabel(step) }));
    setSkipping(null);
  };
  const markNoSpecial = () => {
    dispatch({ type: ACTIONS.SET_NO_SPECIAL_SERVICES, clientId: client.id, none: true, at: new Date().toISOString(), by: currentUser?.id || null });
    toast.success(t('specialSvc.noneSet'));
  };

  // What the open step says, and the button that does it (only for a viewer who may).
  const detailFor = (s) => {
    const { step, state: st } = s;
    if (step === 'company') {
      const missing = missingCompanyFields(client, location);
      return {
        text: missing.length ? t('onboarding.needs', { fields: fieldList(missing) }) : t('onboarding.company.done'),
        action: missing.length && canEdit
          ? { label: t('onboarding.action.company'), run: () => (missing.some((k) => k === 'name' || k === 'customerNumber') ? onEditDetails() : onOpenTab('access')) }
          : null,
      };
    }
    if (step === 'contact') {
      if (!primaryContact) {
        return { text: t('onboarding.contact.none'), action: canEditContacts ? { label: t('onboarding.action.contactAdd'), run: onAddContact } : null };
      }
      const missing = missingContactFields(primaryContact);
      const name = `${primaryContact.firstName || ''} ${primaryContact.lastName || ''}`.trim();
      return {
        text: missing.length ? t('onboarding.needsFor', { name, fields: fieldList(missing) }) : t('onboarding.contact.done', { name, title: primaryContact.title }),
        action: missing.length && canEditContacts ? { label: t('onboarding.action.contactEdit'), run: () => onEditContact(primaryContact) } : null,
      };
    }
    if (step === 'schedule') {
      if (st === STEP_STATE.unknown) return { text: t('onboarding.checking'), action: null };
      return {
        text: upcoming.length ? t('onboarding.schedule.done', { count: upcoming.length }) : t('onboarding.schedule.todo'),
        action: !upcoming.length && canEditJobs && location ? { label: t('onboarding.action.schedule'), run: () => setNewCleanOpen(true) } : null,
      };
    }
    if (step === 'cleaners') {
      if (st === STEP_STATE.unknown) return { text: t('onboarding.checking'), action: null };
      const names = [
        ...cleaners.slice(0, 3).map((c) => c.user.name),
        ...(cleaners.length > 3 ? [t('onboarding.cleaners.more', { count: cleaners.length - 3 })] : []),
      ];
      return {
        text: cleaners.length ? t('onboarding.cleaners.done', { count: cleaners.length, names }) : t('onboarding.cleaners.todo'),
        action: canEditTeam
          ? { label: t('onboarding.action.cleaners'), run: () => setCleanersOpen(true), quiet: cleaners.length > 0 }
          : null,
        note: !canEditTeam && !cleaners.length ? t('onboarding.cleaners.noTeam') : null,
      };
    }
    if (step === 'supplies') {
      if (!canViewSupplies) return { text: t('onboarding.supplies.noAccess'), action: null, noAccess: true };
      if (supply?.error) return { text: t('onboarding.checkFailed'), action: { label: t('common.retry'), run: supply.reload } };
      if (st === STEP_STATE.unknown) return { text: t('onboarding.checking'), action: null };
      const n = supply?.items?.length || 0;
      return {
        text: n ? t('onboarding.supplies.done', { count: n }) : t('onboarding.supplies.todo'),
        action: !n && canManageSupplies ? { label: t('onboarding.action.supplies'), run: () => onOpenTab('supplies', { edit: true }) } : null,
      };
    }
    if (step === 'special') {
      const services = specialServicesOf(client);
      const add = canEdit ? { label: t('onboarding.action.special'), run: () => setSpecialOpen(true), quiet: services.length > 0 || hasNoSpecialServices(client) } : null;
      if (services.length) {
        const names = [
          ...services.slice(0, 3).map((x) => x.type),
          ...(services.length > 3 ? [t('onboarding.special.more', { count: services.length - 3 })] : []),
        ];
        return { text: t('onboarding.special.done', { count: services.length, names }), action: add };
      }
      if (hasNoSpecialServices(client)) return { text: t('onboarding.special.none'), action: add };
      return {
        text: t('onboarding.special.todo'),
        action: add,
        second: canEdit ? { label: t('onboarding.action.specialNone'), run: markNoSpecial } : null,
      };
    }
    // documents
    if (!canViewContracts) return { text: t('onboarding.documents.noAccess'), action: null, noAccess: true };
    if (contractsRead?.error) return { text: t('onboarding.checkFailed'), action: { label: t('common.retry'), run: contractsRead.reload } };
    if (st === STEP_STATE.unknown) return { text: t('onboarding.checking'), action: null };
    return {
      text: st === STEP_STATE.done ? t('onboarding.documents.done') : t('onboarding.documents.todo'),
      action: st !== STEP_STATE.done ? { label: t('onboarding.action.documents'), run: () => onOpenTab('contract') } : null,
    };
  };

  const detail = detailFor(open);
  // The step's buttons re-centre when the open step or its state changes their row (components/Centred).
  const moved = `${open.step}|${open.state}`;
  const skipper = open.skip?.by ? selectUserById(state, open.skip.by) : null;

  return (
    <section className="card detail-card onb" aria-labelledby="onb-title">
      <div className="onb-head">
        <h3 id="onb-title">{finished ? t('onboarding.finishedTitle') : t('onboarding.title')}</h3>
        <span className="onb-count">{t('onboarding.count', { done: progress.done, total: progress.total })}</span>
      </div>
      <ol className="onb-bar">
        {steps.map((s) => (
          <li key={s.step}>
            <button
              type="button"
              className={`onb-seg is-${s.state}${s.step === open.step ? ' is-open' : ''}`}
              aria-pressed={s.step === open.step}
              aria-label={`${stepLabel(s.step)}: ${t(STEP_STATE_KEY[s.state])}`}
              onClick={() => setOpenStep(s.step)}
            >
              <span className="onb-seg-fill" aria-hidden />
              <span className="onb-seg-label" aria-hidden>{t(STEP_SEGMENT_KEY[s.step])}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="onb-step" aria-live="polite">
        <div className="onb-step-head">
          <span className="onb-step-title">{stepLabel(open.step)}</span>
          <Badge variant={STATE_VARIANT[open.state]}>{detail.noAccess && open.state === STEP_STATE.unknown ? t('onboarding.state.noAccess') : t(STEP_STATE_KEY[open.state])}</Badge>
        </div>
        <p className="text-sm text-muted">{detail.text}</p>
        {open.skip && (
          <p className="onb-skip-note">
            {skipper
              ? t('onboarding.skippedBy', { name: skipper.name, date: fmtDate(open.skip.at), note: open.skip.note })
              : t('onboarding.skippedOn', { date: fmtDate(open.skip.at), note: open.skip.note })}
          </p>
        )}
        {detail.note && <p className="text-xs text-muted">{detail.note}</p>}
        {!finished && (detail.action || (open.canSkip && canEdit && open.state !== STEP_STATE.done)) && (
          <div className="onb-actions">
            {detail.action && (
              <button type="button" className={`btn ${detail.action.quiet ? 'btn-outline' : 'btn-primary'}`} onClick={detail.action.run}><Centred watch={moved}>{detail.action.label}</Centred></button>
            )}
            {detail.second && (
              <button type="button" className="btn btn-outline" onClick={detail.second.run}><Centred watch={moved}>{detail.second.label}</Centred></button>
            )}
            {open.canSkip && canEdit && open.state !== STEP_STATE.done && (open.state === STEP_STATE.skipped
              ? <button type="button" className="btn btn-outline" onClick={() => unskip(open.step)}><Centred watch={moved}>{t('onboarding.unskip')}</Centred></button>
              : <button type="button" className="btn btn-outline" onClick={() => setSkipping(open.step)}><Centred watch={moved}>{t('onboarding.skip')}</Centred></button>)}
          </div>
        )}
      </div>

      {skipping && (
        <OnboardingSkipModal step={skipping} stepLabel={stepLabel(skipping)} onSkip={(note) => skip(skipping, note)} onClose={() => setSkipping(null)} />
      )}
      {newCleanOpen && (
        <NewJobModal open onClose={() => setNewCleanOpen(false)} presetClientId={client.id} presetSiteId={location?.id || null} />
      )}
      {cleanersOpen && (
        <OnboardingCleanersModal client={client} onClose={() => setCleanersOpen(false)} />
      )}
      {specialOpen && (
        <SpecialServiceModal client={client} onClose={() => setSpecialOpen(false)} />
      )}
    </section>
  );
}

// Skip with a note: the note is required (the reason the step can't be done yet).
function OnboardingSkipModal({ stepLabel, onSkip, onClose }) {
  const t = useT();
  const [note, setNote] = useState('');
  const trimmed = note.trim();
  return (
    <Modal open onClose={onClose} title={t('onboarding.skipTitle', { step: stepLabel })} centred>
      <p className="text-sm text-muted modal-intro">{t('onboarding.skipLead')}</p>
      <FormField label={t('onboarding.skipNote')}>
        <textarea
          className="input" rows={3} value={note} autoFocus maxLength={ONBOARDING_NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('onboarding.skipPlaceholder')}
        />
      </FormField>
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}><Centred>{t('common.cancel')}</Centred></button>
        <button type="button" className="btn btn-primary" onClick={() => onSkip(trimmed)} disabled={!trimmed}><Centred>{t('onboarding.skipConfirm')}</Centred></button>
      </div>
    </Modal>
  );
}

// The Assigned cleaners step: pick the cleaners who work at this building (their Works at, the link
// the office keeps on their Team page — it puts no one on a clean), or add a new team member with
// this building already in their Works at (Add Team Member, task 470).
function OnboardingCleanersModal({ client, onClose }) {
  const t = useT();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const crew = useMemo(() => (state.users || []).filter((u) => u.role === 'crew' && u.status !== 'disabled'), [state.users]);
  const linkedNow = useMemo(() => crew.filter((u) => worksAtOf(u).includes(client.id)).map((u) => u.id), [crew, client.id]);
  const [picked, setPicked] = useState(linkedNow);
  const [addOpen, setAddOpen] = useState(false);
  const initial = useMemo(() => ({ role: 'crew', worksAt: [client.id] }), [client.id]);
  // A cleaner linked while this is open (Add a new team member saves them with this building in
  // their Works at) joins the picked ones, so Save never takes them off again.
  const seen = useRef(linkedNow);
  useEffect(() => {
    const fresh = linkedNow.filter((id) => !seen.current.includes(id));
    seen.current = linkedNow;
    if (fresh.length) setPicked((p) => [...p, ...fresh.filter((id) => !p.includes(id))]);
  }, [linkedNow]);

  // Only who was picked or unpicked here changes.
  const save = () => {
    const want = new Set(picked);
    for (const u of crew) {
      const has = worksAtOf(u).includes(client.id);
      if (has === want.has(u.id)) continue;
      const worksAt = has ? worksAtOf(u).filter((id) => id !== client.id) : [...worksAtOf(u), client.id];
      dispatch({ type: ACTIONS.UPDATE_USER, id: u.id, patch: { worksAt } });
    }
    toast.success(t('onboarding.cleaners.saved'));
    onClose();
  };

  return (
    <>
      <Modal open={!addOpen} onClose={onClose} title={t(STEP_TITLE_KEY.cleaners)} centred>
        <p className="text-sm text-muted modal-intro">{t('onboarding.cleaners.lead')}</p>
        <FormField label={t('onboarding.cleaners.pick')}>
          <CrewPicker value={picked} onChange={setPicked} pool={crew} />
        </FormField>
        <div className="modal-actions onb-cleaners-actions">
          <button type="button" className="btn btn-outline onb-cleaners-add" onClick={() => setAddOpen(true)}><Centred>{t('onboarding.cleaners.addNew')}</Centred></button>
          <button type="button" className="btn btn-outline" onClick={onClose}><Centred>{t('common.cancel')}</Centred></button>
          <button type="button" className="btn btn-primary" onClick={save}><Centred>{t('onboarding.cleaners.save')}</Centred></button>
        </div>
      </Modal>
      <AddUserModal open={addOpen} onClose={() => setAddOpen(false)} initial={initial} />
    </>
  );
}
