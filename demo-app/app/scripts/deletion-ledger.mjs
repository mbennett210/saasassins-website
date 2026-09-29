// deletion-ledger.mjs — renders the audit verdicts as the committed DELETION_LEDGER.md
// (the owner's per-cell visible proof) and a color-coded deletion-matrix.html review grid.
// Pure formatting over runAudit() results; no volatile data (counts of rows, ids, dates)
// so the markdown is byte-stable across machines/days and can be drift-gated.

// Red for ANY failing cell (DANGLING, NAME-LOST, GUARD-FAILED, …), not just DANGLING.
const marker = (r) => {
  if (r.verdict === 'NOT-EXERCISABLE') return '⏸';
  if (!r.pass) return '🔴';
  if (r.decision) return '⚠';
  return '✅';
};

function groupByAction(results) {
  const order = [];
  const by = new Map();
  for (const r of results) {
    if (!by.has(r.action)) { by.set(r.action, []); order.push(r.action); }
    by.get(r.action).push(r);
  }
  return { order, by };
}

export function buildLedgerMarkdown({ results, manifest, baseline, enumerated, classified }) {
  const accepted = baseline.accepted || {};
  const { order, by } = groupByAction(results);
  // every failing cell is a finding (DANGLING or NAME-LOST …); only baselined ones can be committed
  const dangling = results.filter((r) => !r.pass);
  const decisions = new Map();
  for (const r of results) if (r.decision) decisions.set(r.decision, (decisions.get(r.decision) || 0) + 1);
  const notExercisable = Object.values(manifest.fields).filter((f) => f.policy === 'NOT-EXERCISABLE').length;

  const L = [];
  L.push('# Deletion-ripple ledger');
  L.push('');
  L.push('> **Generated — do not hand-edit.** `npm --prefix app run lint:deletions -- --write`');
  L.push('>');
  L.push('> The per-cell proof that record deletion ripples correctly. Every row is one');
  L.push('> (delete action × reference field): its **Verdict** is what the REAL reducer did to');
  L.push('> that reference when the target was deleted, observed by `test-deletion-ripple.mjs`.');
  L.push('> `lint:deletions` fails the build when a verdict here disagrees with a fresh run.');
  L.push('>');
  L.push('> ✅ cleared as its policy requires (SWEPT / NULLED / REPOINTED / BLOCKED / KEPT) ·');
  L.push('> **+NAME** = the deleted person\'s name is proven kept on the surviving row, so history');
  L.push('> never shows them as "—" · 🔴 a failing cell: DANGLING = a surviving reference to a');
  L.push('> deleted record (orphan; cites its DR-id, accepted in `deletion.baseline.json` pending');
  L.push('> fix), NAME-LOST = the name did not survive · ⏸ NOT-EXERCISABLE (no delete path fires');
  L.push('> the ripple) · ⚠ correct today but an owner decision is open.');
  L.push('');
  const namedCount = results.filter((r) => r.pass && r.verdict.endsWith('+NAME')).length;
  L.push(`**${order.length} delete actions · ${results.length} reference cells verdicted · ${dangling.length} findings (🔴)**`);
  L.push('');
  L.push(`RECONCILE: ${enumerated} cells enumerated, all classified · ${classified} manifest entries (fields+excluded) · `
    + `${results.length} cells verdicted · 🔴 findings ${dangling.length} (baselined) · +NAME proven ${namedCount} · ⚠ open-decision ${results.filter((r) => r.decision && r.pass).length} · ⏸ NOT-EXERCISABLE ${notExercisable} · unmapped 0`);
  L.push('');

  for (const action of order) {
    const rows = by.get(action);
    const spec = manifest.actions[action] || {};
    const guard = spec.guards ? ` — guard ${spec.guards.join(', ')}` : '';
    const tgt = rows[0] ? rows[0].target : '';
    L.push(`## ${action} → ${tgt}${guard}`);
    L.push('');
    L.push('| Cell | Policy | Verdict | Evidence |');
    L.push('|---|---|---|---|');
    for (const r of rows) {
      const key = `${r.action}×${r.cell}`;
      const dr = accepted[key] ? ` (${accepted[key].dr})` : '';
      const dec = r.decision && r.pass ? ` [${r.decision}]` : '';
      L.push(`| \`${r.cell}\` | ${r.policy} | ${marker(r)} ${r.verdict}${dr}${dec} | \`DL ${key}\` |`);
    }
    L.push('');
  }

  // Findings register (the DANGLING rows, DR order)
  L.push('## Findings (DR register)');
  L.push('');
  L.push('| DR | Action × Cell | Decision | Note |');
  L.push('|---|---|---|---|');
  const findingRows = dangling.map((r) => {
    const key = `${r.action}×${r.cell}`;
    const a = accepted[key] || {};
    return { dr: a.dr || 'DR-??', key, decision: a.decision || r.decision || '', note: a.note || '' };
  }).sort((x, y) => x.dr.localeCompare(y.dr, undefined, { numeric: true }));
  for (const f of findingRows) L.push(`| ${f.dr} | \`${f.key}\` | ${f.decision || '—'} | ${f.note} |`);
  L.push('');

  // Open decisions
  if (decisions.size) {
    L.push('## Open decisions');
    L.push('');
    for (const [d, n] of [...decisions].sort()) L.push(`- **${d}** — ${n} cell(s). See DELETION_AUDIT.md.`);
    L.push('');
  }

  // Deferred scopes (scope decision: store-verified now; the rest enumerated + go-live)
  L.push('## Deferred scopes (⏸ — see DELETION_AUDIT.md)');
  L.push('');
  L.push('The runtime store above is fully verified. These deletion surfaces are enumerated in');
  L.push('the audit exploration and classified statically; live verification binds at go-live:');
  L.push('');
  L.push('- **Server API delete routes** (~20: jobs-delta, `job_deletes` tombstone + reap cron,');
  L.push('  push subscriptions, webhooks, quotes + storage, QC items, account-media, GMB) —');
  L.push('  static; live drive against a sandbox rig is the ⏸ **go-live gate**.');
  L.push('- **Supabase FK/tombstone migrations** (`ON DELETE SET NULL` for time/inspection/');
  L.push('  checklist/problem records; the clean-media AFTER DELETE trigger) — static.');
  L.push('- **Secondary stores** not swept by any reducer delete: the time-ledger stub');
  L.push('  (`cleanspace_time_entries_stub_v1` keeps punches keyed to dead job ids), QC/media/');
  L.push('  quotes/HR stubs, IndexedDB queues — static.');
  L.push('- **UI dispatch sites** (50) + confirm-dialog disclosure vs actual cascade (OQ-01');
  L.push('  generalized) — static.');
  L.push('');
  return L.join('\n') + '\n';
}

