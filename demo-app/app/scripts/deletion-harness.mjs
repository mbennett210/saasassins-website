// deletion-harness.mjs — the executable ripple verifier for the deletion audit.
//
// For every manifest cell it: enriches seed with fixtures so the cell is actually
// referenced, dispatches the REAL delete of the referenced target against a cloned
// state, then inspects the result for a surviving ("dangling") reference to the deleted
// record. The verdict per (action × cell) is the audit's evidence — SWEPT / NULLED /
// REPOINTED / BLOCKED / KEPT / DANGLING / NOT-EXERCISED, with "+NAME" when a cell that
// must keep the person's name (manifest nameField) is proven to, else NAME-LOST — and it
// is derived from the actual reducer, not asserted by hand.
//
// Not a test file (no `test-` prefix) — imported by test-deletion-ripple.mjs and the
// ledger generator. Pure store only (no live service).
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { loadStore } from './deletion-core.mjs';

export function loadManifest() {
  return JSON.parse(readFileSync(fileURLToPath(new URL('../deletion.manifest.json', import.meta.url)), 'utf8'));
}

// ── cell-path resolver ────────────────────────────────────────────────────────
// Yield each concrete location a cell occupies, with its owning top-level row id and a
// live view of the reference value(s) there. Grammar:
//   $.field                          root scalar
//   coll[].field                     scalar-id / id-array on a top row
//   coll[].sub[].field               field on a nested array row
//   coll[].obj.field                 field on a nested object
//   coll[].map.{key} / .{value}      id-keyed map
//   name.obj.field                   root object (no []), e.g. marketingSettings.replyRouting.pipelineId
export function resolveCell(state, cellPath) {
  const out = [];
  if (cellPath.startsWith('$.')) {
    const key = cellPath.slice(2);
    out.push({ topRowId: '$', refs: state[key] == null ? [] : [state[key]] });
    return out;
  }
  const segs = cellPath.split('.');
  const first = segs[0];
  const collName = first.replace(/\[\]$/, '');
  const isColl = first.endsWith('[]');
  const rest = segs.slice(1);

  const readAt = (obj, path, topRowId) => {
    // path is an array of segments after the top collection row
    let cur = [obj];
    for (let i = 0; i < path.length; i += 1) {
      const seg = path[i];
      const last = i === path.length - 1;
      if (seg === '{key}') { for (const c of cur) if (c && typeof c === 'object') out.push({ topRowId, refs: Object.keys(c) }); return; }
      if (seg === '{value}') { for (const c of cur) if (c && typeof c === 'object') out.push({ topRowId, refs: Object.values(c).filter((v) => typeof v === 'string') }); return; }
      const key = seg.replace(/\[\]$/, '');
      const arr = seg.endsWith('[]');
      const nextCur = [];
      for (const c of cur) {
        if (!c || typeof c !== 'object') continue;
        const v = c[key];
        if (last) {
          if (Array.isArray(v)) out.push({ topRowId, refs: v.filter((x) => typeof x === 'string') });
          else out.push({ topRowId, refs: v == null ? [] : [v] });
        } else if (arr) {
          for (const el of (v || [])) nextCur.push(el);
        } else if (v && typeof v === 'object') {
          nextCur.push(v);
        }
      }
      if (!last) cur = nextCur;
    }
  };

  if (isColl) {
    for (const row of (state[collName] || [])) readAt(row, rest, row?.id);
  } else {
    // root object chain, e.g. marketingSettings.replyRouting.pipelineId
    readAt(state[collName], rest, '$');
  }
  return out;
}

