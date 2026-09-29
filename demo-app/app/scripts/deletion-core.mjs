// deletion-core.mjs — the shared engine behind the deletion-ripple ("orphan") audit.
//
// WHY THIS FILE EXISTS. BUILD_INTEGRITY's audit-rigor law: "Coverage is MECHANICAL,
// never judgment. What-exists comes from a re-runnable enumerator … whose counts
// reconcile against that universe. If a domain has no enumerator yet, building it is
// step 1 of the audit." This is that enumerator for record DELETION: it maps every way
// a delete ripples (or fails to ripple) through the store, so no reference field can be
// silently left dangling.
//
// It is NOT a test file (no `test-` prefix) so run-tests.mjs neither runs nor scans it.
// Three consumers import it: test-deletion-ripple.mjs (the CI suite), deletion-lint.mjs
// (the artifact gate + ledger generator), and any ad-hoc probe.
//
// THE LOAD-BEARING FACT. On node ≥22.15 the REAL reducer + seed import under plain node
// via a module.registerHooks() resolve shim that retries a failed extensionless relative
// specifier with `.js` appended (Vite writes extensionless imports). So the audit
// dispatches the ACTUAL delete handlers against the ACTUAL seed — no hand-mirrored
// re-implementation that can drift from the reducer. (The older lib/deleteCascade.js note
// that "the reducer can't be imported under node" predates this node capability.)

import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
export const REDUCER_PATH = join(SRC, 'store', 'reducer.js');
export const SEED_PATH = join(SRC, 'data', 'seed.js');

// ── the resolve shim ────────────────────────────────────────────────────────
// Vite resolves `../lib/roles` → `../lib/roles.js`; plain node does not. Retry any
// failed relative bare specifier (no extension in its basename) with `.js`. Anything
// that already carries an extension (`.json`, `.css`) is left alone, so we never turn
// `./x.json` into `./x.json.js`.
let hooked = false;
export function installResolveShim() {
  if (hooked) return;
  hooked = true;
  registerHooks({
    resolve(spec, ctx, next) {
      try {
        return next(spec, ctx);
      } catch (err) {
        const base = spec.split('/').pop() || spec;
        if ((spec.startsWith('./') || spec.startsWith('../')) && !base.includes('.')) {
          return next(spec + '.js', ctx);
        }
        throw err;
      }
    },
  });
}

// Import the real store. Returns { reducer, ACTIONS, INITIAL_STATE }.
export async function loadStore() {
  installResolveShim();
  const [reducerMod, seedMod] = await Promise.all([
    import(pathToFileURL(REDUCER_PATH).href),
    import(pathToFileURL(SEED_PATH).href),
  ]);
  if (typeof reducerMod.reducer !== 'function') throw new Error('reducer export missing');
  if (!reducerMod.ACTIONS) throw new Error('ACTIONS export missing');
  if (!seedMod.INITIAL_STATE) throw new Error('INITIAL_STATE export missing');
  return { reducer: reducerMod.reducer, ACTIONS: reducerMod.ACTIONS, INITIAL_STATE: seedMod.INITIAL_STATE };
}

// ── target collections: which state slices are arrays of deletable records ───
// A record kind is a top-level state array whose elements carry an id-shaped primary
// key. `contacts` additionally key by `email` (the natural key used across marketing).
export function collectionsOf(state) {
  const out = {};
  for (const [key, val] of Object.entries(state)) {
    if (!Array.isArray(val)) continue;
    if (!val.length) { out[key] = { idField: 'id', rows: [], empty: true }; continue; }
    const sample = val.find((r) => r && typeof r === 'object');
    if (!sample || !('id' in sample)) { out[key] = { idField: null, rows: val, empty: false }; continue; }
    out[key] = { idField: 'id', rows: val, empty: false };
  }
  return out;
}

// The set of every live record id (+ contact emails) across all collections — the
// membership set N3 (value-join) tests every leaf against. Also returns per-id origin
// so a value-join hit can name which collection it points into.
export function buildIdIndex(state) {
  const idToOrigin = new Map(); // idValue -> Set(collectionName)
  const add = (v, coll) => {
    if (typeof v !== 'string' || !v) return;
    if (!idToOrigin.has(v)) idToOrigin.set(v, new Set());
    idToOrigin.get(v).add(coll);
  };
  for (const [coll, val] of Object.entries(state)) {
    if (!Array.isArray(val)) continue;
    for (const row of val) {
      if (!row || typeof row !== 'object') continue;
      if ('id' in row) add(row.id, coll);
      if ('email' in row && coll === 'contacts') add(row.email, `${coll}:email`);
    }
  }
  return idToOrigin;
}

