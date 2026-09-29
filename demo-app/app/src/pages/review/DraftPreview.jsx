import { useMemo } from 'react';
import { IDENTITY } from '../../brand/identity.generated.js';

// The REAL draft preview (UI_RULES §98), moved out of the old Drafts page unchanged: a
// branded HTML document injects inline (scoped CSS, same as InspectionReportModal), a plain
// email renders as a text card, an SMS as a phone bubble. Driven by the draft's own
// render() — the same builder the send path uses — never a hand-copied mock. The preview is
// rebuilt only when the draft changes (useMemo per descriptor), not on every note keystroke.
export default function DraftPreview({ draft }) {
  const rendered = useMemo(() => {
    try { return draft.render(); }
    catch (e) { return { subject: draft.name, error: e?.message || 'Could not render this template.' }; }
  }, [draft]);

  if (rendered.error) {
    return <div className="drafts-preview drafts-preview-error">{rendered.error}</div>;
  }
  if (draft.kind === 'document') {
    return (
      <div className="drafts-preview">
        <div className="drafts-mailhead"><span className="drafts-mailhead-from">{IDENTITY.name}</span><span className="drafts-mailhead-subj">{rendered.subject}</span></div>
        <div className="drafts-doc-scroll">
          <div dangerouslySetInnerHTML={{ __html: rendered.html }} />
        </div>
      </div>
    );
  }
  if (draft.kind === 'sms') {
    return (
      <div className="drafts-preview">
        <div className="drafts-sms"><div className="drafts-sms-bubble">{rendered.body}</div></div>
      </div>
    );
  }
  return (
    <div className="drafts-preview">
      <div className="drafts-mailhead">
        <span className="drafts-mailhead-from">{IDENTITY.name}</span>
        <span className="drafts-mailhead-subj">{rendered.subject}</span>
      </div>
      <div className="drafts-mailbody">{rendered.body}</div>
    </div>
  );
}
