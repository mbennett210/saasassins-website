// QR-22..QR-26 (Matt, 2026-10-16) — "Report a problem", under the public scan card (/scan/:token,
// UI_RULES §174). Anyone who scanned may send one: no account, no cookies. A sheet (the kit Modal,
// size "sheet": the whole screen on a phone) with the four choices as large tiles (QR-23 a–d), a
// text box whose hint follows the choice, one photo (the camera on a phone, redrawn here as a JPEG
// ≤ 1600 px), and the visitor's name and phone or email if they want a reply (QR-23 f). Send → the
// public route (EP-414), which files a ticket for the building's team (QR-25) that only the office
// sees (QR-26) → "Thanks. We've let the team know." The route's own sentence shows for a refusal
// or a limit; the form keeps what was typed. English, like every word on this page (LANG-8).
//
// A hidden field no person fills (off-screen, out of the tab order) is the honeypot: a script that
// fills it gets the same thanks and nothing is written. The send carries a caller-minted id, kept
// until it succeeds, so a retry after a lost answer is the same report, never a second ticket.
import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import Icon from './Icon';
import { sendVisitorReport } from '../lib/scanCodesApi';
import { decodeImage, drawJpeg, closeBitmap } from '../lib/imageCanvas';
import {
  VISITOR_CHOICES, VISITOR_CHOICE_KEYS, VISITOR_TEXT_MAX, VISITOR_TEXT_MIN, VISITOR_NAME_MAX, VISITOR_CONTACT_MAX,
  VISITOR_PHOTO_MAX_EDGE, VISITOR_PHOTO_MAX_BYTES, VISITOR_PHOTO_TYPES, VISITOR_REPORT_THANKS, visitorContactKind,
} from '../lib/visitorReports';
import { visitorDeviceId } from '../lib/visitorDevice';

const PHOTO_QUALITY = 0.8;
const NO_SIGNAL = 'That didn’t send. Check your signal and try again.';
const BAD_PHOTO = 'That photo can’t be used. Try another, or send without one.';

// A v4 uuid from the browser's CSPRNG (randomUUID needs a secure page; the bytes do not).
function newReportId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const readAsDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result || ''));
  r.onerror = () => reject(new Error('unreadable'));
  r.readAsDataURL(blob);
});

// The photo as it is sent: redrawn as a JPEG at most VISITOR_PHOTO_MAX_EDGE px on its long edge
// (upright: the camera's orientation applied while decoding); a picture this browser cannot redraw
// goes as picked when it is already a JPEG / PNG / WebP within the size. → { dataUrl, previewUrl } | null
async function preparePhoto(file) {
  const bmp = (await decodeImage(file, { imageOrientation: 'from-image' })) || (await decodeImage(file));
  let blob = null;
  if (bmp) {
    try {
      const long = Math.max(bmp.width, bmp.height);
      const scale = long > 0 ? Math.min(1, VISITOR_PHOTO_MAX_EDGE / long) : 1;
      blob = await drawJpeg(bmp, {
        width: Math.max(1, Math.round(bmp.width * scale)),
        height: Math.max(1, Math.round(bmp.height * scale)),
        quality: PHOTO_QUALITY,
      });
    } finally {
      closeBitmap(bmp);
    }
  }
  if (!blob && VISITOR_PHOTO_TYPES.includes(file?.type)) blob = file;
  if (!blob || !(blob.size > 0) || blob.size > VISITOR_PHOTO_MAX_BYTES) return null;
  try {
    return { dataUrl: await readAsDataUrl(blob), previewUrl: URL.createObjectURL(blob) };
  } catch {
    return null;
  }
}

