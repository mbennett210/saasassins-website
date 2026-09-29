// Unit test for app/src/lib/pipelines.js — the placement invariant that stops an
// opportunity from "vanishing into oblivion" (saved onto no board). Pins the pure
// rules the SET_OPPORTUNITY_STAGE reducer guard, the orphan selector, and the stage
// editor all share.
//   node app/scripts/test-pipeline-placement.mjs
import { stageExistsOnPipeline, isValidPlacement, isOrphanedOpportunity } from '../src/lib/pipelines.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.error('  FAIL', name); } };

// The Master pipeline now carries real stages (it is a normal board, not the old
// roll-up whose only column was an implicit intake), so nothing about it is special
// here. A second pipeline exercises the multi-pipeline and stale-pipeline paths.
const sales = { id: 'pl_sales', label: 'Sales', stages: [{ key: 'lead' }, { key: 'won' }, { key: 'lost' }] };
const master = { id: 'pl_master', isMaster: true, stages: [{ key: 'new-lead' }, { key: 'won' }, { key: 'lost' }] };
const pipelines = [sales, master];

// ── stageExistsOnPipeline ──
{
  ok('stage exists on its pipeline', stageExistsOnPipeline(sales, 'lead') === true);
  ok('unknown stage does not exist', stageExistsOnPipeline(sales, 'nope') === false);
  ok('empty stage never exists', stageExistsOnPipeline(sales, '') === false);
  ok('the Master pipeline accepts its own real stage keys', stageExistsOnPipeline(master, 'new-lead') === true);
  ok("the old implicit 'intake' key is no longer special", stageExistsOnPipeline(master, 'intake') === false);
  ok('null pipeline → false', stageExistsOnPipeline(null, 'lead') === false);
  ok('undefined stage → false', stageExistsOnPipeline(sales, undefined) === false);
}

// ── isValidPlacement ──
{
  ok('off-pipeline (both empty) is valid', isValidPlacement(pipelines, '', '') === true);
  ok('both null is valid', isValidPlacement(pipelines, null, null) === true);
  ok('pipeline + real stage is valid', isValidPlacement(pipelines, 'pl_sales', 'lead') === true);
  ok('Master + a real Master stage is valid', isValidPlacement(pipelines, 'pl_master', 'new-lead') === true);
  ok('pipeline without a stage is INVALID (half-state)', isValidPlacement(pipelines, 'pl_sales', '') === false);
  ok('stage without a pipeline is INVALID (half-state)', isValidPlacement(pipelines, '', 'lead') === false);
  ok('pipeline + stale stage is INVALID', isValidPlacement(pipelines, 'pl_sales', 'walkthrough') === false);
  ok('nonexistent pipeline is INVALID', isValidPlacement(pipelines, 'pl_gone', 'lead') === false);
  ok("Master + a stage it doesn't declare is INVALID", isValidPlacement(pipelines, 'pl_master', 'lead') === false);
}

// ── isOrphanedOpportunity — the already-vanished rows the banner recovers ──
{
  ok('a valid placement is not orphaned', isOrphanedOpportunity(pipelines, { pipelineId: 'pl_sales', stage: 'lead' }) === false);
  ok('a stale stage key IS orphaned', isOrphanedOpportunity(pipelines, { pipelineId: 'pl_sales', stage: 'walkthrough' }) === true);
  ok('a deleted pipeline IS orphaned', isOrphanedOpportunity(pipelines, { pipelineId: 'pl_gone', stage: 'lead' }) === true);
  ok('a stage with no pipeline IS orphaned', isOrphanedOpportunity(pipelines, { pipelineId: '', stage: 'lead' }) === true);
  ok('no stage → not an orphan (just an off-board opportunity)', isOrphanedOpportunity(pipelines, { pipelineId: 'pl_sales', stage: '' }) === false);
  ok('cleanly off-pipeline → not an orphan', isOrphanedOpportunity(pipelines, { pipelineId: '', stage: '' }) === false);
  ok('null opportunity → not an orphan', isOrphanedOpportunity(pipelines, null) === false);
  // The recovery target must itself be a valid placement, or the reducer guard would refuse it.
  ok('recovery target (Master/new-lead) is valid', isValidPlacement(pipelines, 'pl_master', 'new-lead') === true);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
