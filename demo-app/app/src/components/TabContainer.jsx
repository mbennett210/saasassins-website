export default function TabContainer({ tabs, active, onChange, className = '' }) {
  return (
    <div className={`tab-container ${className}`}>
      {tabs.map((t) => (
        <button
          key={t}
          className={`tab-btn ${active === t ? 'active' : ''}`}
          onClick={() => onChange(t)}
        >
          {t}
        </button>
      ))}
    </div>
  );
}
