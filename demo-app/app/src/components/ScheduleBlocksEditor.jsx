import FormField from './FormField';
import CrewPicker from './CrewPicker';
import { normalizeHm } from '../lib/dates';
import Icon from './Icon';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Schedule blocks — one recurring job whose days can differ in time and crew.
// Each block owns a set of days + a time window + a crew; a day lives in exactly
// one block (picking it in another block moves it there). "Add schedule block"
// clones the FIRST block's time + crew as the starting point — copied at
// creation, fully independent afterwards. Used by NewJobModal (create) and
// JobDetail's edit-all-future scope (with lockDays: changing the day set means
// regenerating the series, so there the days are fixed and only time/crew edit).
export default function ScheduleBlocksEditor({ blocks, onChange, crewPool, lockDays = false, errors = {} }) {
  const toggleDay = (key, dow) => {
    if (lockDays) return;
    onChange(blocks.map((b) => {
      if (b.key === key) {
        const on = b.days.includes(dow);
        return { ...b, days: on ? b.days.filter((d) => d !== dow) : [...b.days, dow].sort((a, z) => a - z) };
      }
      // Stealing: picking a day here removes it from whichever block held it.
      return b.days.includes(dow) ? { ...b, days: b.days.filter((d) => d !== dow) } : b;
    }));
  };
  const patchBlock = (key, patch) => onChange(blocks.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  const addBlock = () => {
    const first = blocks[0];
    const key = Math.max(...blocks.map((b) => b.key)) + 1;
    // Default-crew rule: new blocks start with block 1's crew (and time) pre-selected.
    onChange([...blocks, { key, days: [], startTime: first.startTime, endTime: first.endTime, crewIds: [...(first.crewIds || [])] }]);
  };
  const removeBlock = (key) => onChange(blocks.filter((b) => b.key !== key));

  const ownerOf = (dow) => blocks.find((b) => b.days.includes(dow));

  return (
    <div className="schedule-blocks">
      {blocks.map((b, i) => {
        const err = errors[b.key] || {};
        return (
          <div key={b.key} className="schedule-block">
            <div className="schedule-block-head">
              <span className="schedule-block-title">Schedule block {i + 1}</span>
              {blocks.length > 1 && !lockDays && (
                <button type="button" className="btn-icon btn-icon-danger" title="Remove this block" aria-label="Remove this block" onClick={() => removeBlock(b.key)}><Icon name="trash" size={14} /></button>
              )}
            </div>
            <div className="day-picker" style={{ marginBottom: err.days ? 4 : 10 }}>
              {DAY_LABELS.map((label, dow) => {
                const owner = ownerOf(dow);
                const mine = owner?.key === b.key;
                const taken = !!owner && !mine;
                return (
                  <button
                    key={dow} type="button"
                    className={`chip chip-sm ${mine ? 'on' : ''}${taken ? ' taken' : ''}`}
                    disabled={lockDays}
                    title={taken && !lockDays ? `In schedule block ${blocks.indexOf(owner) + 1}. Click to move it here` : undefined}
                    onClick={() => toggleDay(b.key, dow)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {err.days && <div className="form-error" style={{ marginBottom: 8 }}>{err.days}</div>}
            <div className="form-row">
              {/* onBlur: auto-correct typed military/12-hour time on text-degraded
                  browsers (no type=time). Same guard as NewJobModal's single pair. */}
              <FormField label="Start" type="time" step={900} required error={err.startTime} value={b.startTime}
                onChange={(e) => patchBlock(b.key, { startTime: e.target.value })}
                onBlur={() => { const n = normalizeHm(b.startTime); if (n && n !== b.startTime) patchBlock(b.key, { startTime: n }); }} />
              <FormField label="End" type="time" step={900} required error={err.endTime} value={b.endTime}
                onChange={(e) => patchBlock(b.key, { endTime: e.target.value })}
                onBlur={() => { const n = normalizeHm(b.endTime); if (n && n !== b.endTime) patchBlock(b.key, { endTime: n }); }} />
            </div>
            <FormField label="Crew (these days)">
              <CrewPicker value={b.crewIds || []} onChange={(ids) => patchBlock(b.key, { crewIds: ids })} pool={crewPool} placeholder="Add crew…" />
            </FormField>
          </div>
        );
      })}
      {!lockDays && (
        <button type="button" className="add-tile" onClick={addBlock}>Add schedule block</button>
      )}
    </div>
  );
}
