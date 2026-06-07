import { Link } from 'react-router-dom';
import { usePermission } from '../hooks/usePermission';
import { IS_DEMO } from '../demo/isDemo';

// "Home" is the app Dashboard — at the index for per-client product builds, and at
// /demo for the marketing demo (whose index is the product landing page).
const HOME_TO = IS_DEMO ? '/demo' : '/';

export default function RequirePerm({ perm, children, fallbackLabel }) {
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
        <h2>Page not available</h2>
        <p>You don&rsquo;t have access to{fallbackLabel ? ` ${fallbackLabel}` : ' this page'}.</p>
        <Link to={HOME_TO} className="btn btn-outline">Go home</Link>
      </div>
    </div>
  );
}