// ── path helpers ─────────────────────────────────────────────────────────────
// Normalize a concrete walk path to a stable cell id: array indices → `[]`, so
// `clients[3].primaryContactId` → `clients[].primaryContactId`. Root scalars render
// as `$.activePipelineId`.
function joinPath(parts) {
  let s = '';
  for (const p of parts) {
    if (p === '[]') s += '[]';
    else if (typeof p === 'string' && p.startsWith('{')) s += `.${p}`; // {key} / {value}
    else s += (s ? '.' : '') + p;
  }
  return s.startsWith('[]') || s.includes('.') || s.includes('[') ? s : `$.${s}`;
}

const REF_NAME = /(Id|Ids)$/; // scalar-id or id-array field-name shape

// ── N1: runtime key walk ─────────────────────────────────────────────────────
// Walk the (enriched) state; emit a cell for every object key whose NAME is
// reference-shaped (…Id / …Ids), plus every object that behaves like an id-KEYED MAP
// (≥1 of its keys is a known record id) → `{key}` and, when its values are known ids,
// `{value}`. This is what catches crewChecklists { [userId]: templateId } that an
// `/Id$/` grep structurally cannot see.
export function netKeyWalk(state, idIndex) {
  const cells = new Map(); // cellId -> { kind, sample }
  const note = (id, kind, sample) => {
    if (!cells.has(id)) cells.set(id, { kind, samples: new Set() });
    if (sample != null) cells.get(id).samples.add(String(sample));
  };
  const seen = new Set();
  const walk = (node, parts) => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const el of node) walk(el, [...parts, '[]']);
      return;
    }
    const keys = Object.keys(node);
    // id-keyed map? (values are a homogeneous scalar/short shape, keys look like ids)
    const idKeys = keys.filter((k) => idIndex.has(k));
    if (idKeys.length && keys.length && idKeys.length >= Math.min(keys.length, 1)
        && keys.every((k) => idIndex.has(k) || /^[a-z]+[_-]/i.test(k))) {
      const cellKey = joinPath([...parts, '{key}']);
      note(cellKey, 'map-key', idKeys[0]);
      const vals = keys.map((k) => node[k]).filter((v) => typeof v === 'string');
      if (vals.some((v) => idIndex.has(v))) note(joinPath([...parts, '{value}']), 'map-value', vals[0]);
      return; // do not descend into a map's id keys as if structural
    }
    for (const k of keys) {
      const v = node[k];
      if (REF_NAME.test(k) && k !== 'id') {
        const cellId = joinPath([...parts, k]);
        note(cellId, Array.isArray(v) ? 'id-array' : 'scalar-id', Array.isArray(v) ? v[0] : v);
      }
      if (v && typeof v === 'object') walk(v, [...parts, k]);
    }
  };
  walk(state, []);
  return cells;
}

// ── N3: value-join (the judgment-killer) ─────────────────────────────────────
// Walk every leaf; flag any string value that IS a known record id or contact email,
// regardless of the field's name or nesting. Catches non-Id-suffixed refs (createdBy,
// invitedBy, updatedBy, heldByUserId, toEmail/fromEmail) with zero name heuristics.
// Skips a record's own identity fields (id / email) — those are keys, not references.
export function netValueJoin(state, idIndex) {
  const cells = new Map();
  const note = (id, kind, targets, sample) => {
    if (!cells.has(id)) cells.set(id, { kind, targets: new Set(), samples: new Set() });
    for (const t of targets) cells.get(id).targets.add(t);
    if (sample != null) cells.get(id).samples.add(String(sample));
  };
  const seen = new Set();
  const walk = (node, parts) => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const el of node) walk(el, [...parts, '[]']);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') {
        if ((k === 'id') || (k === 'email' && parts[parts.length - 1] === '[]')) continue; // own identity
        if (idIndex.has(v)) note(joinPath([...parts, k]), 'scalar-id', idIndex.get(v), v);
        else {
          // path-embedded id — a deep-link url like `/messaging/<convId>` carries a live
          // record id inside a string. Tokenize and join each token against the id index
          // (a bare `idIndex.has(url)` never matches). This is the class the notifications
          // bell links belong to; it is a real FK the app hand-scrubs in DELETE_JOB et al.
          for (const tok of v.split(/[/#?&=]+/)) {
            if (tok && idIndex.has(tok)) { note(joinPath([...parts, k]), 'path-embedded', idIndex.get(tok), v); break; }
          }
        }
      } else if (Array.isArray(v)) {
        for (const el of v) if (typeof el === 'string' && idIndex.has(el)) note(joinPath([...parts, k]), 'id-array', idIndex.get(el), el);
        walk(v, [...parts, k]);
      } else if (v && typeof v === 'object') {
        // An id-keyed map (crewChecklists { [userId]: templateId }): its keys/values are
        // leaves, emitted as {key}/{value}. Do NOT recurse into it as a structural object
        // — that would mint a concrete-key path like `crewChecklists.<userId>`.
        const isIdMap = Object.keys(v).some((mk) => idIndex.has(mk));
        if (isIdMap) {
          for (const [mk, mv] of Object.entries(v)) {
            if (typeof mv === 'string' && idIndex.has(mv)) note(joinPath([...parts, k, '{value}']), 'map-value', idIndex.get(mv), mv);
            if (idIndex.has(mk)) note(joinPath([...parts, k, '{key}']), 'map-key', idIndex.get(mk), mk);
          }
        } else {
          walk(v, [...parts, k]);
        }
      }
    }
  };
  walk(state, []);
  return cells;
}

