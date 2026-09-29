import { Link } from 'react-router-dom';
import { HOME_PATH } from '../demo/demoConfig';

export default function NotFound() {
  return (
    <div className="notfound">
      <div className="notfound-card">
        <h1>404</h1>
        <p>That page doesn&rsquo;t exist. Or your role can&rsquo;t see it.</p>
        <Link to={HOME_PATH} className="btn btn-primary">Back to Dashboard</Link>
      </div>
    </div>
  );
}
