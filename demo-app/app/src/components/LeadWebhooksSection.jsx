// Inbound Lead Webhooks card for Settings → Integrations.
//
// A GHL-style manager for multiple named inbound webhooks, each with its own URL
// + bearer token + ingestion point (pipeline/stage/lifecycle/tags). A 3rd party
// (Zapier / Make / n8n) POSTs a flat JSON contact to the URL with the token in
// the Authorization header; it upserts through the same engine as the CSV
// importer. Distinct from the generic/financial inbound endpoints (WebhooksSection).
import { useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import Badge from './Badge';
import { useToast } from './Toast';
import { useStore } from '../store';
import { usePermission } from '../hooks/usePermission';
import { listEndpoints, updateEndpoint, deleteEndpoint, rotateWebhookToken } from '../lib/integrationsApi';
import LeadWebhookModal from './LeadWebhookModal';
import { SecretWithheld, canCopySecret } from './WebhooksSection';
import { usePagedRows } from '../hooks/usePagedRows';
import ListPager from './ListPager';

function leadUrl(slug) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/api/webhooks/leads/${slug}`;
}

const PAYLOAD_EXAMPLE = `{
  "email": "jane@acme.com",
  "phone": "555-0142",
  "firstName": "Jane",
  "lastName": "Doe",
  "company": "Acme Property Mgmt",
  "lifecycle": "lead",
  "source": "Facebook Lead Ad",
  "tags": ["Paid Social"],
  "notes": "Asked about nightly office cleaning"
}`;

export default function LeadWebhooksSection() {
  const toast = useToast();
  const state = useStore();
  const canManage = usePermission('integrations.manage');
  const [hooks, setHooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  const pipelines = useMemo(() => state.pipelines || [], [state.pipelines]);
  const tagById = useMemo(() => Object.fromEntries((state.tags || []).map((t) => [t.id, t.label])), [state.tags]);
  const pager = usePagedRows(hooks);

  // Human-readable "Master Pipeline · New Lead" from a stored lead_config.
  function destinationLabel(cfg) {
    if (!cfg || !cfg.pipelineId) return '—';
    const p = pipelines.find((x) => x.id === cfg.pipelineId);
    if (!p) return '—';
    const s = (p.stages || []).find((x) => x.key === cfg.stage);
    return `${p.label}${s ? ` · ${s.label}` : ''}`;
  }

  async function refresh() {
    try {
      const eps = await listEndpoints();
      setHooks((eps || []).filter((e) => e.purpose === 'lead_intake'));
    } catch { /* keep last */ } finally { setLoading(false); }
  }
  useEffect(() => {
    let alive = true;
    listEndpoints().then((eps) => {
      if (!alive) return;
      setHooks((eps || []).filter((e) => e.purpose === 'lead_intake'));
      setLoading(false);
    }).catch(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  function copy(text, label) { navigator.clipboard?.writeText(text); toast.success(`${label} copied`); }

  async function rotate(id) {
    if (!confirm('Rotate this token? The current token stops working immediately and any sender using it must be updated.')) return;
    try {
      const res = await rotateWebhookToken(id);
      if (res?.bearer_token) { copy(res.bearer_token, 'New token'); }
      toast.success('Token rotated. New token copied');
      refresh();
    } catch (e) { toast.error(e.message || 'Failed'); }
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <h3 className="dash-card-title" style={{ marginBottom: 0 }}><Icon name="clients" size={16} /> Inbound Lead Webhooks</h3>
        {canManage && (
          <button className="btn btn-primary" onClick={() => { setEditing(null); setModalOpen(true); }}>
            New lead webhook
          </button>
        )}
      </div>
      <p className="text-xs text-muted" style={{ margin: '8px 0 12px' }}>
        Receive leads from Zapier, Make, n8n, Facebook Lead Ads, or any tool that can POST JSON. Each webhook upserts
        the contact (matched by email → phone, blanks filled) and drops it at its configured pipeline + stage.
        {' '}<button type="button" className="linklike" onClick={() => setShowHelp((v) => !v)}>{showHelp ? 'Hide setup' : 'Setup instructions'}</button>
      </p>

      {showHelp && (
        <div className="webhook-help">
          <div className="text-xs" style={{ fontWeight: 600, marginBottom: 4 }}>1. Authenticate</div>
          <p className="text-xs text-muted" style={{ marginBottom: 8 }}>
            Send the webhook’s token in an <code>Authorization</code> header. Advanced senders can instead sign the
            raw body with HMAC-SHA256 and pass <code>X-CleanSpace-Signature: sha256=…</code> (the signing secret is the same one shown on generic endpoints).
          </p>
          <pre className="webhook-code">{`Authorization: Bearer <token>
Content-Type: application/json`}</pre>

          <div className="text-xs" style={{ fontWeight: 600, margin: '10px 0 4px' }}>2. POST a flat JSON contact</div>
          <p className="text-xs text-muted" style={{ marginBottom: 8 }}>
            At least one of <strong>email, phone, name, or company</strong> is required. Optional:
            {' '}<code>lifecycle</code> (lead/prospect/client/vendor), <code>source</code>, <code>tags</code> (names),
            {' '}<code>notes</code>, and <code>pipeline</code>/<code>stage</code> to override the default destination.
          </p>
          <pre className="webhook-code">{PAYLOAD_EXAMPLE}</pre>

          <div className="text-xs" style={{ fontWeight: 600, margin: '10px 0 4px' }}>3. Example (curl)</div>
          <pre className="webhook-code">{`curl -X POST "${leadUrl('<webhook-id>')}" \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '${'{'}"email":"jane@acme.com","firstName":"Jane","company":"Acme"${'}'}'`}</pre>
          <p className="text-xs text-muted" style={{ marginTop: 6 }}>
            Returns <code>200 {'{'}status, contactId{'}'}</code> (created / updated / skipped). 4xx = bad auth or payload; 5xx = retry.
          </p>

          <div className="text-xs" style={{ fontWeight: 600, margin: '10px 0 4px' }}>Wire up Zapier</div>
          <ol className="text-xs text-muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            <li>Trigger: your lead source (e.g. Facebook Lead Ads → “New Lead”).</li>
            <li>Action: <strong>Webhooks by Zapier → POST</strong>. URL = this webhook’s URL.</li>
            <li>Headers: <code>Authorization</code> = <code>Bearer &lt;token&gt;</code>.</li>
            <li>Data: map fields to <code>email</code>, <code>phone</code>, <code>firstName</code>, … then turn the Zap on.</li>
          </ol>
          <p className="text-xs text-muted" style={{ marginTop: 6 }}>
            Note: Webhooks by Zapier is a paid Zapier feature. <strong>Make</strong> and <strong>n8n</strong> send generic HTTP requests on cheaper tiers.
          </p>
        </div>
      )}

      {loading ? <p className="text-xs text-muted">Loading…</p> : hooks.length === 0 ? (
        <p className="text-xs text-muted">No lead webhooks yet.{canManage ? ' Create one to start receiving leads.' : ''}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Destination</th><th>URL</th><th>Token</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {pager.pageRows.map((e) => {
                const cfg = e.lead_config || {};
                const tags = (cfg.tagIds || []).map((id) => tagById[id]).filter(Boolean);
                return (
                  <tr key={e.id}>
                    <td>
                      <span className="truncate" title={e.name}>{e.name}</span>
                      {tags.length > 0 && <div className="text-xs text-muted truncate" style={{ marginTop: 2 }} title={tags.join(', ')}>{tags.join(', ')}</div>}
                    </td>
                    <td className="text-xs"><span className="truncate" title={destinationLabel(cfg)}>{destinationLabel(cfg)}</span></td>
                    <td><button className="btn btn-link btn-sm" onClick={() => copy(leadUrl(e.slug), 'URL')} style={{ wordBreak: 'break-all' }}><code style={{ fontSize: 11 }}>/api/webhooks/leads/{e.slug}</code></button></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {canCopySecret(e.bearer_token, canManage) ? <button className="btn btn-link btn-sm" onClick={() => copy(e.bearer_token, 'Token')}>Copy</button> : <SecretWithheld />}
                      {canManage && <button className="btn btn-link btn-sm" onClick={() => rotate(e.id)}>Rotate</button>}
                    </td>
                    <td><Badge variant={e.is_active ? 'green' : 'slate'}>{e.is_active ? 'Active' : 'Paused'}</Badge></td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {canManage && <>
                        <button className="btn btn-link btn-sm" onClick={() => { setEditing(e); setModalOpen(true); }}>Configure</button>
                        <button className="btn btn-link btn-sm" onClick={async () => { await updateEndpoint(e.id, { is_active: !e.is_active }); refresh(); }}>{e.is_active ? 'Pause' : 'Resume'}</button>
                        <button className="btn-icon" onClick={async () => { if (confirm('Delete this lead webhook?')) { await deleteEndpoint(e.id); refresh(); } }}><Icon name="trash" size={15} /></button>
                      </>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ListPager pager={pager} noun="webhooks" />

      <LeadWebhookModal
        open={modalOpen}
        endpoint={editing}
        onClose={() => setModalOpen(false)}
        onSaved={() => refresh()}
      />
    </div>
  );
}
