import { useEffect, useMemo, useState } from 'react';
import Badge from './Badge';
import { listHeartbeats } from '../lib/teamApi';
import { APP_BUILD } from '../lib/appBuild';

// Settings → Team: which app version each person's device was last seen on
// (Sept 1 hardening). Crew phones ran June-era demo-clock builds for months and
// nothing surfaced it — old builds cannot self-update OR report, so on this
// card SILENCE IS THE SIGNAL: a member with no heartbeat has never opened a
// current build and needs a phone refresh. Buffered/failed punch counts ride
// the same telemetry so stuck labor is a visible number, not a surprise.
const STALE_AFTER_MS = 7 * 24 * 3600 * 1000;

function fmtSeen(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.round(ms / 3600000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function AppVersionsCard({ users }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    listHeartbeats()
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e?.message || 'Could not load'); });
    return () => { alive = false; };
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    const byUser = new Map((data.rows || []).map((r) => [r.org_user_id, r]));
    // Floor the "newest" at the VIEWER's own build: if the entire fleet froze on
    // one stale build (an AutoUpdater regression), heartbeat rows alone would
    // agree with each other and render a false "fleet current".
    const newestBuild = Math.max(Number(data.newestBuild) || 0, Number(APP_BUILD) || 0);
    return (users || [])
      // active only: invited-but-never-signed-in members can't have a build yet,
      // and listing them as "never seen" would drown the real stale-phone signal.
      .filter((u) => u.status === 'active')
      .map((u) => {
        const hb = byUser.get(u.id) || null;
        const behind = hb && newestBuild && Number(hb.build) < newestBuild;
        const staleSeen = hb && (Date.now() - new Date(hb.last_seen).getTime() > STALE_AFTER_MS);
        const state = !hb ? 'never' : (behind || staleSeen) ? 'behind' : 'current';
        return { user: u, hb, state };
      })
      .sort((a, b) => {
        const rank = { never: 0, behind: 1, current: 2 };
        return rank[a.state] - rank[b.state] || a.user.name.localeCompare(b.user.name);
      });
  }, [data, users]);

  const attention = rows.filter((r) => r.state !== 'current').length;
  if (error) return null; // telemetry is an aid, never a blocker — hide on failure

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>App versions</h3>
        {data && (attention > 0
          ? <Badge variant="amber">{attention} need a refresh</Badge>
          : <Badge variant="green">fleet current</Badge>)}
      </div>
      <p className="text-xs text-muted" style={{ margin: '0 0 10px' }}>
        Last app version each person&rsquo;s device reported. &ldquo;Never seen&rdquo; means an old
        version that can&rsquo;t report — have them fully close and reopen the app.
      </p>
      {!data ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {rows.map(({ user, hb, state }) => (
            <div key={user.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, padding: '3px 0' }}>
              <span style={{ minWidth: 140, fontWeight: 600 }}>{user.name}</span>
              {state === 'never' && <Badge variant="red">never seen — refresh their app</Badge>}
              {state === 'behind' && <Badge variant="amber">behind · seen {fmtSeen(hb.last_seen)}</Badge>}
              {state === 'current' && <Badge variant="green">current · {fmtSeen(hb.last_seen)}</Badge>}
              {hb && (hb.pending_punches > 0 || hb.failed_punches > 0) && (
                <Badge variant="red">{hb.pending_punches + hb.failed_punches} unsynced punches</Badge>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
