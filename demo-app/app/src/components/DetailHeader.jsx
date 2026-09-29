import { useNavigate, useLocation } from 'react-router-dom';

export default function DetailHeader({ backTo, backLabel = 'Back', title, subtitle, badge, actions, relationship }) {
  const navigate = useNavigate();
  const location = useLocation();
  const target = location.state?.from || backTo;
  const label = location.state?.fromLabel || backLabel;
  const handleClick = (e) => {
    e.preventDefault();
    if (target) navigate(target);
    else navigate(-1);
  };
  return (
    <div className="detail-head">
      <div className="detail-head-top">
        <a href={target || '#'} className="detail-back" onClick={handleClick}>← {label}</a>
      </div>
      <div className="detail-head-body">
        <div className="detail-head-text">
          <div className="detail-head-title-row">
            <h1 className="detail-head-title">{title}</h1>
            {badge}
          </div>
          {subtitle && <p className="detail-head-subtitle">{subtitle}</p>}
          {relationship && <div className="detail-head-relationship">{relationship}</div>}
        </div>
        {actions && <div className="detail-head-actions">{actions}</div>}
      </div>
    </div>
  );
}
