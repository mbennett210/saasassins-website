import Icon from './Icon';

// The app-wide list-table search control. A compact field that sits in a standalone
// table's header row (beside any period pills), matching the warm field styling of
// .input; the × clears it. Controlled: pair with useTableSearch for URL-backed
// state and searchRows for the filtering. See UI_RULES §72.
export default function TableSearch({ value, onChange, placeholder = 'Search', ariaLabel }) {
  return (
    <div className={`table-search${value ? ' has' : ''}`}>
      <Icon name="search" size={15} className="table-search-icon" />
      <input
        type="search"
        className="table-search-input"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel || placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="input-clear"
        aria-label="Clear search"
        tabIndex={value ? 0 : -1}
        onClick={() => onChange('')}
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