export default function ScanVisitorReport({ token, area = null }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(null);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [hp, setHp] = useState('');
  const [photo, setPhoto] = useState(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const idRef = useRef(null);
  const fileRef = useRef(null);
  const calloutRef = useRef(null);

  // A refusal lands under the fields, above Send: bring it into view where the thumb is.
  useEffect(() => { if (error) calloutRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }, [error]);

  // A preview link is freed when the photo changes or the page goes.
  useEffect(() => () => { if (photo?.previewUrl) URL.revokeObjectURL(photo.previewUrl); }, [photo]);

  const reset = () => {
    setChoice(null); setText(''); setName(''); setContact(''); setHp('');
    setPhoto(null); setPhotoError(''); setError(''); setDone(null);
    idRef.current = null;
  };
  const close = () => {
    if (sending) return;
    setOpen(false);
    if (done) reset();
  };

  const c = choice ? VISITOR_CHOICES[choice] : null;
  const words = text.trim();
  const contactOk = !contact.trim() || !!visitorContactKind(contact);
  const wordsOk = !c?.textRequired || words.length >= VISITOR_TEXT_MIN;
  const canSend = !!c && wordsOk && words.length <= VISITOR_TEXT_MAX && contactOk && !photoBusy && !sending;

  const pick = async (e) => {
    const file = e.target.files?.[0] || null;
    e.target.value = '';
    if (!file) return;
    setPhotoBusy(true);
    setPhotoError('');
    const ready = await preparePhoto(file);
    setPhotoBusy(false);
    if (ready) setPhoto(ready);
    else setPhotoError(BAD_PHOTO);
  };

  const send = async () => {
    if (!canSend) return;
    if (!idRef.current) idRef.current = newReportId();
    setSending(true);
    setError('');
    try {
      const r = await sendVisitorReport({
        token,
        category: choice,
        text: words || undefined,
        name: name.trim() || undefined,
        contact: contact.trim() || undefined,
        photo: photo?.dataUrl || undefined,
        deviceId: visitorDeviceId(),
        id: idRef.current,
        hp,
      });
      setDone({ message: r?.message || VISITOR_REPORT_THANKS, photoSaved: r?.photoSaved ?? null });
      idRef.current = null;
    } catch (err) {
      setError(err?.status ? (err.message || NO_SIGNAL) : NO_SIGNAL);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <button type="button" className="btn btn-outline scan-report-open" onClick={() => setOpen(true)}>
        <Icon name="warning" size={18} />
        <span>Report a problem</span>
      </button>
      <Modal open={open} onClose={close} title="Report a problem" size="sheet">
        {done ? (
          <div className="scan-report-thanks" role="status">
            <span className="scan-report-thanks-mark" aria-hidden="true"><Icon name="check" size={28} /></span>
            <p className="scan-report-thanks-text">{done.message}</p>
            {done.photoSaved === false && <p className="scan-report-note text-sm">Your photo couldn’t be added, but your report was sent.</p>}
            <button type="button" className="btn btn-primary scan-report-send" onClick={close}>Done</button>
          </div>
        ) : (
          <div className="scan-report">
            {area && <p className="scan-report-where text-sm">{area}</p>}
            <fieldset className="scan-report-set">
              <legend className="scan-label">What’s wrong?</legend>
              <div className="scan-report-grid">
                {VISITOR_CHOICE_KEYS.map((k) => {
                  const ch = VISITOR_CHOICES[k];
                  return (
                    <button
                      key={k}
                      type="button"
                      className={`scan-report-choice${choice === k ? ' on' : ''}`}
                      aria-pressed={choice === k}
                      onClick={() => setChoice(k)}
                    >
                      <Icon name={ch.icon} size={22} />
                      <span className="scan-report-choice-label">{ch.label}</span>
                      <span className="scan-report-choice-eg">{ch.examples}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <label className="scan-report-field">
              <span className="scan-label">{c?.textRequired ? 'Tell us what’s wrong' : 'Anything to add? (optional)'}</span>
              <textarea
                className="input scan-report-text"
                rows={3}
                maxLength={VISITOR_TEXT_MAX}
                placeholder={c ? c.hint : 'Choose what’s wrong first'}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <span className="scan-report-count text-xs">{words.length} / {VISITOR_TEXT_MAX}</span>
            </label>

            <div className="scan-report-photo">
              {photo ? (
                <figure className="scan-report-preview">
                  <img src={photo.previewUrl} alt="The photo you added" />
                  <button type="button" className="btn btn-link" onClick={() => setPhoto(null)}>Remove photo</button>
                </figure>
              ) : (
                <button type="button" className="btn btn-outline scan-report-add" onClick={() => fileRef.current?.click()} disabled={photoBusy}>
                  <Icon name="camera" size={18} />
                  <span>{photoBusy ? 'Preparing the photo…' : 'Add a photo'}</span>
                </button>
              )}
              <input ref={fileRef} type="file" accept="image/*" capture="environment" className="scan-report-file" tabIndex={-1} aria-hidden="true" onChange={pick} />
              {photoError && <p className="scan-report-error text-sm" role="alert">{photoError}</p>}
            </div>

            <fieldset className="scan-report-set">
              <legend className="scan-label">Your name and phone or email (optional, if you’d like a reply)</legend>
              <input className="input" type="text" autoComplete="name" maxLength={VISITOR_NAME_MAX} placeholder="Your name" aria-label="Your name" value={name} onChange={(e) => setName(e.target.value)} />
              <input className="input" type="text" autoComplete="email" maxLength={VISITOR_CONTACT_MAX} placeholder="Phone or email" aria-label="Phone or email" aria-invalid={!contactOk} value={contact} onChange={(e) => setContact(e.target.value)} />
              {!contactOk && <p className="scan-report-error text-sm">Enter a phone number or an email address, or leave it blank.</p>}
            </fieldset>

            {/* The honeypot: no person sees it or reaches it (the kit's .sr-only box, hidden from
                assistive tech too, out of the tab order). */}
            <div className="sr-only" aria-hidden="true">
              <label>Leave this empty <input type="text" name="website" tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)} /></label>
            </div>

            {error && (
              <div ref={calloutRef} className="callout callout-warning scan-report-callout" role="alert">
                <Icon name="warning" size={16} />
                <span>{error}</span>
              </div>
            )}
            <button type="button" className="btn btn-primary scan-report-send" onClick={send} disabled={!canSend}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        )}
      </Modal>
    </>
  );
}
