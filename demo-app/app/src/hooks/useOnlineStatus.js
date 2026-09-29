import { useEffect, useState } from 'react';

// Reactive online/offline flag for field surfaces (crew audit C1). Crew work on the
// road, so photo/checklist surfaces warn clearly when there's no signal. Defaults to
// online when there's no navigator (SSR / odd webview) so nothing false-flags offline.
export function useOnlineStatus() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}
