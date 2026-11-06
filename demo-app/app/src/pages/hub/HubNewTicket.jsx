import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import BackLink from '../../components/BackLink';
import FormField from '../../components/FormField';
import Icon from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { createHubTicket, attachHubTicketPhoto } from '../../lib/clientHubApi';
import { hubTicketInput, HUB_TICKET_TEXT_MAX } from '../../lib/clientHubView';
import { RAISABLE_WO_TYPES, WO_TYPE_META, WO_CATEGORIES, WO_CATEGORY_META } from '../../lib/workOrders';
import { HUB_PREVIEW_NOTE } from '../../lib/hubPreview';
import { sectionPath, hubRequestArea, hubAreaPrefill } from './hubNav';
import { useHub } from './hubData';

// SEND A REQUEST (HUB-13, WO-4, WO-12) — Matt's word for a ticket on the customer side (decision
// D6, 2026-10-08). The customer says what kind of request it is, what it is about, and what is
// going on, may mark it urgent and may add a photo. Every message a customer sends is a request
// with its own conversation (HUB-13), so this is the only way in (Home's "New request" button,
// the Requests page).
//
// The same rule the server runs (clientHubView.hubTicketInput) checks the form before it is
// sent, so a refusal reads the same sentence here and from the server. The server then files
// it through the office's own path (origin 'portal'), and the building's account manager hears
// first (WO-6). The title is the first line of what they wrote: one question, not two.
const TYPE_HINTS = {
  complaint: 'Something was not done right.',
  request: 'You would like something added or changed.',
  issue: 'Something at the building needs attention.',
};

// In the office's READ-ONLY preview (the layout's `readOnly`, UI_RULES §151) the form is drawn as
// the customer sees it, every field and the send disabled, with the preview's sentence. A preview
// acting as the customer (the default) sends a real request, as the building's stand-in.
//
// FROM AN AREA'S PAGE (QR-16, QR Wave 2): "Make a request about this area" (pages/hub/HubArea) opens
// this form with the area in the history state — the text starts with the area's name ("Lobby: ")
// and the request carries the area's id (`siteAreaId`), which the server stores once it knows the
// key and ignores until then. Back returns to the area's page (its referrer).
export default function HubNewTicket() {
  const { buildingId } = useParams();
  const { readOnly } = useHub();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [area] = useState(() => hubRequestArea(location.state));
  const [form, setForm] = useState(() => ({ type: '', category: '', description: hubAreaPrefill(area), urgent: false }));
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const listHref = sectionPath(buildingId, 'tickets');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (busy || readOnly) return;
    const checked = hubTicketInput(form);
    if (checked.refused) { setError(checked.refused); return; }
    setError('');
    setBusy(true);
    try {
      const { ticket } = await createHubTicket({ buildingId, ...form, siteAreaId: area?.id || null });
      if (file) {
        // Best-effort: the ticket stands without it, and the page offers "Add a photo".
        try { await attachHubTicketPhoto({ buildingId, ticketId: ticket.id, file }); }
        catch (err) { toast.error(err?.message || 'The request was sent, but the photo did not upload. Add it from the request.'); }
      }
      toast.success('Request sent. Your account manager has it.');
      navigate(`${listHref}/${encodeURIComponent(ticket.id)}`, { replace: true, state: { from: listHref, fromLabel: 'Requests' } });
    } catch (err) {
      setError(err?.message || 'The request could not be sent. Try again.');
    } finally { setBusy(false); }
  };

  return (
    <div className="hub-page">
      <BackLink to={listHref} label="Requests" />
      <header className="hub-head">
        <h1 className="hub-title">New request</h1>
        <div className="hub-head-sub text-sm text-muted">It goes straight to your account manager, and you can follow it here.</div>
      </header>

      <form className="card hub-card hub-form" onSubmit={submit} noValidate>
        <FormField
          label="What kind of request is it?" name="type" as="select" required
          value={form.type} onChange={set('type')} placeholder="Choose one"
          options={RAISABLE_WO_TYPES.map((t) => ({ value: t, label: WO_TYPE_META[t].label }))}
          help={TYPE_HINTS[form.type]} disabled={readOnly}
        />
        <FormField
          label="What is it about?" name="category" as="select" required
          value={form.category} onChange={set('category')} placeholder="Choose one"
          options={WO_CATEGORIES.map((c) => ({ value: c, label: WO_CATEGORY_META[c].label }))}
          disabled={readOnly}
        />
        <FormField
          label="What is going on?" name="description" as="textarea" required rows={5}
          value={form.description} onChange={set('description')} maxLength={HUB_TICKET_TEXT_MAX}
          placeholder="Where, what, and anything that helps us fix it."
          help="The first line becomes the request's title." disabled={readOnly}
        />
        <label className="hub-check">
          <input type="checkbox" checked={form.urgent} disabled={readOnly} onChange={(e) => setForm((f) => ({ ...f, urgent: e.target.checked }))} />
          <span>
            <span className="hub-check-label">Urgent</span>
            <span className="text-xs text-muted"> It needs someone today. Your account manager can change this.</span>
          </span>
        </label>
        <div className="hub-actions">
          {readOnly ? (
            <button type="button" className="btn btn-secondary" disabled title={HUB_PREVIEW_NOTE}>
              <Icon name="camera" size={16} /> Add a photo (optional)
            </button>
          ) : (
            <label className="btn btn-secondary">
              <Icon name="camera" size={16} /> {file ? 'Change the photo' : 'Add a photo (optional)'}
              <input type="file" accept="image/*" hidden onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </label>
          )}
          {file && <span className="text-xs text-muted hub-file-name">{file.name}</span>}
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
        {readOnly && <p className="text-xs text-muted">{HUB_PREVIEW_NOTE}</p>}
        <div className="hub-actions hub-form-foot">
          <button type="submit" className="btn btn-primary" disabled={busy || readOnly}>{busy ? 'Sending…' : 'Send request'}</button>
        </div>
      </form>
    </div>
  );
}
