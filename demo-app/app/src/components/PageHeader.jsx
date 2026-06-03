export default function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="page-head">
      <div className="page-head-text">
        <h1 className="page-head-title">{title}</h1>
        {subtitle && <p className="page-head-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </div>
  );
}
