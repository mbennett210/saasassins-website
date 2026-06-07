import { Link } from 'react-router-dom';
import { IS_DEMO } from '../demo/isDemo';

// "Home" is the app Dashboard — at the index for per-client product builds, and at
// /demo for the marketing demo (whose index is the product landing page).
const HOME_TO = IS_DEMO ? '/demo' : '/';

export default function NotFound() {
  return (
    <div className="notfound">
      <div className="notfound-card">
        <h1>404</h1>
        <p>That page doesn&rsquo;t exist — or your role can&rsquo;t see it.</p>
        <Link to={HOME_TO} className="btn btn-primary">Back to Dashboard</Link>
      </div>
    </div>
  );
}
