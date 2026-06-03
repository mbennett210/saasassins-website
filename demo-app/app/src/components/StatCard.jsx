export default function StatCard({ value, label, trend, trendDirection = 'up' }) {
  return (
    <div className="stat-card">
      <div className="stat-val">{value}</div>
      <div className="stat-label">{label}</div>
      {trend && <div className={`stat-trend ${trendDirection}`}>{trend}</div>}
    </div>
  );
}
