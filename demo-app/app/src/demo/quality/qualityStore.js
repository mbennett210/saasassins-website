// Demo data layer for the Quality Control + Variance modules.
//
// Fail-SAFE by construction: pure localStorage, no network, no auth. This is the
// demo's stand-in for Rainier's qcApi/timeApi/varianceApi stubs — same shape
// (read records, mutate, compute the variance report), but it never reaches a
// backend, matching the demo's BACKEND = IS_DEMO ? null discipline. Records live
// in their own `pp.qc.*` namespace, fully decoupled from the main store, so none
// of this touches seed.js / reducer.js / selectors.js.

import { buildQualitySeed } from './qualitySeed';
import { buildVarianceReport } from '../../lib/variance';
import { scoreInspection, flattenItems } from '../../lib/inspections';

const KEY = 'pp.qc.v1';

// Light pub/sub so pages re-read after a mutation without a global store.
const listeners = new Set();
function emit() { listeners.forEach((fn) => { try { fn(); } catch { /* noop */ } }); }
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1) return parsed;
    }
  } catch { /* fall through to reseed */ }
  const seed = buildQualitySeed();
  save(seed);
  return seed;
}

function save(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* quota — demo still works in-memory for this tick */ }
}

function mutate(fn) {
  const state = load();
  const next = fn(state) || state;
  save(next);
  emit();
  return next;
}

// ── reads ─────────────────────────────────────────────────────────────────
export function getOpsSettings() { return load().opsSettings; }
export function listTemplates() { return load().templates; }
export function getTemplate(id) { return load().templates.find((t) => t.id === id) || null; }

export function listInspections() {
  return [...load().inspections].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}
export function getInspection(idOrToken) {
  const s = load();
  return s.inspections.find((i) => i.id === idOrToken || i.token === idOrToken) || null;
}

export function listProblems() {
  const rank = { open: 0, acknowledged: 1, resolved: 2 };
  return [...load().problems].sort(
    (a, b) => (rank[a.status] - rank[b.status]) || String(b.date).localeCompare(String(a.date)),
  );
}
export function openProblemCount() { return load().problems.filter((p) => p.status !== 'resolved').length; }

// Build the variance "morning scan" report from the seeded time entries.
export function getVarianceReport() {
  const s = load();
  const { basis, thresholds } = s.opsSettings;
  return buildVarianceReport(s.timeEntries, { basis, thresholds });
}
export function getExpectedMinsByClient() { return load().expectedMinsByClient; }

// ── mutations ───────────────────────────────────────────────────────────────
export function setProblemStatus(id, status) {
  return mutate((s) => ({
    ...s,
    problems: s.problems.map((p) => (p.id === id ? { ...p, status } : p)),
  }));
}

// Record a new inspection (the "perform an inspection" flow). areas carry the
// rated items; the score is computed with the same pure engine as the seed.
export function addInspection({ template, siteName, clientName, inspectorName, areas }) {
  const { overallScore, result } = scoreInspection(flattenItems(areas), template.scale);
  const id = `insp-${Math.round(performance.now())}-${load().inspections.length + 1}`;
  const record = {
    id, token: id,
    templateId: template.id, templateName: template.name, scale: template.scale,
    siteId: null, siteName, clientName, inspectorName,
    date: new Date().toISOString(),
    areas, overallScore, result,
  };
  mutate((s) => ({ ...s, inspections: [record, ...s.inspections] }));
  return record;
}

// Reset to a fresh seed (used by a "Reset demo data" affordance if wired).
export function resetQualityData() {
  const seed = buildQualitySeed();
  save(seed);
  emit();
  return seed;
}
