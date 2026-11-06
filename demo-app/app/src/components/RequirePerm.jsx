import { Link } from 'react-router-dom';
import { usePermission } from '../hooks/usePermission';
import { useT } from '../i18n/react';

export default function RequirePerm({ perm, children }) {
  const t = useT();
  const allowed = usePermission(perm);

  if (allowed) return children;

  return (
    <div className="no-access">
      <div className="no-access-card">
        <div className="no-access-icon" aria-hidden>
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3v.008M4.5 19.5h15a1.5 1.5 0 001.342-2.17l-7.5-13.5a1.5 1.5 0 00-2.684 0l-7.5 13.5A1.5 1.5 0 004.5 19.5z" />
          </svg>
        </div>
        <h2>{t('noAccess.title')}</h2>
        <p>{t('noAccess.body')}</p>
        <Link to="/" className="btn btn-outline">{t('noAccess.home')}</Link>
      </div>
    </div>
  );
}
