// Pipeline placement rules — the single definition of when an OPPORTUNITY is validly
// placed on a board, shared by the reducer (the SET_OPPORTUNITY_STAGE hard guard),
// the selectors (orphan recovery), and the stage-editing UI.
//
// Why this exists: an opportunity renders on a board only while `pipelineId` points at a
// real pipeline AND `stage` is a real column key of that pipeline. Nothing enforced that
// on write, so an editor could save an opportunity with an empty/stale stage — leaving it
// in state.opportunities but on no board ("vanished into oblivion"). These pure helpers
// make the invariant checkable in one place. Node-ESM-safe (no imports) so it can be
// unit-tested directly.

// A stage is placeable when the pipeline actually declares its key. The Master pipeline
// is included: it is a normal board with real stages now (New Lead → … → Won/Lost), not
// the old roll-up whose only column was an implicit intake.
export function stageExistsOnPipeline(pipeline, stage) {
  if (!pipeline || !stage) return false;
  return (pipeline.stages || []).some((s) => s.key === stage);
}

// A placement is valid when it is EITHER cleanly off-pipeline (both empty) OR on a real
// pipeline at a stage that exists there. A pipeline without a stage — or a stage without
// its pipeline — is the broken half-state that vanishes a card, and is rejected.
export function isValidPlacement(pipelines, pipelineId, stage) {
  if (!pipelineId && !stage) return true;      // off-pipeline — no deal on a board
  if (!pipelineId || !stage) return false;     // half-state — the vanish bug
  const pl = (pipelines || []).find((p) => p.id === pipelineId);
  return stageExistsOnPipeline(pl, stage);
}

// An orphaned opportunity is one that THINKS it is on a board (it has a stage) but whose
// placement is invalid — a stale stage key, or a pipeline that no longer exists. These are
// the already-vanished rows the recovery banner resurfaces. An opportunity with no stage
// is NOT an orphan — it is simply not on a board.
export function isOrphanedOpportunity(pipelines, opportunity) {
  if (!opportunity || !opportunity.stage) return false;
  return !isValidPlacement(pipelines, opportunity.pipelineId, opportunity.stage);
}
