import { useState } from 'react';
import Toggle from '../../components/Toggle';
import { useToast } from '../../components/Toast';
import { fetchHubEmailPrefs, saveHubEmailPrefs } from '../../lib/clientHubApi';
import { HUB_EMAIL_KINDS, resolveHubEmailPrefs } from '../../lib/hubEmailPrefs';
import { HUB_PREVIEW_NOTE } from '../../lib/hubPreview';
import { useHubRead } from './hubData';

// EMAILS (plan §3.4; Daniel 2026-10-08: "we need to have this be on the customer to set up"): the
// signed-in customer's OWN three email switches, on the Account page (its CARDS list). All on
// until they are turned off (lib/hubEmailPrefs.js — the same reader every sender checks, so the
// switch shown and the email sent can never disagree).
//
// A switch saves the moment it changes (POST /api/hub/email-prefs, that one key only, so two quick
// changes never overwrite each other) and says so with a toast. A save that fails puts the switch
// back and says the change wasn't saved. In the office's READ-ONLY preview (`readOnly`, UI_RULES
// §151) the switches are shown and disabled: nothing here is sent. A preview acting as the customer
// (the default) saves the building's stand-in's own switches; the demo saves its contact's.
const WORDS = Object.freeze({
  messages: { label: 'Replies from the office', help: 'An email when the office answers you in Messages.' },
  requests: { label: 'Updates on my requests', help: 'An email when a request you sent moves to a new stage or gets a reply.' },
  inspections: { label: 'New inspection reports', help: 'An email when a new inspection report is posted for one of your buildings.' },
});

export default function HubEmailsCard({ readOnly = false }) {
  const toast = useToast();
  const read = useHubRead(() => fetchHubEmailPrefs(), []);
  const [busy, setBusy] = useState({});
  const [problem, setProblem] = useState('');

  // A read-only preview that cannot read a customer's own row shows the defaults (every email on).
  const prefs = read.data ? resolveHubEmailPrefs(read.data.prefs) : (read.error && readOnly ? resolveHubEmailPrefs(null) : null);
  const setKind = (kind, on) => read.setData((d) => ({ ...(d || {}), prefs: { ...resolveHubEmailPrefs(d?.prefs), [kind]: on } }));

  const flip = async (kind, on) => {
    if (readOnly || busy[kind] || !prefs) return;
    const before = prefs[kind];
    setProblem('');
    setKind(kind, on);
    setBusy((b) => ({ ...b, [kind]: true }));
    try {
      const r = await saveHubEmailPrefs({ [kind]: on });
      setKind(kind, typeof r?.prefs?.[kind] === 'boolean' ? r.prefs[kind] : on);
      toast.success('Email settings saved.');
    } catch (e) {
      setKind(kind, before);
      setProblem(`That change wasn't saved. ${e?.message || 'Try again in a moment.'}`);
      toast.error("That change wasn't saved.");
    } finally {
      setBusy((b) => ({ ...b, [kind]: false }));
    }
  };

  let body;
  if (!prefs && read.error) {
    body = (
      <>
        <p className="text-sm">{read.error}</p>
        <div className="hub-actions"><button type="button" className="btn btn-outline" onClick={read.reload}>Try again</button></div>
      </>
    );
  } else if (!prefs) {
    body = <p className="text-sm text-muted">Loading…</p>;
  } else {
    body = (
      <ul className="hub-prefs">
        {HUB_EMAIL_KINDS.map((k) => (
          <li key={k} className="hub-pref">
            <label className="hub-pref-main">
              <span className="hub-pref-label">{WORDS[k].label}</span>
              <Toggle on={prefs[k]} onChange={(on) => flip(k, on)} disabled={readOnly || !!busy[k]} />
            </label>
            <span className="hub-pref-help text-xs">{WORDS[k].help}</span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section className="card hub-card">
      <h2 className="hub-card-title">Emails</h2>
      <p className="text-sm text-muted">Choose which emails we send you. They go to the email address above.</p>
      {body}
      {problem && <div className="form-error" role="alert">{problem}</div>}
      {readOnly && <p className="text-xs text-muted">{HUB_PREVIEW_NOTE}</p>}
    </section>
  );
}
