// Unit test for app/src/lib/pipelines.js — the placement invariant that stops an
// opportunity from "vanishing into oblivion" (saved onto no board). Pins the pure
// rules the SET_OPPORTUNITY_STAGE reducer guard, the orphan selector, and the stage
// editor all share.
//   node app/scripts/test-pipeline-placement.mjs
import {
  stageExistsOnPipeline, isValidPlacement, isOrphanedOpportunity,
  isOpenOpportunity, boardOpportunities, isTerminalStage, statusForStage,
  TERMINAL_STAGE_KEYS, CLOSED_OPPORTUNITY_STATUSES,
} from '../src/lib/pipelines.js';
// The headline invariant (CS-141) is a SELECTOR fact, so the real selectors are driven
// here. selectors.js carries Vite-style extensionless imports, hence the resolve shim.
import { installResolveShim } from './deletion-core.mjs';
installResolveShim();
const {
  selectBoardOpportunities, selectPipelineOpportunities, selectOpenOpportunityValue,
} = await import(new URL('../src/store/selectors.js', import.meta.url).href);

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

// ── MISC-1 / CS-141: won and lost deals LEAVE the board, and the headline is the sum
//    of exactly the cards drawn ───────────────────────────────────────────────────────
{
  ok('the terminal stages are won + lost', TERMINAL_STAGE_KEYS.join(',') === 'won,lost');
  ok('won is a terminal stage', isTerminalStage('won') === true);
  ok('lost is a terminal stage', isTerminalStage('lost') === true);
  ok('a real stage is not terminal', isTerminalStage('lead') === false);
  ok('no stage is not terminal', isTerminalStage(null) === false);

  // The status/stage coupling has one definition, and the reducer reads it.
  ok("statusForStage('won') is won", statusForStage('won') === 'won');
  ok("statusForStage('lost') is lost", statusForStage('lost') === 'lost');
  ok('statusForStage of a real stage is open', statusForStage('lead') === 'open');
  ok('statusForStage of no stage is open', statusForStage(null) === 'open');
  ok('the closed statuses are exactly the terminal stage keys',
    CLOSED_OPPORTUNITY_STATUSES.join(',') === TERMINAL_STAGE_KEYS.join(','));

  ok('an open deal is on the board', isOpenOpportunity({ status: 'open' }) === true);
  ok('a statusless deal is on the board', isOpenOpportunity({}) === true);
  ok('a WON deal is off the board', isOpenOpportunity({ status: 'won' }) === false);
  ok('a LOST deal is off the board', isOpenOpportunity({ status: 'lost' }) === false);
  ok('a null deal is off the board', isOpenOpportunity(null) === false);
  ok('boardOpportunities keeps only the open ones',
    boardOpportunities([{ status: 'open' }, { status: 'won' }, { status: 'lost' }, {}]).length === 2);
  ok('boardOpportunities tolerates no list', boardOpportunities(undefined).length === 0);

  // CS-141's live shape (LW-06): deals with a won/lost STATUS sitting in open COLUMNS, so
  // the headline ($14,000 = the open ones) disagreed with the board ($26,500 = every card).
  const state = {
    pipelines: [{ id: 'pl_master', isMaster: true, stages: [{ key: 'new-lead' }, { key: 'proposal' }, { key: 'won' }, { key: 'lost' }] }],
    activePipelineId: 'pl_master',
    opportunities: [
      { id: 'o1', pipelineId: 'pl_master', stage: 'new-lead', status: 'open', value: 9000 },
      { id: 'o2', pipelineId: 'pl_master', stage: 'proposal', status: 'open', value: 5000 },
      // won/lost, but still parked in OPEN columns — what production held
      { id: 'o3', pipelineId: 'pl_master', stage: 'proposal', status: 'won', value: 8000 },
      { id: 'o4', pipelineId: 'pl_master', stage: 'new-lead', status: 'lost', value: 4500 },
      // properly closed, on the terminal columns
      { id: 'o5', pipelineId: 'pl_master', stage: 'won', status: 'won', value: 12000 },
      // another board, and an unplaced deal — neither belongs to this one
      { id: 'o6', pipelineId: 'pl_other', stage: 'lead', status: 'open', value: 7000 },
      { id: 'o7', pipelineId: null, stage: null, status: 'open', value: 3000 },
    ],
  };

  const placed = selectPipelineOpportunities(state);
  const cards = selectBoardOpportunities(state);
  ok('the PLACEMENT set still holds every placed deal, closed included (the stage editor reads it)',
    placed.length === 5);
  ok('the BOARD draws only the open ones', cards.map((o) => o.id).join(',') === 'o1,o2');
  ok('no card the board draws is closed', cards.every(isOpenOpportunity));
  ok('a closed deal is never deleted — it stays in state.opportunities',
    state.opportunities.filter((o) => !isOpenOpportunity(o)).length === 3);

  // 🔴 THE INVARIANT: the headline equals the sum of the visible cards, exactly.
  const drawnSum = cards.reduce((sum, o) => sum + (Number(o.value) || 0), 0);
  ok('the "Open deals" figure equals the sum of the drawn cards',
    selectOpenOpportunityValue(state) === drawnSum);
  ok('and that figure is 14000, not the 26500 of every placed card',
    selectOpenOpportunityValue(state) === 14000);

  // Per-column sums (what each column header prints) must reconcile to the headline too.
  const columnSum = ['new-lead', 'proposal', 'won', 'lost'].reduce((sum, key) => sum
    + cards.filter((o) => o.stage === key).reduce((a, o) => a + (Number(o.value) || 0), 0), 0);
  ok('the column sums add up to the headline', columnSum === selectOpenOpportunityValue(state));
  ok('the terminal columns draw nothing', cards.filter((o) => isTerminalStage(o.stage)).length === 0);

  ok('no pipeline → no cards and a zero headline',
    selectBoardOpportunities({ pipelines: [], opportunities: state.opportunities }).length === 0
    && selectOpenOpportunityValue({ pipelines: [], opportunities: state.opportunities }) === 0);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
