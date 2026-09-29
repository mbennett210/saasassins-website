// Webhooks manager for Settings → Integrations. Inbound endpoints (receive
// HMAC-signed JSON, e.g. the Google Sheet → Financial Snapshot) + outbound
// webhooks (POST signed JSON on events). Self-contained card.
import { useEffect, useState } from 'react';
import Icon from './Icon';
import Badge from './Badge';
import { useToast } from './Toast';
import { usePermission } from '../hooks/usePermission';
import {
  listEndpoints, createEndpoint, updateEndpoint, deleteEndpoint,
  listOutbound, createOutbound, updateOutbound, deleteOutbound, isStubMode,
} from '../lib/integrationsApi';
import { usePagedRows } from '../hooks/usePagedRows';
import ListPager from './ListPager';
import { IDENTITY } from '../brand/identity.generated.js';

function inboundUrl(slug) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/api/settings/inbound/${slug}`;
}

// A signing secret or lead token is a credential: the server sends one only to someone it
// lets manage integrations (the Super Admin by role, or integrations.manage), so live, the
// secret being on the row IS the answer. That keeps the Copy button right when this tab's
// matrix is stale, and never copies "undefined". The demo's local stub keeps every secret,
// so there the permission decides. Anyone else sees it masked, like a door code.
export function canCopySecret(secret, canManage) {
  return !!secret && (canManage || !isStubMode());
}

export function SecretWithheld() {
  return <span className="text-muted" title="Only people who can manage integrations can copy this.">••••</span>;
}

export default function WebhooksSection() {
  const toast = useToast();
  const canManage = usePermission('integrations.manage');
  const [endpoints, setEndpoints] = useState([]);
  const [outbound, setOutbound] = useState([]);
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('financial_snapshot');
  const [obUrl, setObUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const inPager = usePagedRows(endpoints);
  const outPager = usePagedRows(outbound);

  // Lead-intake endpoints are managed in their own card (LeadWebhooksSection) —
  // this generic table covers only financial-snapshot + generic log endpoints.
  const notLead = (eps) => (eps || []).filter((e) => e.purpose !== 'lead_intake');

  async function refresh() {
    try {
      const [eps, obs] = await Promise.all([listEndpoints(), listOutbound()]);
      setEndpoints(notLead(eps)); setOutbound(obs);
    } catch { /* keep last */ } finally { setLoading(false); }
  }
  useEffect(() => {
    let alive = true;
    Promise.all([listEndpoints(), listOutbound()]).then(([eps, obs]) => {
      if (!alive) return;
      setEndpoints(notLead(eps)); setOutbound(obs); setLoading(false);
    }).catch(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  function copy(text, label) { navigator.clipboard?.writeText(text); toast.success(`${label} copied`); }

  async function addInbound() {
    try {
      await createEndpoint({ name: name.trim() || 'Inbound webhook', purpose });
      setName(''); toast.success('Inbound endpoint created'); refresh(); inPager.goToLast();
    } catch (e) { toast.error(e.message || 'Failed'); }
  }
  async function addOutbound() {
    if (!/^https?:\/\//.test(obUrl.trim())) { toast.error('Enter a valid http(s) URL'); return; }
    try { await createOutbound({ url: obUrl.trim() }); setObUrl(''); toast.success('Outbound webhook added'); refresh(); outPager.goToLast(); }
    catch (e) { toast.error(e.message || 'Failed'); }
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <h3 className="dash-card-title"><Icon name="repeat" size={16} /> Webhooks</h3>
      <p className="text-xs text-muted" style={{ marginBottom: 12 }}>
        Push data into {IDENTITY.name} (inbound) or send events out (outbound). All payloads are JSON, signed with HMAC-SHA256 (<code>X-CleanSpace-Signature: sha256=…</code>).
      </p>

      {/* Inbound */}
      <div style={{ marginBottom: 16 }}>
        <div className="text-xs text-muted" style={{ fontWeight: 600, marginBottom: 6 }}>INBOUND ENDPOINTS</div>
        {canManage && (
          <div className="webhook-add-row">
            <div style={{ flex: 1 }}>
              <label className="form-label">Name</label>
              <input className="input" value={name} placeholder="e.g. Financial sheet" onChange={(e) => setName(e.target.value)} />
            </div>
            <div style={{ minWidth: 0 }}>
              <label className="form-label">Purpose</label>
              <select className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
                <option value="financial_snapshot">Financial Snapshot (dashboard)</option>
                <option value="generic">Generic (log only)</option>
              </select>
            </div>
            <button className="btn btn-primary" onClick={addInbound}>Add</button>
          </div>
        )}
        {loading ? <p className="text-xs text-muted">Loading…</p> : endpoints.length === 0 ? (
          <p className="text-xs text-muted">No inbound endpoints yet.</p>
        ) : (
          <div className="table-wrap mobile-stack">
            <table>
              <thead><tr><th>Name</th><th>URL</th><th>Secret</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {inPager.pageRows.map((e) => (
                  <tr key={e.id}>
                    <td className="cell-primary"><span className="truncate" title={e.name}>{e.name}{e.purpose === 'financial_snapshot' && <Badge variant="blue" style={{ marginLeft: 6 }}>snapshot</Badge>}</span></td>
                    <td data-label="URL"><button className="btn btn-link btn-sm" onClick={() => copy(inboundUrl(e.slug), 'URL')} style={{ wordBreak: 'break-all' }}><code style={{ fontSize: 11 }}>/api/settings/inbound/{e.slug}</code></button></td>
                    <td data-label="Secret">{canCopySecret(e.signing_secret, canManage) ? <button className="btn btn-link btn-sm" onClick={() => copy(e.signing_secret, 'Secret')}>Copy secret</button> : <SecretWithheld />}</td>
                    <td data-label="Status"><Badge variant={e.is_active ? 'green' : 'slate'}>{e.is_active ? 'Active' : 'Paused'}</Badge></td>
                    <td className="cell-actions" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {canManage && <>
                        <button className="btn btn-link btn-sm" onClick={async () => { await updateEndpoint(e.id, { is_active: !e.is_active }); refresh(); }}>{e.is_active ? 'Pause' : 'Resume'}</button>
                        <button className="btn-icon" onClick={async () => { if (confirm('Delete endpoint?')) { await deleteEndpoint(e.id); refresh(); } }}><Icon name="trash" size={15} /></button>
                      </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ListPager pager={inPager} noun="endpoints" />
      </div>

      {/* Outbound */}
      <div>
        <div className="text-xs text-muted" style={{ fontWeight: 600, marginBottom: 6 }}>OUTBOUND WEBHOOKS</div>
        {canManage && (
          <div className="webhook-add-row">
            <div style={{ flex: 1 }}>
              <label className="form-label">Endpoint URL</label>
              <input className="input" value={obUrl} placeholder={`https://example.com/webhooks/${IDENTITY.slug}`} onChange={(e) => setObUrl(e.target.value)} />
            </div>
            <button className="btn btn-primary" onClick={addOutbound}>Add</button>
          </div>
        )}
        {outbound.length === 0 ? (
          <p className="text-xs text-muted">No outbound webhooks yet.</p>
        ) : (
          <div className="table-wrap mobile-stack">
            <table>
              <thead><tr><th>URL</th><th>Secret</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {outPager.pageRows.map((w) => (
                  <tr key={w.id}>
                    <td className="cell-primary" style={{ wordBreak: 'break-all' }}>{w.url}</td>
                    <td data-label="Secret">{canCopySecret(w.secret, canManage) ? <button className="btn btn-link btn-sm" onClick={() => copy(w.secret, 'Secret')}>Copy secret</button> : <SecretWithheld />}</td>
                    <td data-label="Status"><Badge variant={w.is_active ? 'green' : 'slate'}>{w.is_active ? 'Active' : 'Paused'}</Badge></td>
                    <td className="cell-actions" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {canManage && <>
                        <button className="btn btn-link btn-sm" onClick={async () => { await updateOutbound(w.id, { is_active: !w.is_active }); refresh(); }}>{w.is_active ? 'Pause' : 'Resume'}</button>
                        <button className="btn-icon" onClick={async () => { if (confirm('Delete webhook?')) { await deleteOutbound(w.id); refresh(); } }}><Icon name="trash" size={15} /></button>
                      </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ListPager pager={outPager} noun="webhooks" />
      </div>
    </div>
  );
}
