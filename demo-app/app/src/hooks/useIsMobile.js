import { useEffect, useState } from 'react';

// True when the viewport is at/below the breakpoint where the mobile sidebar
// (hamburger drawer) takes over from the persistent desktop rail. Keep the px
// value in sync with the 640px sidebar @media block in index.css.
const MOBILE_QUERY = '(max-width: 640px)';

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches
  );

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    // Sync once in case the viewport changed between first render and effect.
    setIsMobile(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}

export default useIsMobile;
