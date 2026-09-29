// css-rules — a small, brace-aware reader of the app's stylesheets for the tests that hold UI rules
// (test-css-duplicates, test-field-primitives, test-control-parity).
//
// A regex over `selector { body }` pairs cannot tell a top-level rule from one nested in an @media block, so a
// phone-only override would read as the desktop value. This walks the braces: each rule knows its selector
// list, its declarations and the @-block it sits in ('' at the top level).

/** Every style rule: [{ sels: [selector…], at: '@media (…)' | '', line, decl: { prop: value } }]. */
export function styleRules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const out = [];
  const walk = (from, to, at) => {
    let start = from;
    for (let i = from; i < to; i++) {
      if (text[i] === '}') { start = i + 1; continue; }
      if (text[i] !== '{') continue;
      const prelude = text.slice(start, i).trim();
      let depth = 1, j = i + 1;
      while (j < to && depth) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
      if (prelude.startsWith('@')) {
        if (/^@(media|supports|container|layer)\b/.test(prelude)) walk(i + 1, j - 1, prelude.replace(/\s+/g, ' '));
      } else {
        const decl = {};
        for (const part of text.slice(i + 1, j - 1).split(';')) {
          const k = part.split(':')[0].trim();
          const v = part.split(':').slice(1).join(':').trim();
          if (k && v && !/[{}]/.test(k)) decl[k] = v.replace(/\s+/g, ' ');
        }
        out.push({ sels: prelude.split(',').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean), at, line: text.slice(0, i).split('\n').length - (prelude.split('\n').length - 1), decl });
      }
      i = j - 1; start = j;
    }
  };
  walk(0, text.length, '');
  return out;
}

/** The declarations a selector gets from the rules in one scope ('' = top level), merged in source order. */
export function declared(css, sel, at = '') {
  const out = {};
  for (const r of styleRules(css)) {
    if (r.at !== at || !r.sels.includes(sel)) continue;
    Object.assign(out, r.decl);
  }
  return out;
}

/** The @media preludes that contain `needle` (e.g. 'max-width: 640px'). */
export function scopes(css, needle) {
  return [...new Set(styleRules(css).map((r) => r.at).filter((a) => a && a.includes(needle)))];
}
