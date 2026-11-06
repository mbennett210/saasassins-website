import { useRef, useState } from 'react';
import Icon from './Icon';
import { useToast } from './Toast';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import * as mediaApi from '../lib/accountMediaApi';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';

// MISC-5 / CS-547 — the camera button beside a checklist item the office marked "photo
// required". Phone-first and deliberately TINY: one control, a count, and (offline) one
// line of reassurance.
//
// 🔴 WHY NOT `MediaGallery`. The gallery is the right component for a place that HOLDS
// photos — a site, an inspection section, a work order — and it opens by LISTING them. A
// checklist item has nothing to list: the submission id these photos are filed under was
// minted seconds ago on this phone, so every list would be a request that can only ever
// come back empty, one per marked item, each one an error toast when the cleaner is in a
// basement with no signal. This component uploads and counts what IT uploaded, which is
// the only thing that exists.
//
// 🔴 OFFLINE IS THE NORMAL CASE. `uploadMedia` buffers the file in IndexedDB and answers
// `{ pending_sync: true }` when the network is gone (lib/mediaQueue + the CS-007 drain
// replay it), and a buffered shot counts HERE exactly like an uploaded one: the cleaner
// has taken the photo, so the item is theirs to tick. The server counts only rows that
// actually landed (api/_lib/qc/store.checklistPhotoKeys), and lib/offlineFlush drains the
// MEDIA queue before the checklist queue so a replayed submission is counted with its
// photos — the same ordering rule that already puts checklists before punches.
//
// `onCount(n)` tells the fill how many photos this item now has, so the tick and the
// progress line read the same truth this button shows. `itemLabel` names the item in the
// button's accessible name, so a screen reader can tell two camera buttons apart.
//
// THE CLEANER'S CHECKLIST PAGE (Brief B, UI_RULES §166) puts a photo on EVERY task, required
// or not: `variant="icon"` draws the same upload as a 44px square camera button beside the
// task (green with a photo, dashed without — the count is in its accessible name), says
// nothing inline (the page says "Photo required" where the office asked; `required` picks the
// accessible name), and `disabled` holds it while the checklist is not open for check-off (not
// clocked in, the owner's preview); `className` lets the page add its own sizing class. The default chip stays the office fill's (ChecklistFill), where it appears only on
// a photo-required item and says so beside itself.
export default function ChecklistItemPhoto({ siteId, clientId, submissionId, itemKey, itemLabel = '', count = 0, onCount, variant = 'chip', disabled = false, required = true, className = '' }) {
  const t = useT();
  const toast = useToast();
  const online = useOnlineStatus();
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);

  const onFiles = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    setBusy(true);
    let added = 0;
    for (const f of files) {
      try {
        await mediaApi.uploadMedia(f, {
          siteId, clientId, scope: 'checklist', refId: submissionId, areaId: itemKey,
        });
        added += 1;
      } catch (err) {
        toast.error(errorText(t, err, 'checklist.photo.addFailed'));
      }
    }
    setBusy(false);
    if (added) onCount?.(count + added);
  };

  return (
    <div className="chk-item-photo">
      {/* `capture` opens the back camera straight away on a phone and is ignored on a
          desktop, where it falls back to the file picker. */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={onFiles}
      />
      {variant === 'icon' ? (
        <button
          type="button"
          className={`btn-icon chk-item-cam-icon ${className} ${count > 0 ? 'on' : ''}`}
          disabled={busy || disabled}
          aria-label={count > 0
            ? t('checklist.photo.addAnotherAria', { item: itemLabel, count })
            : (required ? t('checklist.photo.takeAria', { item: itemLabel }) : t('checklist.photo.addAria', { item: itemLabel }))}
          aria-busy={busy || undefined}
          onClick={() => fileRef.current?.click()}
        >
          <Icon name="camera" size={20} />
        </button>
      ) : (
        <>
          <button
            type="button"
            className={`chip chk-item-cam ${count > 0 ? 'on' : ''}`}
            disabled={busy}
            aria-label={count > 0
              ? t('checklist.photo.addAnotherAria', { item: itemLabel, count })
              : t('checklist.photo.takeAria', { item: itemLabel })}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? t('checklist.photo.adding') : count > 0 ? t('checklist.photo.attached', { count }) : t('checklist.photo.add')}
          </button>
          {count === 0 && (
            <span className="chk-item-photo-why text-xs">{t('checklist.photo.required')}</span>
          )}
          {count > 0 && !online && (
            <span className="chk-item-photo-why text-xs">{t('checklist.photo.savedOnDevice')}</span>
          )}
        </>
      )}
    </div>
  );
}
