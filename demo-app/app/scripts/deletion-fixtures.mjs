// deletion-fixtures.mjs — deterministic witness rows for the deletion-ripple harness.
//
// The anti-vacuous-pass rule (BUILD_INTEGRITY): a delete cascade tested against seed
// that happens to have no referencing row passes for the wrong reason. Seed leaves many
// slices empty (payrollLines, reimbursements, inspectionFollowUps, invitations, …), so
// every manifest cell is witnessed here by a STATIC `fx_`-prefixed row that references a
// known victim. Fixtures make coverage day-independent (no reliance on seed date logic)
// and force the enumerator to surface empty-slice cells so they get classified too.
//
// enrichState(state) is additive: it appends witnesses to a CLONE's slices. Victims:
//   fx_v_user  (a crew member — not the last owner, so DELETE_USER proceeds)
//   … more targets added as the harness grows.

export const VICTIMS = {
  users: { id: 'fx_v_user', email: null },
  usersPaid: { id: 'fx_v_user_paid', email: null },
  usersHist: { id: 'fx_v_user_hist', email: null },
  clients: { id: 'fx_v_client', email: null },
  contacts: { id: 'fx_v_contact', email: 'fx-victim-contact@example.test' },
  tags: { id: 'fx_v_tag', email: null },
};

