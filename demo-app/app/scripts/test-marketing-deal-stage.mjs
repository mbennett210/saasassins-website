// Marketing targets a company's DEAL stage, not a per-person pipeline stage.
//
// After the pipeline rework a person is never on a pipeline; deals are company
// Opportunities at Master-pipeline stages. This pins the retarget:
//   1. getDueEnrollments auto-enrolls the primary contact of every OPEN deal at a
//      source stage (and nobody when the deal is at a different stage).
//   2. getStaleEnrollments unenrolls an auto row once its deal leaves the source stage.
//   3. contactIdsAtSourceStages resolves the deal's primary contact.
//   4. (source) RECEIVE_MARKETING_REPLY advances the company deal, never a person.
//
//   node scripts/test-marketing-deal-stage.mjs
// The scheduler imports cleanly under Node (all .js-extensioned), so 1-3 run live.
// The reducer uses Vite extensionless imports, so 4 is asserted against its source.
import { readFileSync } from 'node:fs';
import {
  getDueEnrollments, getStaleEnrollments, contactIdsAtSourceStages,
} from '../src/lib/marketingScheduler.js';

let fails = 0;
const ok = (name, cond) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) fails++; };

const master = { id: 'pl_master', isMaster: true, stages: [
  { key: 'new-lead', label: 'New Lead' }, { key: 'proposal', label: 'Proposal' },
  { key: 'won', label: 'Won' }, { key: 'lost', label: 'Lost' },
] };
const base = () => ({
  activePipelineId: 'pl_master',
  pipelines: [master],
  clients: [{ id: 'cl1', name: 'Acme', primaryContactId: 'ct1' }],
  contacts: [{ id: 'ct1', firstName: 'Ann', email: 'ann@acme.com', companyId: 'cl1' }],
  opportunities: [{ id: 'opp1', clientId: 'cl1', primaryContactId: 'ct1', stage: 'proposal', pipelineId: 'pl_master', status: 'open' }],
  marketingSequences: [{
    id: 'seq1', name: 'Nurture', status: 'active', audienceMode: 'auto', onStageExit: 'unenroll',
    enrollmentSources: [{ kind: 'pipelineStage', pipelineId: 'pl_master', stageKey: 'proposal' }],
    steps: [{ id: 's1', order: 0, subject: 'Hi', body: 'x' }],
    replyRouting: { enabled: true, pipelineId: 'pl_master', stageKey: 'won' }, haltOnReply: true,
  }],
  marketingEnrollments: [], marketingReplies: [], marketingSends: [],
  marketingInboxes: [], marketingSuppressions: [], contactActivities: [], clientActivities: [],
});

// 1 + 3. Auto-enroll targets the deal's primary contact.
{
  const ids = contactIdsAtSourceStages(base(), [{ kind: 'pipelineStage', pipelineId: 'pl_master', stageKey: 'proposal' }]);
  ok('contactIdsAtSourceStages resolves the deal primary contact', ids.has('ct1') && ids.size === 1);

  const b = getDueEnrollments(base()).find((x) => x.sequenceId === 'seq1');
  ok('getDueEnrollments enrolls the deal primary contact', !!b && b.contactIds.includes('ct1'));

  const s = base(); s.opportunities[0].stage = 'new-lead';
  ok('nobody enrolls when the deal is at another stage', !getDueEnrollments(s).find((x) => x.sequenceId === 'seq1'));

  const closed = base(); closed.opportunities[0].status = 'won';
  ok('a closed (non-open) deal enrolls nobody', !getDueEnrollments(closed).find((x) => x.sequenceId === 'seq1'));
}

// 2. Stale-unenroll once the deal leaves the source stage.
{
  const s = base();
  s.marketingEnrollments = [{ id: 'enr1', sequenceId: 'seq1', contactId: 'ct1', status: 'active', source: 'auto' }];
  ok('not stale while the deal is at the source stage', getStaleEnrollments(s).length === 0);
  s.opportunities[0].stage = 'new-lead';
  const stale = getStaleEnrollments(s);
  ok('stale once the deal leaves the source stage', stale.length === 1 && stale[0].id === 'enr1');

  const manual = base();
  manual.opportunities[0].stage = 'new-lead';
  manual.marketingEnrollments = [{ id: 'enr2', sequenceId: 'seq1', contactId: 'ct1', status: 'active', source: 'manual' }];
  ok('a manually-added enrollment is never stale-unenrolled', getStaleEnrollments(manual).length === 0);
}

// 4. (source) The reducer's reply-routing advances the company DEAL, not a person.
{
  const reducer = readFileSync(new URL('../src/store/reducer.js', import.meta.url), 'utf8');
  const reply = (reducer.match(/case ACTIONS\.RECEIVE_MARKETING_REPLY:[\s\S]*?\n    case ACTIONS\./) || [])[0] || '';
  ok('the reply case was found', reply.length > 0);
  ok('reply-routing advances an opportunity', /nextOpportunities\s*=\s*nextOpportunities\.map/.test(reply));
  ok('reply-routing logs on the company timeline', /Deal stage:/.test(reply));
  // The removed per-person write promoted the contact's lifecycle from the stage key.
  ok('reply-routing no longer promotes a contact lifecycle', !/lifecycle:\s*rr\.stageKey/.test(reply));
  ok('SET_CONTACT_STAGE is gone entirely', !/SET_CONTACT_STAGE/.test(reducer));
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'} — ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
