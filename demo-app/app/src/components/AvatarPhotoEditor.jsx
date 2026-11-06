import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { useT } from '../i18n/react';
import {
  initialCrop, fitZoom, panCrop, zoomCrop, cropDrawRects, cropImageBox,
  MAX_ZOOM, KEY_PAN_FRACTION, KEY_ZOOM_STEP,
} from '../lib/photoCrop';
import { drawJpeg } from '../lib/imageCanvas';
import { PHOTO_EDGE_PX, PHOTO_JPEG_QUALITY } from '../lib/userPhoto';

// The profile-photo CROP (UI_RULES §141): the picked photo in a square with a round guide, the
// way it will sit in the avatar. Drag to move it (pointer events, so a finger works the same as
// a mouse; two fingers pinch), zoom with the labelled slider from the WHOLE photo (fit: where it
// starts, so nobody's head is cut off before they begin) up to 3× of cover (the wheel works
// too), and from the keyboard the arrows move it and + / − zoom. "Use photo" keeps exactly the
// square the circle shows, shrunk on the device to a PHOTO_EDGE_PX JPEG (about 20 KB); any part
// of the square the photo doesn't cover is the avatar disc's own colour, in the square while
// cropping (`.avatar-crop`'s background) and in the saved photo alike.
// The crop math is lib/photoCrop (pure, tested); the image is placed in percent of the square.
// On a phone the dialog is a full-screen sheet (Modal size="sheet").
//
//   bitmap  the decoded photo (lib/imageCanvas decodeImage) — what is cropped
//   src     an object URL of the same file — what is shown while cropping
//   onUse(blob)  the cropped JPEG; busy  the save is in flight
export default function AvatarPhotoEditor({ open, bitmap, src, busy = false, onCancel, onUse }) {
  const t = useT();
  const w = bitmap?.width || 1;
  const h = bitmap?.height || 1;
  const [crop, setCrop] = useState(() => initialCrop(w, h));
  const [encodeFailed, setEncodeFailed] = useState(false);
  const areaRef = useRef(null);
  const pointers = useRef(new Map());
  const pinch = useRef(null);

  // The slider's floor follows the photo: the zoom that shows all of it.
  const minZoom = fitZoom(w, h);

  // A new photo starts whole and centred (fit).
  useEffect(() => { setCrop(initialCrop(w, h)); setEncodeFailed(false); }, [bitmap, w, h]);

  const areaPx = () => areaRef.current?.getBoundingClientRect().width || 1;

  // The wheel zooms. A NATIVE listener, because React's wheel handler is passive and could not
  // stop the dialog scrolling under the photo.
  useEffect(() => {
    const el = areaRef.current;
    if (!open || !el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      setCrop((c) => zoomCrop(c, c.zoom * Math.exp(-e.deltaY * 0.0015), w, h));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [open, w, h]);

  const onPointerDown = (e) => {
    try { areaRef.current?.setPointerCapture?.(e.pointerId); } catch { /* an older browser */ }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: crop.zoom };
    }
  };
  const onPointerMove = (e) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const next = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, next);
    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const ratio = Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.dist;
      const start = pinch.current.zoom;
      setCrop((c) => zoomCrop(c, start * ratio, w, h));
    } else {
      const size = areaPx();
      setCrop((c) => panCrop(c, next.x - prev.x, next.y - prev.y, w, h, size));
    }
  };
  const onPointerEnd = (e) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  const onKeyDown = (e) => {
    const step = areaPx() * KEY_PAN_FRACTION;
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (move) {
      e.preventDefault();
      const size = areaPx();
      setCrop((c) => panCrop(c, move[0], move[1], w, h, size));
      return;
    }
    const dz = { '+': KEY_ZOOM_STEP, '=': KEY_ZOOM_STEP, '-': -KEY_ZOOM_STEP, _: -KEY_ZOOM_STEP }[e.key];
    if (dz) {
      e.preventDefault();
      setCrop((c) => zoomCrop(c, c.zoom + dz, w, h));
    }
  };

  const use = async () => {
    if (!bitmap || busy) return;
    // The bars a zoomed-out crop leaves are the avatar disc's colour, read from the theme at draw
    // time (a token, never a literal: the re-skin guarantee, UI_RULES §121).
    const fill = getComputedStyle(document.documentElement).getPropertyValue('--avatar-1').trim() || null;
    const blob = await drawJpeg(bitmap, {
      ...cropDrawRects(crop, w, h, PHOTO_EDGE_PX),
      width: PHOTO_EDGE_PX, height: PHOTO_EDGE_PX, quality: PHOTO_JPEG_QUALITY, fill,
    });
    if (!blob) { setEncodeFailed(true); return; }
    onUse(blob);
  };

  const box = cropImageBox(crop, w, h);
  return (
    <Modal open={open} onClose={busy ? () => {} : onCancel} title={t('avatarPhoto.editor.title')} size="sheet">
      <div className="avatar-editor">
        <div
          ref={areaRef}
          className="avatar-crop"
          role="group"
          tabIndex={0}
          aria-label={t('avatarPhoto.editor.area')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onKeyDown={onKeyDown}
        >
          {src && (
            <img
              className="avatar-crop-img"
              src={src}
              alt=""
              draggable={false}
              style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` }}
            />
          )}
          <svg className="avatar-crop-mask" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
            <path className="avatar-crop-shade" fillRule="evenodd" d="M0 0H100V100H0Z M50 0A50 50 0 1 0 50 100A50 50 0 1 0 50 0Z" />
            <circle className="avatar-crop-ring" cx="50" cy="50" r="49.6" />
          </svg>
        </div>
        <p className="avatar-editor-hint">{t('avatarPhoto.editor.hint')}</p>
        <label className="avatar-zoom">
          <span className="avatar-zoom-label">{t('avatarPhoto.editor.zoom')}</span>
          <input
            type="range"
            className="avatar-zoom-range"
            min={minZoom}
            max={MAX_ZOOM}
            step="0.01"
            value={crop.zoom}
            onChange={(e) => setCrop((c) => zoomCrop(c, Number(e.target.value), w, h))}
          />
        </label>
        {encodeFailed && <p className="avatar-editor-error" role="alert">{t('avatarPhoto.notAnImage')}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" onClick={use} disabled={busy || !bitmap}>
            {busy ? t('avatarPhoto.saving') : t('avatarPhoto.editor.use')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
