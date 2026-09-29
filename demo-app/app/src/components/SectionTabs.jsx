// Underline section tabs for the detail pages (ContactDetail / ClientDetail).
// One panel shows at a time; clicking a tab switches to it. This replaces the
// earlier scroll-spy rail (a single long scrolling page) with familiar tabs.
//
// `sections` is [{ key, label, count? }] in tab order. The parent owns the
// active key (plain useState) and swaps which panel is visible.
export const sectionElementId = (key) => `detail-section-${key}`;

export default function SectionTabs({ sections, activeKey, onSelect }) {
  return (
    <div className="section-tabs" role="tablist">
      {sections.map((s) => {
        const active = s.key === activeKey;
        return (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={sectionElementId(s.key)}
            className={`section-tab ${active ? 'active' : ''}`}
            onClick={() => onSelect(s.key)}
          >
            {s.label}
            {s.count != null && <span className="section-tab-count">{s.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