// Scenarios drive the runner: dispatch <action> deleting <victimId>, then verdict the
// listed cells (or every cell whose target === target when cells === 'target'). expect
// 'delete' (guard clears) or 'block' (guard fires — the ref legitimately survives).
export const SCENARIOS = [
  { target: 'users', action: 'DELETE_USER', victimId: 'fx_v_user', expect: 'delete', cells: 'target' },
  // guarded: DELETE_USER refuses while the user may still be owed pay …
  { target: 'users', action: 'DELETE_USER', victimId: 'fx_v_user_paid', expect: 'block', cells: ['payrollLines[].userId', 'reimbursements[].userId'] },
  // … and proceeds when all their pay is settled history, which survives as a record.
  { target: 'users', action: 'DELETE_USER', victimId: 'fx_v_user_hist', expect: 'delete', cells: ['payrollLines[].userId', 'reimbursements[].userId'] },
  // guarded: a pay line that pays out an approved reimbursement can't be deleted on its
  // own (it's undone from HR, where removing the reimbursement takes the line).
  { target: 'payrollLines', action: 'DELETE_PAYROLL_LINE', victimId: 'fx_pl_hist', expect: 'block', cells: ['reimbursements[].payrollLineId'] },
  { target: 'clients', action: 'DELETE_CLIENT', victimId: 'fx_v_client', expect: 'delete', cells: 'target' },
  { target: 'contacts', action: 'DELETE_CONTACT', victimId: 'fx_v_contact', expect: 'delete', cells: 'target' },
  { target: 'tags', action: 'DELETE_TAG', victimId: 'fx_v_tag', expect: 'delete', cells: 'target' },
  // Hard template delete (no archive): the server drops the inspection_templates record;
  // the reducer's SCRUB_CHECKLIST_TEMPLATE ripple must drop every per-cleaner binding to it
  // (crewChecklists value dropped). R3 (2026-09-27) retired the location-wide default, so the
  // per-cleaner map is the only binding left. The fx_wc_user witness references fx_tmpl there.
  { target: 'checklistTemplates', action: 'SCRUB_CHECKLIST_TEMPLATE', victimId: 'fx_tmpl', expect: 'delete',
    payload: { templateId: 'fx_tmpl' }, cells: ['clients[].crewChecklists.{value}'] },
  { target: 'jobs', action: 'DELETE_JOB', victimId: 'fx_v_job', expect: 'delete', cells: ['reminderEvents[].jobId', 'invoices[].jobIds', 'timeOff[].scheduledJobIds'] },
  { target: 'services', action: 'DELETE_SERVICE', victimId: 'fx_v_service', expect: 'delete', cells: 'target' },
  { target: 'frequencies', action: 'DELETE_FREQUENCY', victimId: 'fx_v_freq', expect: 'delete', cells: 'target' },
  { target: 'keys', action: 'DELETE_KEY', victimId: 'fx_v_key', expect: 'delete', cells: 'target' },
  { target: 'conversations', action: 'DELETE_CONVERSATION', victimId: 'fx_v_conv', expect: 'delete', cells: 'target' },
  { target: 'snippets', action: 'DELETE_SNIPPET', victimId: 'fx_v_snip', expect: 'delete', cells: 'target' },
  { target: 'supplyItems', action: 'DELETE_SUPPLY_ITEM', victimId: 'fx_v_si', expect: 'delete', cells: 'target' },
  { target: 'marketingInboxes', action: 'REMOVE_MARKETING_INBOX', victimId: 'fx_v_mi', expect: 'delete', cells: 'target' },
  { target: 'marketingSequences', action: 'DELETE_MARKETING_SEQUENCE', victimId: 'fx_v_mseq', expect: 'delete', extraVictimIds: ['fx_menr_mseq'],
    cells: ['marketingEnrollments[].sequenceId', 'marketingSends[].sequenceId', 'marketingReplies[].sequenceId', 'marketingSends[].enrollmentId', 'marketingReplies[].enrollmentId'] },
  // guarded: REMOVE_OAUTH_WORKSPACE refuses while ANY inbox references the workspace
  { target: 'oauthWorkspaces', action: 'REMOVE_OAUTH_WORKSPACE', victimId: 'fx_v_ws', expect: 'block',
    cells: ['connectedInboxes[].workspaceId', 'marketingInboxes[].workspaceId'] },
  // guarded: DELETE_PIPELINE blocks while an opportunity sits on it (armed) …
  { target: 'pipelines', action: 'DELETE_PIPELINE', victimId: 'fx_v_pipe_armed', expect: 'block', cells: ['opportunities[].pipelineId'] },
  // … and proceeds (repointing activePipelineId) when none does (free)
  { target: 'pipelines', action: 'DELETE_PIPELINE', victimId: 'fx_v_pipe_free', expect: 'delete',
    cells: ['$.activePipelineId', 'marketingSequences[].replyRouting.pipelineId', 'marketingSettings.replyRouting.pipelineId'] },
  // sites have no standalone delete — they die with their client (DELETE_CLIENT). Track
  // the SITE id while deleting its client so the site-referencing cells are verdicted.
  { target: 'sites', deleteFrom: 'clients', action: 'DELETE_CLIENT', victimId: 'fx_v_client', extraVictimIds: ['fx_st_client'],
    expect: 'delete', cells: ['jobs[].siteId', 'invoices[].siteId', 'keys[].siteId'] },
  // nested step delete (marketingSends.stepId is historical → KEPT)
  { target: 'marketingSequences.steps', deleteFrom: 'marketingSequences', action: 'DELETE_MARKETING_STEP',
    victimId: 'fx_step', extraVictimIds: ['fx_step'], payload: { sequenceId: 'fx_mseq_step', stepId: 'fx_step' },
    expect: 'delete', cells: ['marketingSends[].stepId'] },
  // path-embedded deep-link ids (notifications[].url) — one polymorphic cell, verdicted
  // under each target whose id its url can carry (adversarial-pass finding).
  { target: 'notifications', deleteFrom: 'conversations', action: 'DELETE_CONVERSATION', victimId: 'fx_v_conv', expect: 'delete', cells: ['notifications[].url'] },
  { target: 'notifications', deleteFrom: 'clients', action: 'DELETE_CLIENT', victimId: 'fx_v_client', expect: 'delete', cells: ['notifications[].url'] },
  { target: 'notifications', deleteFrom: 'jobs', action: 'DELETE_JOB', victimId: 'fx_v_job', expect: 'delete', cells: ['notifications[].url'] },
];

