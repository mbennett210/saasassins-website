import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import EmptyState from './EmptyState';
import Icon from './Icon';
import { useT } from '../i18n/react';

// What a screen shows when its code could not be fetched because the phone has no signal
// (CS-665). It used to be a reload, which offline lands on the browser's "no internet" page
// and loses the whole app. The app's frame (the nav, the bell) stays; this fills the page.
//
// It is part of the shell — App.jsx imports it statically — because it is exactly what has to
// show when nothing more can be downloaded. `onRetry` (from lazyRoute) loads the screen again:
// it fires by itself the moment the phone is back online, and on Try again.
// Every word is a catalog line in the reader's language (CS-193).
export default function OfflineScreen({ onRetry }) {
  const t = useT();
  const navigate = useNavigate();

  useEffect(() => {
    if (!onRetry) return undefined;
    const back = () => onRetry();
    window.addEventListener('online', back);
    return () => window.removeEventListener('online', back);
  }, [onRetry]);

  // Back to wherever the cleaner came from — My Day, usually, which works offline.
  const goBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) navigate(-1);
    else navigate('/', { replace: true });
  };

  return (
    <div className="page page-narrow offline-screen">
      <EmptyState
        icon={<Icon name="globe" size={28} />}
        title={t('offlineScreen.title')}
        message={t('offlineScreen.body')}
        action={(
          <div className="offline-screen-actions">
            <button type="button" className="btn btn-outline" onClick={goBack}>{t('offlineScreen.back')}</button>
            {onRetry ? <button type="button" className="btn btn-primary" onClick={onRetry}>{t('common.retry')}</button> : null}
          </div>
        )}
      />
    </div>
  );
}
