// Free-text row filter for the app-wide table search. Case-insensitive; a query
// of several space-separated words is ANDed (every term must appear somewhere in
// the row's text), so "andre olas" matches a row naming both. `toText(row)`
// returns the searchable text for one row (name, location, status, whatever the
// table shows). An empty query returns the rows unchanged. See UI_RULES §72.
export function searchRows(rows, query, toText) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return rows || [];
  const terms = q.split(/\s+/).filter(Boolean);
  return (rows || []).filter((row) => {
    const hay = String(toText(row) || '').toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
