// QR-30 (Matt, 2026-10-16) — "How does this area look?" 👍 / 👎, under the public scan card
// (/scan/:token, UI_RULES §174). Anyone who scanned may vote, no account and no cookies: ONE vote
// per phone per area per day, which they may change that day (EP-415; lib/areaRatings). The phone
// remembers today's vote in its own storage, so coming back shows it pressed. Only the office sees
// the results (Reports → Visitor ratings). English, like every word on this page (LANG-8).
import { useMemo, useState } from 'react';
import Icon from './Icon';
import { rateScanArea } from '../lib/scanCodesApi';
import { ratingDay, rememberedVote, rememberVote, AREA_RATING_THANKS } from '../lib/areaRatings';
import { visitorDeviceId, readRatingMemory, writeRatingMemory } from '../lib/visitorDevice';

const VOTES = [
  { vote: 'up', icon: 'thumbUp', label: 'Looks good' },
  { vote: 'down', icon: 'thumbDown', label: 'Needs work' },
];

export default function ScanAreaRating({ token, timeZone }) {
  // The ORG's day (the scan answer carries the zone): today's vote is that day's.
  const day = useMemo(() => ratingDay(Date.now(), timeZone), [timeZone]);
  const [vote, setVote] = useState(() => rememberedVote(readRatingMemory(), token, day));
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');

  const send = async (v) => {
    if (busy) return;
    if (v === vote) { setSaid(AREA_RATING_THANKS); return; }
    setBusy(true);
    setSaid('');
    try {
      const r = await rateScanArea({ token, value: v, deviceId: visitorDeviceId() });
      const kept = r?.vote || v;
      setVote(kept);
      writeRatingMemory(rememberVote(readRatingMemory(), token, day, kept));
      setSaid(r?.message || AREA_RATING_THANKS);
    } catch (e) {
      // The route's own sentence (a limit, "no longer active"); no signal is the fetch's error.
      setSaid(e?.status ? (e.message || 'That didn’t go through. Please try again.') : 'That didn’t go through. Check your signal and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card scan-card scan-rate" aria-labelledby="scan-rate-title">
      <h2 id="scan-rate-title" className="scan-rate-title">How does this area look?</h2>
      <div className="scan-rate-buttons" role="group" aria-labelledby="scan-rate-title">
        {VOTES.map((b) => (
          <button
            key={b.vote}
            type="button"
            className={`chip scan-rate-btn${vote === b.vote ? ' on' : ''}`}
            aria-pressed={vote === b.vote}
            disabled={busy}
            onClick={() => send(b.vote)}
          >
            <Icon name={b.icon} size={20} />
            <span>{b.label}</span>
          </button>
        ))}
      </div>
      <p className="scan-rate-said text-sm" role="status" aria-live="polite">{said}</p>
    </section>
  );
}
