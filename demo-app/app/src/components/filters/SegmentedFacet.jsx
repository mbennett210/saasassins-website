// A small segmented toggle for a 'toggle'-kind facet (e.g. crew-size Solo|2|3+,
// recurrence Any|Recurring|One-off). Reuses the .tab-container-line pill styling.
// options: [{ value, label }]; value is the selected segment.
export default function SegmentedFacet({ label, value, options = [], onChange }) {
  return (
    <div className="facet facet-segmented">
      {label && <span className="facet-label">{label}</span>}
      <div className="tab-container-line" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`tab-btn ${value === o.value ? 'active' : ''}`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