// ── N2: source grep ───────────────────────────────────────────────────────────
// Read reducer.js + seed.js text; collect every reference-shaped field NAME that
// appears as an object key or a property access. Catches names that live only in code
// or on empty-in-seed slices (payrollLines, reimbursements, …) that a data-only walk
// cannot show. Name-level (no container) by nature.
export function netSourceGrep() {
  const names = new Map(); // name -> Set(file:line)
  const note = (name, where) => {
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(where);
  };
  for (const path of [REDUCER_PATH, SEED_PATH]) {
    const label = path.endsWith('reducer.js') ? 'reducer.js' : 'seed.js';
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    lines.forEach((ln, i) => {
      for (const re of [/\b([a-z][A-Za-z0-9]*(?:Id|Ids))\b\s*[:=]/g, /\.([a-z][A-Za-z0-9]*(?:Id|Ids))\b/g]) {
        for (const m of ln.matchAll(re)) note(m[1], `${label}:${i + 1}`);
      }
    });
  }
  return names;
}

// ── action-universe sweep ─────────────────────────────────────────────────────
// Enumerate every delete-family ACTIONS.* referenced by a `case` in the reducer, plus
// the retention/prune call sites. Every one must be classified in the manifest's
// `actions` block (as a mode, or `not-a-delete`) — a new unclassified delete action
// fails the gate exactly like an unclassified field.
const DELETE_ACTION = /^(DELETE|REMOVE|CLEAR|BULK_DELETE|UNTAG|UNENROLL|REVOKE|DISCONNECT|SCRUB|RESET_A2P|RETRY_MARKETING_SEND|APPLY_TIME_OFF_EXCLUSIONS|PATCH_JOBS|SET_JOBS|UPDATE_JOB_SERIES|COMPLETE_SUPPLY_REQUEST|SET_INSPECTION_FOLLOWUP|SET_USER_PERMISSION_OVERRIDE|REMOVE_INVOICE_PAYMENT|DELETE_MARKETING_STEP)/;
const RETENTION_CALL = /\b(capTail|capTailProtected|capInsert|pruneSupplyRequests|applyLogCaps|ADD_REMINDER_EVENT)\b/;

export function netActionSweep() {
  const src = readFileSync(REDUCER_PATH, 'utf8');
  const lines = src.split(/\r?\n/);
  const actions = new Map();  // name -> file:line of its case
  const retention = new Map();
  lines.forEach((ln, i) => {
    const cm = ln.match(/case\s+ACTIONS\.([A-Z0-9_]+)\s*:/);
    if (cm && DELETE_ACTION.test(cm[1])) actions.set(cm[1], `reducer.js:${i + 1}`);
    const rm = ln.match(RETENTION_CALL);
    if (rm) {
      if (!retention.has(rm[1])) retention.set(rm[1], new Set());
      retention.get(rm[1]).add(`reducer.js:${i + 1}`);
    }
  });
  return { actions, retention };
}

// ── the combined universe ──────────────────────────────────────────────────────
// Merge the nets over an (optionally enriched) state into one enumerated set of cells,
// each carrying its kind, the nets that found it, and target hints from the value-join.
export function enumerateUniverse(state) {
  const idIndex = buildIdIndex(state);
  const n1 = netKeyWalk(state, idIndex);
  const n3 = netValueJoin(state, idIndex);
  const n2 = netSourceGrep();
  const cells = new Map(); // cellId -> { kind, nets:Set, targets:Set, samples:Set }
  const merge = (map, netName, hasTargets) => {
    for (const [id, info] of map) {
      if (!cells.has(id)) cells.set(id, { kind: info.kind, nets: new Set(), targets: new Set(), samples: new Set() });
      const c = cells.get(id);
      c.nets.add(netName);
      if (info.kind && !c.kind) c.kind = info.kind;
      if (hasTargets && info.targets) for (const t of info.targets) c.targets.add(t);
      if (info.samples) for (const s of info.samples) c.samples.add(s);
    }
  };
  merge(n1, 'N1', false);
  merge(n3, 'N3', true);
  return { cells, names: n2, ...netActionSweep(), idIndex };
}
