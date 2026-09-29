import { newId } from '../lib/ids';
import Icon from './Icon';

// Editor for a site's ordered cleaning areas: each = a label + per-area
// instructions (media attaches later). value = [{ id, label, instructions,
// mediaRefs }]; onChange(next). Controlled. Crew see these read-only on their
// schedule. See CLEANSPACE_SWEPT.md §5.3.
export default function CleaningAreasEditor({ value = [], onChange, readOnly = false }) {
  const areas = Array.isArray(value) ? value : [];
  const update = (id, patch) => onChange(areas.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const add = () => onChange([...areas, { id: newId('area'), label: '', instructions: '', mediaRefs: [] }]);
  const remove = (id) => onChange(areas.filter((a) => a.id !== id));
  const move = (idx, dir) => {
    const j = idx + dir;
    if (j < 0 || j >= areas.length) return;
    const next = areas.slice();
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(next);
  };

  if (readOnly) {
    if (areas.length === 0) return <p className="text-xs text-muted">No cleaning instructions yet.</p>;
    return (
      <div className="cleaning-areas">
        {areas.map((area) => (
          <div key={area.id} className="cleaning-area">
            <div className="cleaning-area-name">{area.label || 'Untitled area'}</div>
            <div className="cleaning-area-text">{area.instructions || '—'}</div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="cleaning-areas">
      {areas.length === 0 && (
        <p className="text-xs text-muted">No areas yet. Add the first (e.g. &quot;First floor&quot;, &quot;Restrooms&quot;, &quot;Garbage area&quot;).</p>
      )}
      {areas.map((area, idx) => (
        <div key={area.id} className="cleaning-area">
          <div className="cleaning-area-head">
            <input
              className="input input-ghost cleaning-area-label"
              placeholder="Area name. E.g. First floor"
              value={area.label}
              onChange={(e) => update(area.id, { label: e.target.value })}
            />
            <div className="cleaning-area-actions">
              <button type="button" className="btn-icon" aria-label="Move up" disabled={idx === 0} onClick={() => move(idx, -1)}>↑</button>
              <button type="button" className="btn-icon" aria-label="Move down" disabled={idx === areas.length - 1} onClick={() => move(idx, 1)}>↓</button>
              <button type="button" className="btn-icon btn-icon-danger" aria-label="Remove area" onClick={() => remove(area.id)}><Icon name="trash" size={14} /></button>
            </div>
          </div>
          <textarea
            className="input input-ghost cleaning-area-instructions"
            rows={2}
            placeholder="What to do in this area…"
            value={area.instructions}
            onChange={(e) => update(area.id, { instructions: e.target.value })}
          />
        </div>
      ))}
      <button type="button" className="btn btn-success cleaning-area-add" onClick={add}>Add area</button>
    </div>
  );
}