// A ref matches the victim by exact value OR by a path-embedded token (a deep-link url
// `/messaging/<id>` carries the id as a `/`-delimited token). Tokenizing a plain scalar
// id yields just itself, so this never over-matches.
const refMatches = (r, victimIds) => victimIds.has(r)
  || (typeof r === 'string' && r.split(/[/#?&=]+/).some((t) => t && victimIds.has(t)));

// Which top-row ids in this cell still reference the victim (id, email, or url token)?
export function cellDangles(state, cellPath, victimIds) {
  const hits = [];
  for (const loc of resolveCell(state, cellPath)) {
    if (loc.refs.some((r) => refMatches(r, victimIds))) hits.push(loc.topRowId);
  }
  return hits;
}

// Global scan: every path where any victim id/email survives (normalized), so a dangle
// at an UNMAPPED path (not a manifest cell) is caught as UNCLASSIFIED.
export function scanDangles(state, victimIds) {
  const hits = new Map(); // normPath -> count
  const seen = new Set();
  const walk = (node, parts) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { for (const el of node) walk(el, [...parts, '[]']); return; }
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') {
        if (k === 'id') continue;
        if (victimIds.has(v) || v.split(/[/#?&=]+/).some((t) => t && victimIds.has(t))) bump([...parts, k]);
      } else if (Array.isArray(v)) {
        for (const el of v) if (typeof el === 'string' && victimIds.has(el)) bump([...parts, k]);
        walk(v, [...parts, k]);
      } else if (v && typeof v === 'object') {
        // Only an id-keyed map (crewChecklists { [userId]: … }) contributes {key}/{value};
        // a normal nested object (replyRouting { pipelineId, stageKey }) is walked so its
        // id-valued fields bump their real path, not a spurious {value}.
        const keys = Object.keys(v);
        const isIdMap = keys.length > 0 && keys.every((mk) => victimIds.has(mk) || /^[a-z0-9]+[_-]/i.test(mk));
        if (isIdMap) {
          for (const [mk, mv] of Object.entries(v)) {
            if (victimIds.has(mk)) bump([...parts, k, '{key}']);
            if (typeof mv === 'string' && victimIds.has(mv)) bump([...parts, k, '{value}']);
          }
        } else {
          walk(v, [...parts, k]);
        }
      }
    }
  };
  const norm = (parts) => {
    let s = '';
    for (const p of parts) {
      if (p === '[]') s += '[]';
      else if (p.startsWith('{')) s += `.${p}`;
      else s += (s ? '.' : '') + p;
    }
    return s.includes('.') || s.includes('[') ? s : `$.${s}`;
  };
  const bump = (parts) => { const n = norm(parts); hits.set(n, (hits.get(n) || 0) + 1); };
  walk(state, []);
  return hits;
}

// dispatch payload for a delete action given the victim row
function payloadFor(actionName, victim) {
  if (actionName === 'DELETE_JOB_SERIES') return { type: actionName, seriesId: victim.seriesId || victim.id };
  if (actionName === 'DELETE_PIPELINE_STAGE') return { type: actionName, id: victim.id, pipelineId: victim.__pipelineId };
  return { type: actionName, id: victim.id };
}

// Run one hard-delete: returns { after, blocked }.
export function runDelete(store, actionName, before, victim) {
  const action = payloadFor(actionName, victim);
  const after = store.reducer(before, { ...action, type: store.ACTIONS[actionName] });
  return { after, blocked: after === before };
}

const CLEAR_POLICIES = new Set(['SWEEP', 'NULLIFY', 'NULLIFY+name', 'REPOINT']);
const topColl = (cell) => cell.replace(/^\$\./, '').split(/\[\]|\./)[0];

// The "+name" half of a name-keeping cell (spec.nameField): once the delete proceeds,
// every row that referenced the victim must still exist and carry the victim's name in
// that field (a row that already had a name keeps it) — else the person turns into "—"
// in history. The name lives on the same top-level row, so this reads `coll[].field` cells.
function namesKept({ before, after, cell, spec, beforeHits, victimName }) {
  const coll = topColl(cell);
  const rowsById = (s) => new Map((Array.isArray(s[coll]) ? s[coll] : []).map((r) => [r && r.id, r]));
  const b = rowsById(before);
  const a = rowsById(after);
  return beforeHits.every((rid) => {
    const want = b.get(rid)?.[spec.nameField] || victimName;
    return typeof want === 'string' && want.trim() !== '' && a.get(rid)?.[spec.nameField] === want;
  });
}

// Verdict one (cell × scenario): the audit's per-cell evidence.
export function verdictCell({ before, after, blocked, cell, spec, victimIds, victimName = null, scen }) {
  const base = { cell, target: spec.target, action: scen.action, policy: spec.policy, decision: spec.decision || null };
  if (spec.policy === 'NOT-EXERCISABLE') return { ...base, verdict: 'NOT-EXERCISABLE', pass: true };
  const beforeHits = cellDangles(before, cell, victimIds);
  if (!beforeHits.length) return { ...base, verdict: 'NOT-EXERCISED', pass: false };
  const afterHits = cellDangles(after, cell, victimIds);
  // BLOCK-UNSETTLED: the delete must be REFUSED while the referenced money may be unpaid,
  // and once it is settled history the delete proceeds and the row survives as a record.
  const blockingPolicy = spec.policy === 'BLOCK' || spec.policy === 'BLOCK-UNSETTLED';
  const keepingPolicy = spec.policy === 'KEEP-BY-DESIGN' || spec.policy === 'BLOCK-UNSETTLED';
  // A passing verdict on a name-keeping cell earns "+NAME" only once the name is proven on
  // every witnessing row; NULLIFY+name with no nameField to check can't pass at all.
  const named = (r) => {
    if (!spec.nameField) return spec.policy === 'NULLIFY+name' ? { ...r, verdict: 'NAME-UNCHECKED', pass: false } : r;
    if (!r.pass) return r;
    return namesKept({ before, after, cell, spec, beforeHits, victimName })
      ? { ...r, verdict: `${r.verdict}+NAME` }
      : { ...r, verdict: 'NAME-LOST', pass: false };
  };
  if (scen.expect === 'block') {
    const ok = blocked && afterHits.length > 0;
    return { ...base, verdict: blocked ? 'BLOCKED' : 'GUARD-FAILED', pass: blockingPolicy ? ok : false };
  }
  if (afterHits.length) {
    if (keepingPolicy) return named({ ...base, verdict: 'KEPT', pass: true });
    return { ...base, verdict: 'DANGLING', pass: false };
  }
  // reference cleared — distinguish row-sweep from field-null for the ledger label.
  // Only array collections have removable rows; a root scalar/object ($.x, settings.x)
  // can only be nulled/repointed, never "swept".
  const coll = after[topColl(cell)];
  const present = Array.isArray(coll) ? new Set(coll.map((r) => r && r.id).filter(Boolean)) : null;
  const swept = present !== null && beforeHits.every((rid) => rid !== '$' && !present.has(rid));
  const verdict = spec.policy === 'REPOINT' ? 'REPOINTED' : (swept ? 'SWEPT' : 'NULLED');
  if (keepingPolicy) return named({ ...base, verdict: 'CLEARED', pass: true });
  return named({ ...base, verdict, pass: CLEAR_POLICIES.has(spec.policy) });
}

// Run every scenario against a fresh enriched clone; return all per-cell verdicts +
// any global dangle at an UNMAPPED path (a reference the manifest did not classify).
export function runAudit(store, manifest, fixtures) {
  const cellsByTarget = {};
  for (const [cell, spec] of Object.entries(manifest.fields)) (cellsByTarget[spec.target] ||= []).push([cell, spec]);
  const classifiedPaths = new Set(Object.keys(manifest.fields));
  for (const k of Object.keys(manifest.excluded || {})) classifiedPaths.add(k);
  const results = [];
  const unmapped = [];
  for (const scen of fixtures.SCENARIOS) {
    const before = fixtures.enrichState(structuredClone(store.INITIAL_STATE));
    // The victim row is deleted FROM `deleteFrom` (default: the scenario target). A
    // scenario may instead give an explicit `payload` (nested deletes like a marketing
    // step, whose victim is not a top-level row).
    const deleteFrom = scen.deleteFrom || scen.target;
    const victim = (before[deleteFrom] || []).find((r) => r && r.id === scen.victimId) || (scen.payload ? {} : null);
    if (!victim) { results.push({ cell: '(victim)', action: scen.action, verdict: 'NO-VICTIM', pass: false, target: scen.target }); continue; }
    const victimIds = new Set([scen.victimId, ...(scen.extraVictimIds || [])]);
    const vic = fixtures.VICTIMS[scen.target];
    if (vic && vic.email) victimIds.add(vic.email);
    // what a name-keeping cell must carry once the victim is gone
    const victimName = typeof victim.name === 'string' ? victim.name : null;
    const after = scen.payload
      ? store.reducer(before, { ...scen.payload, type: store.ACTIONS[scen.action] })
      : runDelete(store, scen.action, before, victim).after;
    const blocked = after === before;
    // 'target' mode verdicts the target's cells that THIS victim actually witnesses; a
    // cell witnessed only by another scenario (e.g. the payroll-block victim) is left to
    // it. Every exercisable cell must still be covered by SOME scenario — the test's
    // coverage assertion enforces that globally.
    const cells = scen.cells === 'target'
      ? (cellsByTarget[scen.target] || []).filter(([cell]) => cellDangles(before, cell, victimIds).length > 0)
      : scen.cells.map((c) => [c, manifest.fields[c]]);
    for (const [cell, spec] of cells) results.push(verdictCell({ before, after, blocked, cell, spec, victimIds, victimName, scen }));
    // global scan for dangles at unmapped paths (only when the delete proceeded)
    if (!blocked) {
      for (const [path] of scanDangles(after, victimIds)) {
        if (!classifiedPaths.has(path)) unmapped.push({ action: scen.action, path });
      }
    }
  }
  return { results, unmapped };
}

export { loadStore };