// Parse a committed ledger back into { "DL action×cell": "VERDICT" } for the drift gate.
export function parseLedger(md) {
  const map = new Map();
  for (const m of md.matchAll(/^\|\s*`[^`]+`\s*\|[^|]*\|\s*(\S+)\s+([A-Z+-]+)[^|]*\|\s*`DL ([^`]+)`\s*\|/gm)) {
    map.set(m[3].trim(), m[2].trim());
  }
  return map;
}

export function buildMatrixHtml({ results, baseline }) {
  const accepted = baseline.accepted || {};
  const { order, by } = groupByAction(results);
  const color = (r) => (r.verdict === 'NOT-EXERCISABLE' ? '#8b8b8b' : !r.pass ? '#e5484d' : r.decision ? '#f5a623' : '#30a46c');
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const sections = order.map((action) => {
    const rows = by.get(action).map((r) => {
      const key = `${r.action}×${r.cell}`;
      const dr = accepted[key] ? ` · ${accepted[key].dr}` : '';
      return `<tr><td class="cell">${esc(r.cell)}</td><td>${esc(r.policy)}</td>`
        + `<td><span class="dot" style="background:${color(r)}"></span>${esc(r.verdict)}${dr}</td></tr>`;
    }).join('');
    return `<h2>${esc(action)} <span class="tgt">→ ${esc(by.get(action)[0].target)}</span></h2>`
      + `<table><thead><tr><th>Cell</th><th>Policy</th><th>Verdict</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join('');
  const dangling = results.filter((r) => !r.pass).length;
  return `<!doctype html><meta charset="utf-8"><title>Deletion-ripple matrix</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--line:#e2e2e2;--muted:#6b6b6b}
@media(prefers-color-scheme:dark){:root{--bg:#161616;--fg:#ededed;--line:#2c2c2c;--muted:#9a9a9a}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;max-width:960px;margin:0 auto}
h1{font-size:20px} h2{font-size:15px;margin:28px 0 6px} .tgt{color:var(--muted);font-weight:400}
table{border-collapse:collapse;width:100%;margin-bottom:4px} th,td{text-align:left;padding:5px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px} .cell{font-family:ui-monospace,monospace;font-size:12.5px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:middle}
.legend{color:var(--muted);font-size:13px;margin:4px 0 8px}
</style>
<h1>Deletion-ripple matrix <span class="tgt">— ${results.length} cells · ${order.length} actions · ${dangling} findings</span></h1>
<p class="legend"><span class="dot" style="background:#30a46c"></span>correct &nbsp; <span class="dot" style="background:#e5484d"></span>failing (orphan / name lost) &nbsp; <span class="dot" style="background:#f5a623"></span>open decision &nbsp; <span class="dot" style="background:#8b8b8b"></span>not-exercisable</p>
${sections}
`;
}
