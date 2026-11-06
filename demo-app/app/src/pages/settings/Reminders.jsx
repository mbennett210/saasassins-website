// Settings → Customer Reminders — every automated message to a customer or a prospect (Matt's
// approved messages, 2026-10-19): one row each, grouped as the Review "Drafts" page groups them,
// with its on/off switch, when it goes, whether it is an email or a text, and its words (Matt's
// approved wording by default; editable here, "Reset to approved wording" puts it back). (The
// link field the review requests needed left with them when Google reviews went, 2026-10-20.)
//
// The messages are SENT BY THE SERVER (api/reminders/run.js, every five minutes) — never from a
// tab — from the Google system sender; texts through Twilio once it is set up. Nothing ever goes to
// a sample record. The catalog (lib/customerMessages.js) is the one list: the welcome email, which
// has no trigger, shows its reason and no switch; a message with a trigger whose template is not
// stored yet says "Not added yet" (the release data-op adds it).
//
// Styling: the Marketing → Settings shape (card detail-card + pref-row + Toggle), kit components.
import { useEffect, useState } from 'react';
import { useStore, useDispatch } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { selectReminderTemplates } from '../../store/selectors';
import { usePermission } from '../../hooks/usePermission';
import { useToast } from '../../components/Toast';
import Toggle from '../../components/Toggle';
import Badge from '../../components/Badge';
import AutoGrowTextarea from '../../components/AutoGrowTextarea';
import { CUSTOMER_MESSAGES, MESSAGE_GROUPS, MESSAGE_KEY } from '../../lib/customerMessages';
import { smsStatus } from '../../lib/integrationsApi';

const SHOWN = CUSTOMER_MESSAGES.filter((m) => m.built || m.key === MESSAGE_KEY.welcome);

function MessageRow({ message, template, canEdit, onToggle, onSave }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ subject: '', body: '' });
  const startEdit = () => { setDraft({ subject: template?.subject ?? message.subject, body: template?.body ?? message.body }); setOpen(true); };
  const changed = template && (template.subject !== message.subject || template.body !== message.body);
  const live = message.built && template;
  return (
    <div className="pref-row reminder-row">
      <div className="pref-row-text">
        <div className="pref-row-label">
          {message.label}
          <span className="reminder-row-badges">
            <Badge variant="slate">{message.channel === 'sms' ? 'Text' : 'Email'}</Badge>
            {changed && <Badge variant="amber">Edited</Badge>}
          </span>
        </div>
        <div className="pref-row-desc">{message.when}</div>
        {live && !open && (
          <button type="button" className="btn btn-link reminder-row-edit" onClick={startEdit}>
            {canEdit ? 'Edit the words' : 'See the words'}
          </button>
        )}
        {open && (
          <div className="reminder-row-editor">
            {message.channel === 'email' && (
              <label className="form-label">Subject
                <input className="input" value={draft.subject} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
              </label>
            )}
            <label className="form-label">{message.channel === 'sms' ? 'Text' : 'Message'}
              <AutoGrowTextarea value={draft.body} rows={4} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            </label>
            <p className="form-help">
              Words in braces fill in for each customer: {'{first_name}'}, {'{site_name}'}, {'{date}'}, {'{time}'}, {'{company}'} and so on.
              {message.transactional === false && ' An unsubscribe line is added at the end.'}
            </p>
            <div className="reminder-row-actions">
              {canEdit && <button type="button" className="btn btn-primary" onClick={() => { onSave(template, draft); setOpen(false); }}>Save</button>}
              {canEdit && changed && (
                <button type="button" className="btn btn-outline" onClick={() => { onSave(template, { subject: message.subject, body: message.body }); setOpen(false); }}>
                  Reset to approved wording
                </button>
              )}
              <button type="button" className="btn btn-outline" onClick={() => setOpen(false)}>Close</button>
            </div>
          </div>
        )}
      </div>
      {live
        ? <Toggle on={template.enabled === true} onChange={(v) => canEdit && onToggle(template, v)} />
        : <Badge variant="slate">{message.built ? 'Not added yet' : 'Not sent'}</Badge>}
    </div>
  );
}

export default function SettingsReminders() {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const canEdit = usePermission('reminders.edit');
  const templates = selectReminderTemplates(state) || [];
  const byKey = new Map(templates.map((t) => [t.key, t]));
  const [texting, setTexting] = useState(null);   // null = unknown, true / false
  useEffect(() => {
    let alive = true;
    smsStatus().then((s) => { if (alive) setTexting(s?.configured === true); }).catch(() => { if (alive) setTexting(null); });
    return () => { alive = false; };
  }, []);

  const setEnabled = (tpl, on) => {
    dispatch({ type: ACTIONS.UPDATE_REMINDER_TEMPLATE, id: tpl.id, patch: { enabled: on } });
    const m = CUSTOMER_MESSAGES.find((x) => x.key === tpl.key);
    toast.success(`${m?.label || 'Message'} turned ${on ? 'on' : 'off'}`);
  };
  const saveWords = (tpl, { subject, body }) => {
    dispatch({ type: ACTIONS.UPDATE_REMINDER_TEMPLATE, id: tpl.id, patch: { subject, body } });
    toast.success('Saved');
  };

  return (
    <div className="marketing-settings">
      <div className="card detail-card">
        <div className="section-head"><h3>Customer messages</h3></div>
        <p className="marketing-tab-intro">
          The emails and texts your customers get around their service, in the words you approved.
          The server sends them on a schedule, whether or not anyone has the app open: only between
          9 AM and 7 PM your time (receipts and “on my way” go at once), and never to a customer marked
          Do Not Contact or opted out. Emails go from your company mailbox in Settings → Integrations.
        </p>
        {texting === false && (
          <div className="callout callout-info">
            Texting isn’t set up yet, so the text messages are waiting. They start once Twilio is
            connected in Settings → Integrations.
          </div>
        )}
        {!canEdit && <p className="form-help">You have view-only access to these settings.</p>}
      </div>

      {MESSAGE_GROUPS.map((g) => {
        const rows = SHOWN.filter((m) => m.group === g.id);
        if (!rows.length) return null;
        return (
          <div className="card detail-card" key={g.id}>
            <div className="section-head"><h3>{g.label}</h3></div>
            {rows.map((m) => (
              <MessageRow key={m.key} message={m} template={byKey.get(m.key)} canEdit={canEdit} onToggle={setEnabled} onSave={saveWords} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
