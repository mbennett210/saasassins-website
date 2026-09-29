export default function PageHeader({ title, actions }) {
  return (
    <div className="page-head">
      <div className="page-head-text">
        <h1 className="page-head-title">{title}</h1>
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </div>
  );
}
