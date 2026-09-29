// Settings tab — global Marketing settings.
//   - Default Reply Routing: the reply-routing new sequences inherit (a Master
//     Pipeline stage + enabled toggle). Each sequence overrides it in its own editor.
//   - Defaults: plain-text default, sending timezone, default send window,
//     and the per-inbox sending pace (minutes between sends).

import { useState } from 'react';
import { useStore, useDispatch } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { selectMarketingSettings } from '../../store/selectors';
import { usePermission } from '../../hooks/usePermission';
import { useToast } from '../../components/Toast';
import FormField from '../../components/FormField';
import Toggle from '../../components/Toggle';
import { DEFAULT_ORG_TIMEZONE } from '../../lib/dates';
import Icon from '../../components/Icon';
import { IDENTITY } from '../../brand/identity.generated.js';

const HOURS = Array.from({ length: 24 }, (_, h) => ({
  value: String(h),
  label: `${((h % 12) || 12)}:00 ${h < 12 ? 'AM' : 'PM'}`,
}));



// The zone "Automatic" actually resolves to. NOT the device: sends are decided by
// the cron (TZ=UTC), so it falls back to the company timezone, then the app
// default — mirroring sendZone() in lib/marketingScheduler.js. Showing the device
// zone here was how an operator could set 9-5 and get 2am sends.
const AUTOMATIC_TZ = DEFAULT_ORG_TIMEZONE;

// Curated timezone list. Value '' = Automatic, which resolves to the COMPANY
// timezone (never the device — the drip engine is cron-owned and Vercel runs UTC,
// so a device fallback sent a 9-5 window at ~2am local). See sendZone() in
// lib/marketingScheduler.js.
const TIMEZONES = [
  { value: '',                    label: `Automatic, the company timezone (${AUTOMATIC_TZ})` },
  { value: 'America/New_York',    label: 'Eastern Time (New York)' },
  { value: 'America/Chicago',     label: 'Central Time (Chicago)' },
  { value: 'America/Denver',      label: 'Mountain Time (Denver)' },
  { value: 'America/Phoenix',     label: 'Mountain, no DST (Phoenix)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (Los Angeles)' },
  { value: 'America/Anchorage',   label: 'Alaska Time (Anchorage)' },
  { value: 'Pacific/Honolulu',    label: 'Hawaii Time (Honolulu)' },
  { value: 'UTC',                 label: 'UTC' },
];

// Per-inbox send-throttle presets (minutes). The scheduler ticks once a
// minute, so one minute is the practical floor.
const SEND_INTERVALS = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60].map((m) => ({
  value: String(m),
  label: m === 1 ? '1 minute' : `${m} minutes`,
}));

