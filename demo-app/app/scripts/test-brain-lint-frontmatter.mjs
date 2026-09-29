// brain-lint's frontmatter parser must survive CRLF.
//
// ⚠️ WHY THIS EXISTS. On 2026-07-22 brain-lint reported 146 structural violations across
// all 29 cards — "frontmatter missing `title`" on files that plainly have it. The cause
// was not the cards: `parseFrontmatter` matched keys with /^(key):\s*(.*)$/, no `m` flag.
// In JS regex `.` excludes \r (it counts as a line terminator) and a bare `$` matches only
// end-of-input, so on a Windows CRLF checkout EVERY key line failed and every card parsed
// as zero frontmatter. That also silently disabled the truth and freshness tiers, which
// key off `sources` / `slices` / `verified_sha` — for an unknown number of sessions the
// brain's integrity checker was checking nothing while looking busy.
//
// A linter that flags every card is a linter nobody reads, and one that reads `{}` as
// "clean" is worse. So the parser is pinned against both line endings here.
//
//   node scripts/test-brain-lint-frontmatter.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { parseFrontmatter } from './brain-lint.mjs';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const CARD = [
  '---',
  'title: Module — Schedule & Jobs',
  'type: repo-card',
  'kind: module',
  'status: active',
  'slices: [jobs]',
  'sources:',
  '  - app/src/pages/Schedule.jsx',
  '  - app/src/store/reducer.js',
  'verified: 2026-07-20',
  'verified_sha: 432e688',
  '---',
  '',
  '# Module — Schedule & Jobs',
  '',
  '## Landmines',
  '- one landmine',
  '',
].join('\n');

// ── the same card in all three line endings parses identically ───────────
{
  const lf = parseFrontmatter(CARD);
  const crlf = parseFrontmatter(CARD.replace(/\n/g, '\r\n'));
  const cr = parseFrontmatter(CARD.replace(/\n/g, '\r'));

  for (const [name, got] of [['LF', lf], ['🔴 CRLF', crlf], ['bare CR', cr]]) {
    ok(`${name}: title survives`, got.fm.title === 'Module — Schedule & Jobs');
    ok(`${name}: the four required keys are all present`,
      ['title', 'type', 'kind', 'status'].every((k) => k in got.fm));
    ok(`${name}: kind is read (drives the line cap + the index exemption)`, got.fm.kind === 'module');
    ok(`${name}: an inline [list] parses to an array`,
      Array.isArray(got.fm.slices) && got.fm.slices.length === 1 && got.fm.slices[0] === 'jobs');
    ok(`${name}: a block list parses to an array — no trailing \\r on the paths`,
      Array.isArray(got.fm.sources) && got.fm.sources.length === 2
      && got.fm.sources.every((s) => s === s.trim() && !s.includes('\r')));
    ok(`${name}: verified_sha is read (the whole freshness tier keys off it)`,
      got.fm.verified_sha === '432e688');
    ok(`${name}: the body starts after the closing delimiter, not inside it`,
      got.body.startsWith('\n# Module') || got.body.startsWith('# Module'));
    ok(`${name}: the body still yields its section heading`,
      got.body.split('\n').some((l) => /^## Landmines\s*$/.test(l)));
  }

  ok('🔴 CRLF parses to exactly the same frontmatter as LF',
    JSON.stringify(crlf.fm) === JSON.stringify(lf.fm));
  ok('  ...and bare CR too', JSON.stringify(cr.fm) === JSON.stringify(lf.fm));
}

// ── the real cards on disk, whatever this checkout's line endings are ────
// The regression was invisible in a unit fixture alone: it only bit because the files
// as checked out on Windows are CRLF. So assert against the actual brain/.
{
  const brain = new URL('../../brain/', import.meta.url);
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(new URL(`${e.name}/`, dir));
      else if (e.name.endsWith('.md')) files.push(new URL(e.name, dir));
    }
  };
  walk(brain);

  ok('the brain has cards to check', files.length >= 20);
  const name = (f) => decodeURIComponent(f.pathname.split('/').pop());

  const empty = files.filter((f) => !Object.keys(parseFrontmatter(readFileSync(f, 'utf8')).fm).length);
  ok(`🔴 no card on disk parses to zero frontmatter keys${empty.length ? ` — ${empty.map(name).join(', ')}` : ''}`,
    empty.length === 0);

  const missing = files.filter((f) => {
    const { fm } = parseFrontmatter(readFileSync(f, 'utf8'));
    return !['title', 'type', 'kind', 'status'].every((k) => k in fm);
  });
  ok(`🔴 every card on disk yields all four required keys${missing.length ? ` — ${missing.map(name).join(', ')}` : ''}`,
    missing.length === 0);

  // The tier that stayed silent: if verified_sha never parses, freshness never runs and
  // every card is a warning instead of a check.
  const stamped = files.filter((f) => {
    const { fm } = parseFrontmatter(readFileSync(f, 'utf8'));
    return fm.verified_sha && fm.verified_sha !== 'null';
  });
  ok('🔴 the freshness tier has stamped cards to act on (it is not silently inert)',
    stamped.length > 0);
}

console.log(`\nbrain-lint frontmatter (CRLF-safety): ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
