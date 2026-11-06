import { Link } from 'react-router-dom';
import { useT } from '../i18n/react';

export default function NotFound() {
  const t = useT();
  return (
    <div className="notfound">
      <div className="notfound-card">
        <h1>404</h1>
        <p>{t('notFound.body')}</p>
        <Link to="/" className="btn btn-primary">{t('notFound.home')}</Link>
      </div>
    </div>
  );
}