// Format a YYYY-MM-DD excluded date for display (parsed as local midnight so
// the calendar day doesn't drift across timezones).
function fmtExcludedDate(d) {
  try {
    return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch {
    return d;
  }
}

// Human label for where a suppression came from.
function suppressLabel(source) {
  if (source === 'reply') return 'replied opt-out';
  if (source === 'unsubscribe' || source === 'one-click') return 'unsubscribe link';
  return 'manual';
}

export default function SettingsTab() {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const canManage = usePermission('marketing.manage');
  const settings = selectMarketingSettings(state);
  // Replies advance the contact's company deal to a stage on the Master Pipeline
  // (the one sales board). New sequences inherit this default.
  const masterPipeline = (state.pipelines || []).find((p) => p.isMaster) || null;
  const masterId = masterPipeline?.id || null;
  const stages = masterPipeline?.stages || [];

  const rr = settings.replyRouting || {};
  const sw = settings.defaultSendWindow || { start: 9, end: 17 };

  // Local working copy so the user can stage edits then Save.
  const [draft, setDraft] = useState({
    enabled: rr.enabled === true,
    stageKey: rr.stageKey || '',
    plainTextDefault: settings.plainTextDefault === true,
    windowStart: String(sw.start ?? 9),
    windowEnd: String(sw.end ?? 17),
    sendTimezone: settings.sendTimezone || '',
    sendIntervalMinutes: String(settings.sendIntervalMinutes ?? 5),
    excludedDates: Array.isArray(settings.excludedDates) ? [...settings.excludedDates].sort() : [],
    unsubEnabled: settings.unsubscribe?.enabled !== false,
    unsubMessage: settings.unsubscribe?.message ?? 'Not interested? {unsubscribe} from these emails.',
    unsubLinkText: settings.unsubscribe?.linkText ?? 'Unsubscribe',
    unsubIncludeAddress: settings.unsubscribe?.includeAddress !== false,
    unsubAddress: settings.unsubscribe?.address ?? '',
    unsubBaseUrl: settings.unsubscribe?.baseUrl ?? '',
  });
  const [newDate, setNewDate] = useState('');
  const [newSuppress, setNewSuppress] = useState('');
  // Suppressions are immediate actions (a hard opt-out should take effect at
  // once), so they're dispatched live rather than staged in the Save draft.
  const suppressions = [...(state.marketingSuppressions || [])]
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  function addSuppression() {
    const email = newSuppress.trim().toLowerCase();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.error('Enter a valid email address.');
      return;
    }
    dispatch({ type: ACTIONS.ADD_MARKETING_SUPPRESSION, email, source: 'manual' });
    toast.success(`${email} won’t receive marketing email.`);
    setNewSuppress('');
  }
  function removeSuppression(email) {
    dispatch({ type: ACTIONS.REMOVE_MARKETING_SUPPRESSION, email });
    toast.info(`${email} removed from the suppression list.`);
  }

  // Ensure a previously-saved tz that isn't in the curated list still shows.
  const tzOptions = TIMEZONES.some((t) => t.value === draft.sendTimezone)
    ? TIMEZONES
    : [...TIMEZONES, { value: draft.sendTimezone, label: draft.sendTimezone }];

  // Live preview of the unsubscribe footer (representative — the real link is
  // signed server-side at send time).
  const unsubPreview = (() => {
    const msg = draft.unsubMessage || 'Not interested? {unsubscribe} from these emails.';
    const link = (draft.unsubLinkText || 'Unsubscribe').trim() || 'Unsubscribe';
    const co = state.company?.name || '';
    const addr = draft.unsubIncludeAddress
      ? (draft.unsubAddress.trim() || state.company?.address || '')
      : '';
    let body = msg.includes('{unsubscribe}')
      ? msg.split('{unsubscribe}').join(`${link} →`)
      : `${msg} ${link} →`;
    body = body.split('{company}').join(co);
    const identity = draft.unsubIncludeAddress ? [co, addr].filter(Boolean).join(' · ') : '';
    return [body, identity].filter(Boolean).join('\n');
  })();

  function patch(next) {
    setDraft((d) => ({ ...d, ...next }));
  }

  function addExcludedDate() {
    if (!newDate) return;
    setDraft((d) => (
      d.excludedDates.includes(newDate)
        ? d
        : { ...d, excludedDates: [...d.excludedDates, newDate].sort() }
    ));
    setNewDate('');
  }
  function removeExcludedDate(date) {
    setDraft((d) => ({ ...d, excludedDates: d.excludedDates.filter((x) => x !== date) }));
  }

  function handleSave() {
    const start = Number(draft.windowStart);
    const end = Number(draft.windowEnd);
    if (end <= start) {
      toast.error('Send window end must be after the start hour.');
      return;
    }
    dispatch({
      type: ACTIONS.UPDATE_MARKETING_SETTINGS,
      patch: {
        replyRouting: {
          enabled: draft.enabled,
          pipelineId: draft.stageKey ? masterId : null,
          stageKey: draft.stageKey || null,
        },
        plainTextDefault: draft.plainTextDefault,
        defaultSendWindow: { start, end },
        sendTimezone: draft.sendTimezone || null,
        sendIntervalMinutes: Number(draft.sendIntervalMinutes) || 5,
        excludedDates: draft.excludedDates,
        unsubscribe: {
          enabled: draft.unsubEnabled,
          message: draft.unsubMessage,
          linkText: draft.unsubLinkText,
          includeAddress: draft.unsubIncludeAddress,
          address: draft.unsubAddress.trim(),
          baseUrl: draft.unsubBaseUrl.trim(),
        },
      },
    });
    toast.success('Marketing settings saved');
  }

  return (
    <div className="marketing-settings">
      <div className="card detail-card">
        <div className="section-head">
          <h3>Reply Routing</h3>
        </div>
        <p className="marketing-tab-intro">
          The reply-routing new sequences start with. Which Master Pipeline stage a
          company's deal advances to when their contact replies. Each sequence overrides
          this in its own editor under Reply handling; existing sequences keep their setting.
        </p>
        <div className="pref-row">
          <div className="pref-row-text">
            <div className="pref-row-label">Advance the deal on reply</div>
            <div className="pref-row-desc">New sequences inherit this. Turn off to create them with reply-routing disabled by default.</div>
          </div>
          <Toggle on={draft.enabled} onChange={(v) => patch({ enabled: v })} />
        </div>
        {draft.enabled && (
          <div className="form-row marketing-settings-routing">
            <FormField
              label="Advance the deal to stage"
              name="rr-stage"
              as="select"
              value={draft.stageKey}
              onChange={(e) => patch({ stageKey: e.target.value })}
              placeholder="Select a stage…"
              options={stages.map((st) => ({ value: st.key, label: st.label }))}
              disabled={!canManage}
            />
          </div>
        )}
      </div>

      <div className="card detail-card">
        <div className="section-head">
          <h3>Defaults</h3>
        </div>
        <div className="pref-row">
          <div className="pref-row-text">
            <div className="pref-row-label">Plain-text default for new sequences</div>
            <div className="pref-row-desc">New sequences start with the "send all plain-text" toggle on. Each sequence can override this.</div>
          </div>
          <Toggle on={draft.plainTextDefault} onChange={(v) => patch({ plainTextDefault: v })} />
        </div>
        <FormField
          label="Sending timezone"
          name="send-tz"
          as="select"
          value={draft.sendTimezone}
          onChange={(e) => patch({ sendTimezone: e.target.value })}
          options={tzOptions}
          disabled={!canManage}
          help="Every step's send-window hours are interpreted in this timezone. Defaults to the company timezone."
        />
        <div className="form-row marketing-settings-window">
          <FormField
            label="Default send window (from)"
            name="sw-start"
            as="select"
            value={draft.windowStart}
            onChange={(e) => patch({ windowStart: e.target.value })}
            options={HOURS}
            disabled={!canManage}
            help="Seeds the time range on new sequence steps."
          />
          <FormField
            label="Default send window (to)"
            name="sw-end"
            as="select"
            value={draft.windowEnd}
            onChange={(e) => patch({ windowEnd: e.target.value })}
            options={HOURS}
            disabled={!canManage}
          />
        </div>
        <p className="marketing-tab-intro marketing-settings-pace-intro">
          Sending pace. Each connected inbox waits at least this long between
          emails, so sends trickle out at a natural pace instead of going out
          in a burst. The limit applies per inbox. Connect more inboxes to
          raise your overall sending rate.
        </p>
        <FormField
          label="Time between sends"
          name="send-interval"
          as="select"
          value={draft.sendIntervalMinutes}
          onChange={(e) => patch({ sendIntervalMinutes: e.target.value })}
          options={SEND_INTERVALS}
          disabled={!canManage}
          help="Applies to every rotation inbox. Default is 5 minutes."
        />
      </div>

      <div className="card detail-card">
        <div className="section-head">
          <h3>Excluded dates</h3>
        </div>
        <p className="marketing-tab-intro">
          Days the scheduler never sends on. Holidays or other blackout dates.
          A step scheduled to land on an excluded day automatically waits and
          resumes the next allowed day. Evaluated in the sending timezone above.
        </p>
        <div className="marketing-blackout-add">
          <label className="form-label" htmlFor="ff-excluded-date">Add a date</label>
          <div className="marketing-blackout-add-row">
            <input
              id="ff-excluded-date"
              name="excluded-date"
              type="date"
              className="input"
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
              disabled={!canManage}
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={addExcludedDate}
              disabled={!canManage || !newDate}
            >
              Add date
            </button>
          </div>
        </div>
        {draft.excludedDates.length > 0 ? (
          <ul className="marketing-blackout-list">
            {draft.excludedDates.map((d) => (
              <li key={d} className="marketing-blackout-item">
                <span>{fmtExcludedDate(d)}</span>
                <button
                  type="button"
                  className="btn-icon btn-icon-danger"
                  aria-label={`Remove ${fmtExcludedDate(d)}`}
                  onClick={() => removeExcludedDate(d)}
                  disabled={!canManage}
                >
                  <Icon name="trash" size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="marketing-blackout-empty text-sm text-muted">
            No excluded dates. Sends go out any day within the send window.
          </p>
        )}
      </div>

      <div className="card detail-card">
        <div className="section-head">
          <h3>Unsubscribe footer</h3>
        </div>
        <p className="marketing-tab-intro">
          Appended to the bottom of every marketing sequence email. Required by
          CAN-SPAM and by Gmail/Yahoo bulk-sender rules. Keep it on for cold
          outreach. The link is signed, so it keeps working even after a domain change.
        </p>
        <div className="pref-row">
          <div className="pref-row-text">
            <div className="pref-row-label">Include an unsubscribe footer</div>
            <div className="pref-row-desc">Adds the opt-out message plus a one-click List-Unsubscribe header to every send.</div>
          </div>
          <Toggle on={draft.unsubEnabled} onChange={(v) => patch({ unsubEnabled: v })} />
        </div>
        {!draft.unsubEnabled && (
          <p className="form-help">
            ⚠️ Sending marketing email without an unsubscribe option violates CAN-SPAM and hurts deliverability.
          </p>
        )}
        {draft.unsubEnabled && (
          <>
            <FormField
              label="Opt-out message"
              name="unsub-message"
              as="textarea"
              rows={2}
              value={draft.unsubMessage}
              onChange={(e) => patch({ unsubMessage: e.target.value })}
              disabled={!canManage}
              help="Use {unsubscribe} where the link should appear, and {company} for your company name."
            />
            <FormField
              label="Link text"
              name="unsub-linktext"
              value={draft.unsubLinkText}
              onChange={(e) => patch({ unsubLinkText: e.target.value })}
              placeholder="Unsubscribe"
              disabled={!canManage}
            />
            <div className="pref-row">
              <div className="pref-row-text">
                <div className="pref-row-label">Include mailing address</div>
                <div className="pref-row-desc">CAN-SPAM requires a valid physical postal address in every marketing email.</div>
              </div>
              <Toggle on={draft.unsubIncludeAddress} onChange={(v) => patch({ unsubIncludeAddress: v })} />
            </div>
            {draft.unsubIncludeAddress && (
              <FormField
                label="Mailing address"
                name="unsub-address"
                value={draft.unsubAddress}
                onChange={(e) => patch({ unsubAddress: e.target.value })}
                placeholder={state.company?.address || 'Your company mailing address'}
                disabled={!canManage}
                help="Leave blank to use your company address from Settings → Company."
              />
            )}
            <FormField
              label="Unsubscribe link domain"
              name="unsub-baseurl"
              value={draft.unsubBaseUrl}
              onChange={(e) => patch({ unsubBaseUrl: e.target.value })}
              placeholder={`https://app.${IDENTITY.company.domain}`}
              disabled={!canManage}
              help="Leave blank to use this app's domain automatically. If you move to a custom domain in production, set it here and keep the old domain redirecting so links already sent still work."
            />
            <div className="form-group">
              <div className="form-label">Preview</div>
              <div className="text-sm text-muted" style={{ whiteSpace: 'pre-line' }}>{unsubPreview}</div>
            </div>
          </>
        )}
      </div>

      <div className="card detail-card">
        <div className="section-head">
          <h3>Unsubscribes &amp; suppression list</h3>
        </div>
        <p className="marketing-tab-intro">
          Emails here never receive marketing sequence email. A hard opt-out
          (CAN-SPAM). Contacts are added automatically when they click the
          unsubscribe link or reply “unsubscribe”; add or remove addresses
          manually below. Changes take effect immediately (no Save needed).
        </p>
        <div className="marketing-blackout-add">
          <label className="form-label" htmlFor="ff-suppress-email">Suppress an email</label>
          <div className="marketing-blackout-add-row">
            <input
              id="ff-suppress-email"
              name="suppress-email"
              type="email"
              className="input"
              placeholder="name@example.com"
              value={newSuppress}
              onChange={(e) => setNewSuppress(e.target.value)}
              disabled={!canManage}
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={addSuppression}
              disabled={!canManage || !newSuppress.trim()}
            >
              Add
            </button>
          </div>
        </div>
        {suppressions.length > 0 ? (
          <ul className="marketing-blackout-list">
            {suppressions.map((s) => (
              <li key={s.email} className="marketing-blackout-item">
                <span>
                  {s.email}
                  <span className="text-sm text-muted">
                    {' · '}{suppressLabel(s.source)}
                    {s.createdAt ? ` · ${fmtExcludedDate(String(s.createdAt).slice(0, 10))}` : ''}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn-icon btn-icon-danger"
                  aria-label={`Remove ${s.email} from the suppression list`}
                  onClick={() => removeSuppression(s.email)}
                  disabled={!canManage}
                >
                  <Icon name="trash" size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="marketing-blackout-empty text-sm text-muted">
            No suppressed emails yet.
          </p>
        )}
      </div>

      {canManage && (
        <div className="marketing-settings-save">
          <button className="btn btn-primary" onClick={handleSave}>Save settings</button>
        </div>
      )}
    </div>
  );
}
