// Marketing — top-level page with in-page sub-tabs (Sequences / Inboxes /
// Replies / Settings). Mirrors SettingsLayout.jsx — centered page-head +
// pill nav — scoped to the page so we don't crowd the global Settings sidebar.

import { useState } from 'react';
import { usePermission } from '../hooks/usePermission';
import SequencesTab from './marketing/SequencesTab';
import InboxesTab from './marketing/InboxesTab';
import RepliesTab from './marketing/RepliesTab';
import SettingsTab from './marketing/SettingsTab';

const TABS = [
  { key: 'sequences', label: 'Sequences' },
  { key: 'inboxes',   label: 'Inboxes' },
  { key: 'replies',   label: 'Replies' },
  { key: 'settings',  label: 'Settings' },
];

export default function Marketing() {
  const [active, setActive] = useState('sequences');
  const canManage = usePermission('marketing.manage');
  const canConnect = usePermission('marketing.connectInbox');
  const [createOpen, setCreateOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);

  return (
    <>
      <div className="page-head settings-page-head">
        <div className="page-head-text">
          <h1 className="page-head-title">Marketing</h1>
        </div>
        <div className="page-head-actions">
          {active === 'sequences' && canManage && (
            <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>New sequence</button>
          )}
          {active === 'inboxes' && canConnect && (
            <button className="btn btn-primary" onClick={() => setConnectOpen(true)}>Connect Gmail</button>
          )}
        </div>
      </div>

      <div className="marketing-tabs">
        <div className="tab-container tab-container-line" role="tablist" aria-label="Marketing">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active === t.key}
              className={`tab-btn ${active === t.key ? 'active' : ''}`}
              onClick={() => setActive(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-content">
        {active === 'sequences' && (
          <SequencesTab
            createOpen={createOpen}
            onOpenCreate={() => setCreateOpen(true)}
            onCloseCreate={() => setCreateOpen(false)}
          />
        )}
        {active === 'inboxes' && (
          <InboxesTab
            connectOpen={connectOpen}
            onOpenConnect={() => setConnectOpen(true)}
            onCloseConnect={() => setConnectOpen(false)}
          />
        )}
        {active === 'replies' && <RepliesTab />}
        {active === 'settings' && <SettingsTab />}
      </div>
    </>
  );
}