// append helper: ensure state[key] is an array and push rows
function push(state, key, ...rows) {
  state[key] = [...(state[key] || []), ...rows];
}

export function enrichState(state) {
  const s = state; // caller passes a clone
  const U = VICTIMS.users.id;

  // the victim user — crew role so isLastOwner is false and the delete is allowed
  push(s, 'users', { id: U, name: 'FX Victim User', email: 'fx-victim@example.test', role: 'crew', status: 'active', hr: {} });

  // ── every users-referencing cell gets a witness that points at U ──
  // clients: supervisorId + crewChecklists map-key (+ a value → a template, added below)
  push(s, 'clients', {
    id: 'fx_wc_user', name: 'FX Witness Account', type: 'customer', tagIds: [],
    supervisorId: U, crewChecklists: { [U]: 'fx_tmpl' },
  });
  // a checklist template so crewChecklists.{value} resolves to a real id
  push(s, 'checklistTemplates', { id: 'fx_tmpl', name: 'FX Template', sections: [] });

  push(s, 'connectedInboxes', { id: 'fx_ci_user', userId: U, workspaceId: 'fx_ws_x', provider: 'google', status: 'active' });

  // Name-keeping witnesses start with NO stored name (as live rows do), so the harness's
  // "+NAME" check proves the delete STAMPED it rather than finding it already there.
  push(s, 'conversations', {
    id: 'fx_cv_user', createdByUserId: U, createdByName: null,
    mutedByUserIds: [U], participantUserIds: [U], starredByUserIds: [U], contactId: null, clientId: null,
  });
  push(s, 'messages', {
    id: 'fx_m_user', conversationId: 'fx_cv_user', authorUserId: U, authorName: null,
    readByUserIds: [U], body: 'fx',
  });

  push(s, 'keyEvents', { id: 'fx_kev_user', keyId: 'fx_key_user', byUserId: U, holderUserId: U, holderName: null, type: 'checkout' });
  push(s, 'keys', { id: 'fx_key_user', clientId: null, siteId: null, heldByUserId: U, heldByName: null, status: 'out' });

  push(s, 'marketingInboxes', { id: 'fx_mi_user', connectedByUserId: U, workspaceId: 'fx_ws_y', email: 'fx@example.test', rotationOrder: 99 });
  push(s, 'marketingSequences', { id: 'fx_mseq_user', createdByUserId: U, notifyOnReplyUserId: U, steps: [], replyTags: [] });

  push(s, 'supplyRequests', {
    id: 'fx_sr_user', clientId: null, requestedByUserId: U, completedByUserId: U, lines: [], status: 'completed',
  });

  push(s, 'timeOff', { id: 'fx_to_user', userId: U, createdBy: U, startDate: '2026-01-01', endDate: '2026-01-01', reason: 'fx' });

  push(s, 'jobs', {
    id: 'fx_j_user', clientId: null, siteId: null, serviceId: null, crewIds: [U], tagIds: [],
    status: 'upcoming', startAt: '2026-01-01T10:00:00.000Z',
  });
  // A cover (R8, `job.coverFor = { [coverId]: coveredId }`) names TWO users, and the COVERED
  // one is deliberately NOT on the visit — so a crew-membership sweep cannot see them. Two
  // witnesses, one per side, or DELETE_USER would leave the cover pointing at a cleaner who
  // no longer exists and the cover would fill their checklist forever.
  push(s, 'jobs', {
    id: 'fx_j_cover_by', clientId: null, siteId: null, serviceId: null, crewIds: [U], tagIds: [],
    status: 'upcoming', startAt: '2026-01-01T12:00:00.000Z',
    oneOff: { crew: true }, coverFor: { [U]: 'fx_v_user_hist' },
  });
  push(s, 'jobs', {
    id: 'fx_j_cover_for', clientId: null, siteId: null, serviceId: null, crewIds: ['fx_v_user_hist'], tagIds: [],
    status: 'upcoming', startAt: '2026-01-01T14:00:00.000Z',
    oneOff: { crew: true }, coverFor: { fx_v_user_hist: U },
  });

  // empty-in-seed user slices — the anti-vacuous-pass witnesses
  push(s, 'userPermissionOverrides', { userId: U, grants: ['contacts.view'], revokes: [] });
  push(s, 'employeeDocuments', { id: 'fx_edoc_user', userId: U, name: 'fx.pdf' });
  push(s, 'invitations', { id: 'fx_inv_user', userId: U, invitedBy: U, token: 'fx', status: 'pending' });
  push(s, 'inspectionFollowUps', { id: 'fx_ifu_user', inspectionId: 'fx_insp', assigneeUserId: U, updatedBy: U, done: false });
  push(s, 'notifications', { id: 'fx_nt_user', userId: U, eventKey: 'fx', url: '/x' });
  push(s, 'opportunities', { id: 'fx_opp_user', clientId: null, pipelineId: null, primaryContactId: null, ownerUserId: U, status: 'open' });
  push(s, 'contactActivities', { id: 'fx_act_user', contactId: null, authorUserId: U, kind: 'note' });
  push(s, 'clientActivities', { id: 'fx_clact_user', clientId: null, authorUserId: U, kind: 'note' });

  // A SECOND user victim carrying UNSETTLED money — DELETE_USER must BLOCK (DR-18/19).
  // Kept isolated (only pay witnesses) so its blocked delete verdicts the two pay cells
  // without entangling the sweep cells above. The far-future periodKey is always at or
  // after the pay-period cutoff and 'pending' blocks at any date, so this stays
  // deterministic whatever day the suite runs.
  const UP = VICTIMS.usersPaid.id;
  push(s, 'users', { id: UP, name: 'FX Paid Victim', email: 'fx-paid@example.test', role: 'crew', status: 'active', hr: {} });
  push(s, 'payrollLines', { id: 'fx_pl_paid', userId: UP, periodKey: '2099-01-01', kind: 'earning', category: 'special', amount: 50 });
  push(s, 'reimbursements', { id: 'fx_rmb_paid', userId: UP, amount: 20, status: 'pending', periodKey: '2099-01-01' });

  // A THIRD user victim whose pay is all SETTLED history (a line in a long-closed period +
  // an approved reimbursement). DELETE_USER must PROCEED — the old guard blocked any line
  // ever, making such employees permanently undeletable — and the history survives.
  const UH = VICTIMS.usersHist.id;
  push(s, 'users', { id: UH, name: 'FX History Victim', email: 'fx-hist@example.test', role: 'crew', status: 'active', hr: {} });
  // Realistic pay links: the approved reimbursement's own pay line (payrollLineId — what
  // approving in HR creates), and the manager (U) who created/submitted/decided the rows,
  // so the enumerator surfaces those fields and DELETE_USER(U) is checked against them.
  push(s, 'payrollLines', { id: 'fx_pl_hist', userId: UH, periodKey: '2000-01-01', kind: 'earning', category: 'reimbursement', amount: 20, taxable: false, createdBy: U, note: 'reimbursement fx_rmb_hist' });
  push(s, 'reimbursements', { id: 'fx_rmb_hist', userId: UH, amount: 20, status: 'approved', periodKey: '2000-01-01', payrollLineId: 'fx_pl_hist', submittedBy: U, decidedBy: U });

  // ── clients target (DELETE_CLIENT) ──
  const C = VICTIMS.clients.id;
  push(s, 'clients', { id: C, name: 'FX Victim Account', type: 'customer', tagIds: [], primaryContactId: null });
  push(s, 'contacts', { id: 'fx_ct_client', email: 'fx-ctc@example.test', companyId: C, tagIds: [] });
  push(s, 'conversations', { id: 'fx_cv_client', clientId: C, contactId: null, participantUserIds: [] });
  push(s, 'invoices', { id: 'fx_inv_client', clientId: C, siteId: 'fx_st_client', billingContactId: null, jobIds: ['fx_j_client'] });
  push(s, 'jobs', { id: 'fx_j_client', clientId: C, siteId: 'fx_st_client', serviceId: null, crewIds: [], tagIds: [], status: 'upcoming', startAt: '2026-01-02T10:00:00.000Z' });
  push(s, 'keys', { id: 'fx_key_client', clientId: C, siteId: 'fx_st_client', clientName: 'FX Victim Account', heldByUserId: null });
  push(s, 'opportunities', { id: 'fx_opp_client', clientId: C, pipelineId: null, primaryContactId: null, status: 'open' });
  // a reminder for the client's OWN job — DELETE_CLIENT scrubs reminderEvents by the
  // client's jobId, so clientId rides out with it (realistic link, not a manufactured dangle).
  push(s, 'reminderEvents', { id: 'fx_re_client', clientId: C, jobId: 'fx_j_client', templateKey: 'fx' });
  // a bell row whose deep-link embeds the client id — DELETE_CLIENT sweeps /schedule/ urls
  // but NOT /clients/ urls, so this dangles (adversarial finding).
  push(s, 'notifications', { id: 'fx_nt_client', userId: null, eventKey: 'fx', url: `/clients/${C}` });
  push(s, 'sites', { id: 'fx_st_client', clientId: C, siteContactId: null, tagIds: [] });
  push(s, 'supplyItems', { id: 'fx_si_client', clientId: C, name: 'FX supply' });
  push(s, 'supplyRequests', { id: 'fx_sr_client', clientId: C, lines: [], status: 'open' });
  push(s, 'clientActivities', { id: 'fx_clact_client', clientId: C, authorUserId: null, kind: 'note' });

  // ── contacts target (DELETE_CONTACT; email is the alt key) ──
  const K = VICTIMS.contacts.id;
  const KE = VICTIMS.contacts.email;
  push(s, 'contacts', { id: K, email: KE, companyId: null, tagIds: [] });
  push(s, 'clients', { id: 'fx_wc_contact', name: 'FX Contact-Ref Account', type: 'customer', tagIds: [], primaryContactId: K, billingContactId: K });
  push(s, 'invoices', { id: 'fx_inv_contact', clientId: null, billingContactId: K, jobIds: [] });
  push(s, 'sites', { id: 'fx_st_contact', clientId: null, siteContactId: K, tagIds: [] });
  push(s, 'opportunities', { id: 'fx_opp_contact', clientId: null, primaryContactId: K, status: 'open' });
  push(s, 'conversations', { id: 'fx_cv_contact', clientId: null, contactId: K, participantUserIds: [] });
  push(s, 'contactActivities', { id: 'fx_act_contact', contactId: K, authorUserId: null, kind: 'note' });
  push(s, 'marketingEnrollments', { id: 'fx_menr_contact', contactId: K, sequenceId: null });
  push(s, 'marketingSends', { id: 'fx_msnd_contact', contactId: K, toEmail: KE, enrollmentId: 'fx_menr_contact', sequenceId: null });
  push(s, 'marketingReplies', { id: 'fx_mrep_contact', contactId: K, fromEmail: KE, enrollmentId: 'fx_menr_contact', sequenceId: null });
  // an enrollment-less inbound reply: DELETE_CONTACT can't sweep it (no contactId/enrollmentId)
  // so fromEmail survives as provenance — the honest KEEP-BY-DESIGN witness.
  push(s, 'marketingReplies', { id: 'fx_mrep_orphan', contactId: null, fromEmail: KE, enrollmentId: null, sequenceId: null });
  push(s, 'messages', { id: 'fx_m_contact', conversationId: 'fx_cv_contact', fromEmail: KE, body: 'fx inbound' });

  // ── tags target (DELETE_TAG) ──
  const T = VICTIMS.tags.id;
  push(s, 'tags', { id: T, label: 'FX Tag', scope: 'all', color: 'slate' });
  push(s, 'clients', { id: 'fx_wc_tag', name: 'FX Tag Account', type: 'customer', tagIds: [T] });
  push(s, 'contacts', { id: 'fx_ct_tag', email: 'fx-ctt@example.test', companyId: null, tagIds: [T] });
  push(s, 'jobs', { id: 'fx_j_tag', clientId: null, siteId: null, serviceId: null, crewIds: [], tagIds: [T], status: 'upcoming', startAt: '2026-01-03T10:00:00.000Z' });
  push(s, 'sites', { id: 'fx_st_tag', clientId: null, siteContactId: null, tagIds: [T] });
  push(s, 'marketingSequences', { id: 'fx_mseq_tag', createdByUserId: null, notifyOnReplyUserId: null, steps: [], replyTags: [T] });

  // ── jobs target (DELETE_JOB) ──
  const J = 'fx_v_job';
  push(s, 'jobs', { id: J, clientId: null, siteId: null, serviceId: null, crewIds: [], tagIds: [], status: 'upcoming', startAt: '2026-01-05T10:00:00.000Z' });
  push(s, 'reminderEvents', { id: 'fx_re_job', clientId: null, jobId: J, templateKey: 'fx' });
  push(s, 'invoices', { id: 'fx_inv_job', clientId: null, billingContactId: null, jobIds: [J] });
  push(s, 'notifications', { id: 'fx_nt_job', userId: null, eventKey: 'fx', url: `/schedule/${J}` });
  // A call-out keeps the ids of the cleans it took the person off (Reports › Called out).
  push(s, 'timeOff', { id: 'fx_to_job', userId: null, createdBy: null, startDate: '2026-01-05', endDate: '2026-01-05', reason: 'fx', kind: 'callout', scheduledJobIds: [J] });

  // ── services / frequencies ──
  const SV = 'fx_v_service';
  push(s, 'services', { id: SV, name: 'FX Service' });
  push(s, 'clients', { id: 'fx_wc_svc', name: 'FX Svc Account', type: 'customer', tagIds: [], serviceId: SV });
  push(s, 'jobs', { id: 'fx_j_svc', clientId: null, siteId: null, serviceId: SV, crewIds: [], tagIds: [], status: 'upcoming', startAt: '2026-01-06T10:00:00.000Z' });
  const FR = 'fx_v_freq';
  push(s, 'frequencies', { id: FR, name: 'FX Frequency' });
  push(s, 'clients', { id: 'fx_wc_freq', name: 'FX Freq Account', type: 'customer', tagIds: [], frequencyId: FR });

  // ── keys target (DELETE_KEY) ──
  const KY = 'fx_v_key';
  push(s, 'keys', { id: KY, clientId: null, siteId: null, heldByUserId: null, status: 'in' });
  push(s, 'keyEvents', { id: 'fx_kev_key', keyId: KY, byUserId: null, holderUserId: null, type: 'checkin' });

  // ── conversations target (DELETE_CONVERSATION) ──
  const CV = 'fx_v_conv';
  push(s, 'conversations', { id: CV, clientId: null, contactId: null, participantUserIds: [] });
  push(s, 'messages', { id: 'fx_m_conv', conversationId: CV, body: 'fx' });
  // a bell row deep-linking to the conversation — DELETE_CONVERSATION never scrubs it.
  push(s, 'notifications', { id: 'fx_nt_conv', userId: null, eventKey: 'fx', url: `/messaging/${CV}` });

  // ── snippets target (DELETE_SNIPPET) ──
  const SN = 'fx_v_snip';
  push(s, 'snippets', { id: SN, title: 'FX Snippet', body: 'fx' });
  push(s, 'messages', { id: 'fx_m_snip', conversationId: 'fx_v_conv', snippetId: SN, body: 'fx' });

  // ── supplyItems target (DELETE_SUPPLY_ITEM) ──
  const SI = 'fx_v_si';
  push(s, 'supplyItems', { id: SI, clientId: null, name: 'FX Item' });
  push(s, 'supplyRequests', { id: 'fx_sr_item', clientId: null, lines: [{ itemId: SI, name: 'FX Item', qty: 1 }], status: 'open' });

  // ── marketingInboxes target (REMOVE_MARKETING_INBOX) ──
  const MI = 'fx_v_mi';
  push(s, 'marketingInboxes', { id: MI, connectedByUserId: null, workspaceId: null, email: 'fx-mi@example.test', rotationOrder: 98 });
  push(s, 'marketingSends', { id: 'fx_msnd_inbox', contactId: null, inboxId: MI, enrollmentId: null, sequenceId: null, toEmail: null });

  // ── marketingSequences target (DELETE_MARKETING_SEQUENCE) ──
  const MSEQ = 'fx_v_mseq';
  const MENR = 'fx_menr_mseq';
  push(s, 'marketingSequences', { id: MSEQ, createdByUserId: null, notifyOnReplyUserId: null, steps: [], replyTags: [] });
  push(s, 'marketingEnrollments', { id: MENR, contactId: null, sequenceId: MSEQ });
  push(s, 'marketingSends', { id: 'fx_msnd_seq', contactId: null, sequenceId: MSEQ, enrollmentId: MENR, inboxId: null, toEmail: null });
  push(s, 'marketingReplies', { id: 'fx_mrep_seq', contactId: null, sequenceId: MSEQ, enrollmentId: MENR, fromEmail: null });

  // ── oauthWorkspaces target (REMOVE_OAUTH_WORKSPACE, guarded — armed by inbox refs) ──
  const WS = 'fx_v_ws';
  push(s, 'oauthWorkspaces', { id: WS, clientId: 'google-oauth-client-id', label: 'FX Workspace' });
  push(s, 'connectedInboxes', { id: 'fx_ci_ws', userId: null, workspaceId: WS, provider: 'google', status: 'active' });
  push(s, 'marketingInboxes', { id: 'fx_mi_ws', connectedByUserId: null, workspaceId: WS, email: 'fx-ws@example.test', rotationOrder: 97 });

  // ── pipelines target (DELETE_PIPELINE, guarded) ──
  const PA = 'fx_v_pipe_armed';
  const PF = 'fx_v_pipe_free';
  push(s, 'pipelines', { id: PA, name: 'FX Armed Pipeline', isMaster: false, stages: [] });
  push(s, 'opportunities', { id: 'fx_opp_pipe', clientId: null, pipelineId: PA, primaryContactId: null, status: 'open' });
  push(s, 'pipelines', { id: PF, name: 'FX Free Pipeline', isMaster: false, stages: [] });
  push(s, 'marketingSequences', { id: 'fx_mseq_pipe', createdByUserId: null, notifyOnReplyUserId: null, steps: [], replyTags: [], replyRouting: { pipelineId: PF, stageKey: null } });
  // the free pipeline is the active one, so DELETE_PIPELINE must repoint activePipelineId
  s.activePipelineId = PF;
  s.marketingSettings = { ...(s.marketingSettings || {}), replyRouting: { ...((s.marketingSettings || {}).replyRouting || {}), pipelineId: PF, stageKey: null } };

  // ── marketingSequences.steps target (DELETE_MARKETING_STEP) ──
  push(s, 'marketingSequences', { id: 'fx_mseq_step', createdByUserId: null, notifyOnReplyUserId: null, steps: [{ id: 'fx_step', order: 0, label: 'FX Step' }], replyTags: [] });
  push(s, 'marketingSends', { id: 'fx_msnd_step', contactId: null, sequenceId: 'fx_mseq_step', stepId: 'fx_step', enrollmentId: null, inboxId: null, toEmail: null });

  return s;
}
