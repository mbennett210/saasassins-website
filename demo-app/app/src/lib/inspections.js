// Pure inspection scoring + result vocabulary — the heart of the Quality Control
// module. Browser-dep-free, explicit imports only, so a score computed anywhere
// (seed authoring, the fill flow, the public report) can never disagree.
// Ported from the Rainier client build (lib/inspections.js), verbatim logic.

// items: [{ rating, ... }]. scale: { type:'passfail'|'numeric', max?, passThreshold? }.
// 'na' / null / '' ratings are excluded from the denominator. passfail = % pass;
// numeric = average as a % of max. result = pass when score >= threshold (default 80).
export function scoreInspection(items, scale = {}) {
  const scored = (items || []).filter((it) => it.rating != null && it.rating !== '' && it.rating !== 'na');
  if (!scored.length) return { overallScore: null, result: 'needs_follow_up' };
  const threshold = Number.isFinite(scale.passThreshold) ? scale.passThreshold : 80;
  let pct;
  if (scale.type === 'numeric') {
    const max = Number.isFinite(scale.max) ? scale.max : 5;
    const avg = scored.reduce((s, it) => s + (Number(it.rating) || 0), 0) / scored.length;
    pct = max > 0 ? Math.round((avg / max) * 100) : 0;
  } else {
    const pass = scored.filter((it) => String(it.rating) === 'pass').length;
    pct = Math.round((pass / scored.length) * 100);
  }
  return { overallScore: pct, result: pct >= threshold ? 'pass' : 'fail' };
}

export function resultBadgeVariant(result) {
  if (result === 'pass') return 'green';
  if (result === 'fail') return 'red';
  if (result === 'needs_follow_up') return 'amber';
  return 'slate';
}

export function resultLabel(result) {
  if (result === 'pass') return 'Pass';
  if (result === 'fail') return 'Fail';
  if (result === 'needs_follow_up') return 'Needs follow-up';
  return '—';
}

// Flatten a template/record's area→item tree into one rated-item list for scoring.
export function flattenItems(areas) {
  return (areas || []).flatMap((a) => a.items || []);
}
