import { useNavigate, useLocation } from 'react-router-dom';
import { useT } from '../i18n/react';
import { BACK_STATE } from '../lib/pageScroll';

export default function DetailHeader({ backTo, backLabel = null, title, subtitle, badge, actions, relationship }) {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const target = location.state?.from || backTo;
  // The referrer's label (in the reader's language), else the page's own, else "Back" (CS-193).
  const label = location.state?.fromLabel || backLabel || t('back.back');
  const handleClick = (e) => {
    e.preventDefault();
    // A Back: the shell puts the page where it was left (CS-960, UI_RULES §186).
    if (target) navigate(target, { state: BACK_STATE });
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
