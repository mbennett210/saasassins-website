import { useState } from 'react';
import FilterSelect from '../FilterSelect';
import MultiFacet from './MultiFacet';
import DateRangeFacet from './DateRangeFacet';
import SegmentedFacet from './SegmentedFacet';
import MobileSheet from '../MobileSheet';
import { useIsMobile } from '../../hooks/useIsMobile';
import { DATE_PRESETS } from '../../lib/filters/applyFilters';

// Renders an array of FilterSpecs into the shared .filter-bar. Stateless: the page
// owns state via useUrlFilters(specs) and passes values/setValue/clearAll/
// activeCount + ctx (e.g. { state, user }) for the option providers. One bar,
// reused by Scheduling, the Variance report, and QC. See CLEANSPACE_SWEPT.md §2.6.
//
// MOBILE (THEME_CLEANSPACE R9): the inline bar would stack 9 facets and bury the page
// content, so at <=640 it collapses to a single "Filters (N)" button that opens the
// facets in a bottom-sheet. The page content stays visible; filters are one tap away.
export default function FilterBar({ specs, values, setValue, clearAll, activeCount = 0, ctx, action }) {
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);

  const facets = specs.map((spec) => {
    const value = values[spec.key];
    const set = (v) => setValue(spec.key, v);
    const opts = spec.options ? (spec.options(ctx) || []) : (spec.staticOptions || []);

    if (spec.kind === 'multi') {
      return <MultiFacet key={spec.key} label={spec.label} value={value} options={opts} onChange={set} />;
    }
    if (spec.kind === 'dateRange') {
      return (
        <DateRangeFacet
          key={spec.key}
          label={spec.label}
          value={value}
          presets={spec.presets || DATE_PRESETS}
          onChange={set}
        />
      );
    }
    if (spec.kind === 'toggle') {
      return <SegmentedFacet key={spec.key} label={spec.label} value={value} options={opts} onChange={set} />;
    }
    // single
    return (
      <div className="facet facet-single" key={spec.key}>
        <FilterSelect value={value} onChange={set} options={opts} ariaLabel={spec.label} />
      </div>
    );
  });

  if (isMobile) {
    return (
      <div className="filter-bar-mobile">
        <button
          type="button"
          className={`btn btn-secondary filter-open-btn${activeCount > 0 ? ' has-active-filter' : ''}`}
          onClick={() => setSheetOpen(true)}
          aria-haspopup="dialog"
        >
          <span aria-hidden="true">⚲</span>
          <span className="filter-open-label">Filters{activeCount > 0 ? ` (${activeCount})` : ''}</span>
        </button>
        {action && <div className="filter-bar-action">{action}</div>}
        <MobileSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          title="Filters"
          footer={(
            <>
              <button
                type="button"
                className="btn btn-link facet-clear-all"
                onClick={clearAll}
                disabled={activeCount === 0}
              >
                Clear all{activeCount > 0 ? ` (${activeCount})` : ''}
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setSheetOpen(false)}>
                Show results
              </button>
            </>
          )}
        >
          {facets}
        </MobileSheet>
      </div>
    );
  }

  return (
    <div className="filter-bar filter-bar-facets">
      {facets}
      {activeCount > 0 && (
        <button type="button" className="btn btn-link facet-clear-all" onClick={clearAll}>
          Clear all ({activeCount})
        </button>
      )}
      {action && <div className="filter-bar-action">{action}</div>}
    </div>
  );
}
