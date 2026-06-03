// Settings tab — global Marketing settings.
//   - Default Reply Routing: the reply-routing new sequences inherit (pipeline
//     + stage + enabled toggle). Each sequence overrides it in its own editor.
//   - Defaults: plain-text default, sending timezone, default send window,
//     and the per-inbox sending pace (minutes between sends).

import { useState } from 'react';
import { useStore, useDispatch } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { selectMarketingSettings, selectNonMasterPipelines } from '../../store/selectors';
import { usePermission } from '../../hooks/usePermission';
import { useToast } from '../../components/Toast';
import FormField from '../../components/FormField';
import Toggle from '../../components/Toggle';

const HOURS = Array.from({ length: 24 }, (_, h) => ({
  value: String(h),
  label: `${((h % 12) || 12)}:00 ${h < 12 ? 'AM' : 'PM'}`,
}));

// The device's own timezone — shown as the "Automatic" default so the user
// sees which zone sends will use before they change anything.
const DETECTED_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
})();

// Curated timezone list. Value '' = Automatic (follow the device/user tz).
const TIMEZONES = [
  { value: '',                    label: `Automatic — this device (${DETECTED_TZ})` },
  { value: 'America/New_York',    label: 'Eastern Time — New York' },
  { value: 'America/Chicago',     label: 'Central Time — Chicago' },
  { value: 'America/Denver',      label: 'Mountain Time — Denver' },
  { value: 'America/Phoenix',     label: 'Mountain, no DST — Phoenix' },
  { value: 'America/Los_Angeles', label: 'Pacific Time — Los Angeles' },
  { value: 'America/Anchorage',   label: 'Alaska Time — Anchorage' },
  { value: 'Pacific/Honolulu',    label: 'Hawaii Time — Honolulu' },
  { value: 'UTC',                 label: 'UTC' },
];

// Per-inbox send-throttle presets (minutes). The scheduler ticks once a
// minute, so one minute is the practical floor.
const SEND_INTERVALS = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60].map((m) => ({
  value: String(m),
  label: m === 1 ? '1 minute' : `${m} minutes`,
}));

export default function SettingsTab() {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const canManage = usePermission('marketing.manage');
  const settings = selectMarketingSettings(state);
  // The Master Pipeline can't be a reply-routing target — it has no real
  // stages, so replies route only to the normal pipelines.
  const pipelines = selectNonMasterPipelines(state);

  const rr = settings.replyRouting || {};
  const sw = settings.defaultSendWindow || { start: 9, end: 17 };

  // Local working copy so the user can stage edits then Save.
  const [draft, setDraft] = useState({
    enabled: rr.enabled === true,
    pipelineId: rr.pipelineId || '',
    stageKey: rr.stageKey || '',
    plainTextDefault: settings.plainTextDefault === true,
    windowStart: String(sw.start ?? 9),
    windowEnd: String(sw.end ?? 17),
    sendTimezone: settings.sendTimezone || '',
    sendIntervalMinutes: String(settings.sendIntervalMinutes ?? 5),
  });

  const selectedPipeline = pipelines.find((p) => p.id === draft.pipelineId) || null;
  const stages = selectedPipeline ? (selectedPipeline.stages || []) : [];

  // Ensure a previously-saved tz that isn't in the curated list still shows.
  const tzOptions = TIMEZONES.some((t) => t.value === draft.sendTimezone)
    ? TIMEZONES
    : [...TIMEZONES, { value: draft.sendTimezone, label: draft.sendTimezone }];

  function patch(next) {
    setDraft((d) => ({ ...d, ...next }));
  }

  function handlePipelineChange(e) {
    // Reset stage when the pipeline changes — old stage key won't exist.
    patch({ pipelineId: e.target.value, stageKey: '' });
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
          pipelineId: draft.pipelineId || null,
          stageKey: draft.stageKey || null,
        },
        plainTextDefault: draft.plainTextDefault,
        defaultSendWindow: { start, end },
        sendTimezone: draft.sendTimezone || null,
        sendIntervalMinutes: Number(draft.sendIntervalMinutes) || 5,
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
          The reply-routing new sequences start with — which pipeline stage a
          contact moves to when they reply. Each sequence overrides this in its
          own editor under Reply handling; existing sequences keep their setting.
        </p>
        <div className="pref-row">
          <div className="pref-row-text">
            <div className="pref-row-label">Route replies to a pipeline stage</div>
            <div className="pref-row-desc">New sequences inherit this. Turn off to create them with reply-routing disabled by default.</div>
          </div>
          <Toggle on={draft.enabled} onChange={(v) => patch({ enabled: v })} />
        </div>
        {draft.enabled && (
          <div className="form-row marketing-settings-routing">
            <FormField
              label="Pipeline"
              name="rr-pipeline"
              as="select"
              value={draft.pipelineId}
              onChange={handlePipelineChange}
              placeholder="Select a pipeline…"
              options={pipelines.map((p) => ({ value: p.id, label: p.label }))}
              disabled={!canManage}
            />
            <FormField
              label="Stage"
              name="rr-stage"
              as="select"
              value={draft.stageKey}
              onChange={(e) => patch({ stageKey: e.target.value })}
              placeholder={selectedPipeline ? 'Select a stage…' : 'Pick a pipeline first'}
              options={stages.map((st) => ({ value: st.key, label: st.label }))}
              disabled={!canManage || !selectedPipeline}
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
          help="Every step's send-window hours are interpreted in this timezone. Defaults to this device's timezone."
        />
        <div className="form-row marketing-settings-window">
          <FormField
            label="Default send window — from"
            name="sw-start"
            as="select"
            value={draft.windowStart}
            onChange={(e) => patch({ windowStart: e.target.value })}
            options={HOURS}
            disabled={!canManage}
            help="Seeds the time range on new sequence steps."
          />
          <FormField
            label="Default send window — to"
            name="sw-end"
            as="select"
            value={draft.windowEnd}
            onChange={(e) => patch({ windowEnd: e.target.value })}
            options={HOURS}
            disabled={!canManage}
          />
        </div>
        <p className="marketing-tab-intro marketing-settings-pace-intro">
          Sending pace — each connected inbox waits at least this long between
          emails, so sends trickle out at a natural pace instead of going out
          in a burst. The limit applies per inbox — connect more inboxes to
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

      {canManage && (
        <div className="marketing-settings-save">
          <button className="btn btn-primary" onClick={handleSave}>Save settings</button>
        </div>
      )}
    </div>
  );
}
