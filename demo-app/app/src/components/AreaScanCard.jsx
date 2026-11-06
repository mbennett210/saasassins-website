// THE AREA CARD — one QR code's answer, drawn ONCE for its two homes (QR Wave 2, 2026-10-17):
// the public page a stranger's phone opens (/scan/:token, pages/PublicAreaScan) and the customer
// hub's own page for that area (/hub/b/:buildingId/areas/:areaId, pages/hub/HubArea — Matt's
// QR-16: "That area's own page: when it was last cleaned, the photo, what was done, and a button to
// make a request about it"). UI_RULES §138, §173.
//
// `scan` is lib/areaScan's allowlist projection either way (projectAreaScan: the public route, the
// hub's GET area and both demo twins build it), so the two homes cannot show different things.
// `photoUrl` is where this home may fetch the area's photo: the public route's own /photo by token,
// or the hub's short-lived signed thumbnail. `children` are the home's own actions at the card's end
// (the public page's one Sign-in line; the hub's "Make a request about this area").
//
// What it says (Matt, 2026-10-16): when the area was last cleaned, in the ORG's zone, and how long
// ago — the same calm way however old (QR-28: never a warning); the next scheduled clean and the
// building's last inspection as DATES (QR-28, QR-15); the newest checklist photo beside a recorded
// clean; the items done; and, when the company's phone is set, "For urgent problems, call …"
// (QR-31, through the app's one click-to-dial, PhoneLink). English throughout, like every word a customer or a visitor reads (LANG-8).
import { useState } from 'react';
import Badge from './Badge';
import Icon from './Icon';
import PhoneLink from './PhoneLink';
import {
  formatScanWhen, scanAge, scanStatusCopy, scanNextCleanText, scanLastInspectionText, PUBLIC_ITEM_STATE,
} from '../lib/areaScan';

export default function AreaScanCard({ scan, photoUrl = null, children = null }) {
  // A picture that fails to load is dropped rather than shown broken; a new address tries again.
  const [failedUrl, setFailedUrl] = useState(null);
  const copy = scanStatusCopy(scan.lastCleanedAt);
  const checked = Date.parse(scan.checkedAt);
  const next = scanNextCleanText(scan);
  const inspected = scanLastInspectionText(scan);
  const showPhoto = !!(scan.photo && photoUrl && failedUrl !== photoUrl);
  return (
    <article className="card scan-card">
      <header className="scan-head">
        <div className="scan-where">
          <Icon name="building" size={14} />
          <span>{scan.building}{scan.location ? ` · ${scan.location}` : ''}</span>
        </div>
        <h1 className="scan-area">{scan.area}</h1>
        <div><Badge variant={copy.variant}>{copy.badge}</Badge></div>
      </header>

      <div className="scan-when">
        <div className="scan-label">Last cleaned</div>
        {scan.lastCleanedAt ? (
          <>
            <div className="scan-time">{formatScanWhen(scan.lastCleanedAt, scan.timeZone)}</div>
            <div className="scan-age">{scanAge(scan.lastCleanedAt, checked)}</div>
          </>
        ) : (
          <div className="scan-time scan-time-none">Not recorded yet</div>
        )}
      </div>

      {(next || inspected) && (
        <div className="scan-facts">
          {next && <p className="scan-fact"><span className="scan-fact-label">Next clean:</span> <span className="scan-fact-value">{next}</span></p>}
          {inspected && <p className="scan-fact"><span className="scan-fact-label">Last inspection:</span> <span className="scan-fact-value">{inspected}</span></p>}
        </div>
      )}

      {showPhoto && (
        <figure className="scan-photo">
          <img src={photoUrl} alt={`The most recent photo of ${scan.area}`} loading="lazy" onError={() => setFailedUrl(photoUrl)} />
          <figcaption>Photo taken {formatScanWhen(scan.photo.takenAt, scan.timeZone)}</figcaption>
        </figure>
      )}

      {scan.items.length > 0 && (
        <section className="scan-done" aria-labelledby="scan-done-title">
          <h2 id="scan-done-title" className="scan-label">What was done</h2>
          <ul className="scan-items">
            {scan.items.map((it, i) => (
              <li key={`${i}-${it.label}`} className={`scan-item${it.state === PUBLIC_ITEM_STATE.NA ? ' is-na' : ''}`}>
                {it.state === PUBLIC_ITEM_STATE.NA
                  ? <span className="scan-item-mark" aria-hidden="true">–</span>
                  : <span className="scan-item-mark scan-item-done" aria-hidden="true"><Icon name="check" size={14} /></span>}
                <span className="scan-item-label">
                  {it.label}
                  {it.state === PUBLIC_ITEM_STATE.NA && <span className="scan-item-na"> · not needed this time</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* QR-31: the company's number for urgent problems, through the app's one click-to-dial
          (PhoneLink, UI_RULES §28: a tel: href of digits and a leading + only). */}
      {scan.urgentPhone && (
        <p className="scan-urgent">
          <Icon name="phone" size={16} />
          <span>For urgent problems, call</span>
          <PhoneLink phone={scan.urgentPhone} className="linklike scan-urgent-link" title={`Call ${scan.urgentPhone}`} />
        </p>
      )}

      {children}
    </article>
  );
}
