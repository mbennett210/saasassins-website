import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="notfound">
      <div className="notfound-card">
        <h1>404</h1>
        <p>That page doesn&rsquo;t exist — or your role can&rsquo;t see it.</p>
        <Link to="/" className="btn btn-primary">Back to Dashboard</Link>
      </div>
    </div>
  );
}
