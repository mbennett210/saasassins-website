import { useState } from 'react';
import { useParams } from 'react-router-dom';
import BackLink from '../../components/BackLink';
import Badge from '../../components/Badge';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { fetchHubDocuments, openHubDocument } from '../../lib/clientHubApi';
import { buildingPath } from './hubNav';
import { useHub, useHubRead } from './hubData';
import { DOCUMENTS_NOTE, hubDocumentCards } from './hubPaperwork';
import HubSectionHead from './HubSectionHead';

// DOCUMENTS — the paperwork for this property (the client hub redesign, Matt's boards mobile-06 /
// web-05, plan §3.6, 2026-10-08): the SERVICE AGREEMENT (the building's active contract — its name,
// "Started <day>", its signed copy; never a price), then what the office uploaded for it (a
// certificate of insurance, "Valid through …" or Expired after that day) and the company's own
// for every customer (the W-9, "On file"). Each opens through a five-minute link the server mints
// after checking it again (GET /api/hub/document-url). An agreement with no signed copy on file
// says so and offers nothing to open. A card per document: a row on a phone, a tile from the
// desktop up. The words: ./hubPaperwork.js. The hub stays English (LANG-8).
export default function HubDocuments() {
  const { buildingId } = useParams();
  const { building } = useHub();
  const toast = useToast();
  const read = useHubRead(() => fetchHubDocuments(buildingId), [buildingId]);
  const [opening, setOpening] = useState(null);
  const cards = hubDocumentCards(read.data);

  const view = async (c) => {
    setOpening(c.id);
    try { await openHubDocument(buildingId, c.id); }
    catch (e) { toast.error(e?.message || 'This document could not be opened. Try again in a moment.'); }
    finally { setOpening(null); }
  };

  let body;
  if (read.loading) body = <p className="text-muted">Loading documents…</p>;
  else if (read.error) {
    body = (
      <div className="card hub-card">
        <p className="text-sm">{read.error}</p>
        <button type="button" className="btn btn-outline" onClick={read.reload}>Try again</button>
      </div>
    );
  } else if (!cards.length) {
    body = <EmptyState icon={<Icon name="folder" size={28} />} title="No documents yet" message="Your account manager adds the service agreement, the certificate of insurance and the W-9 here." />;
  } else {
    body = (
      <>
        <div className="hub-docs">
          {cards.map((c) => (
            <article key={c.id} className="card hub-doc">
              <span className={`hub-tile-icon is-${c.look.tone}`} aria-hidden><Icon name={c.look.icon} size={20} /></span>
              <div className="hub-doc-text">
                <span className="hub-tile-title">{c.title}</span>
                <span className="hub-badges text-sm text-muted">
                  {c.expired && <Badge variant="red">Expired</Badge>}
                  <span>{c.line}</span>
                </span>
              </div>
              {c.canOpen && (
                <button type="button" className="btn btn-outline hub-doc-view" disabled={opening === c.id} onClick={() => view(c)} aria-label={`View ${c.title}`}>
                  {opening === c.id ? 'Opening…' : 'View'}
                </button>
              )}
            </article>
          ))}
        </div>
        <p className="text-xs text-muted hub-section-note">{DOCUMENTS_NOTE}</p>
      </>
    );
  }

  return (
    <div className="hub-page">
      <HubSectionHead back={<BackLink to={buildingPath(buildingId)} label="Back to Dashboard" />} title="Documents" building={building} />
      {body}
    </div>
  );
}
