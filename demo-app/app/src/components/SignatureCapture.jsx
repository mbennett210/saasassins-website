import { useEffect, useImperativeHandle, useRef, forwardRef, useState } from 'react';
import SignaturePad from 'signature_pad';

// Sign by DRAWING (signature_pad) or TYPING your name in a cursive font. Both
// produce a transparent PNG (ink only) via toDataURL(), so it stamps cleanly onto
// the PDF. Parent gets isEmpty()/toDataURL()/clear() via ref — unchanged API.
// Signature fonts — free Google Fonts chosen to read like real handwritten
// signatures (DocuSign's own Mistral / Rage Italic / Freestyle Script are licensed
// commercial fonts). Mr Dafoe, Herr Von Muellerhoff + Rouge Script are the most
// signature-like; the rest span elegant -> bold -> casual.
const FONTS = [
  { label: 'Allura',          css: "'Allura', cursive" },
  { label: 'Alex Brush',      css: "'Alex Brush', cursive" },
  { label: 'Yellowtail',      css: "'Yellowtail', cursive" },
  { label: 'Satisfy',         css: "'Satisfy', cursive" },
  { label: 'Dancing Script',  css: "'Dancing Script', cursive" },
  { label: 'Mr Dafoe',        css: "'Mr Dafoe', cursive" },
  { label: 'Von Muellerhoff', css: "'Herr Von Muellerhoff', cursive" },
  { label: 'Rouge Script',    css: "'Rouge Script', cursive" },
];

// `width` is now a MAX — the pad shrinks to fit its container so it never overflows
// a narrow modal on mobile (was a hard 380 that spilled ~130px past a 320px sheet).
const SignatureCapture = forwardRef(function SignatureCapture({ width = 380, height = 130 }, ref) {
  const wrapRef = useRef(null);        // measured to fit the container
  const canvasRef = useRef(null);      // draw-mode signature_pad canvas
  const padRef = useRef(null);
  const typeCanvasRef = useRef(null);  // offscreen render of the typed name
  const [mode, setMode] = useState('draw');
  const [empty, setEmpty] = useState(true);
  const [typedName, setTypedName] = useState('');
  const [font, setFont] = useState(FONTS[0]);
  const [w, setW] = useState(width);   // effective (fitted) width

  // Fit the pad to the available width (capped at the `width` max), re-measuring on resize.
  useEffect(() => {
    const measure = () => {
      const avail = wrapRef.current?.clientWidth;
      setW(avail ? Math.min(width, Math.round(avail)) : width);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [width]);

  // Draw mode: init signature_pad when the draw canvas is mounted (re-init on width change).
  useEffect(() => {
    if (mode !== 'draw' || !canvasRef.current) return undefined;
    const canvas = canvasRef.current;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = w * ratio;
    canvas.height = height * ratio;
    canvas.getContext('2d').scale(ratio, ratio);
    // design:allow no-raw-hex — signature ink on a transparent canvas: a signature is drawn in ink, not in brand colours
    const pad = new SignaturePad(canvas, { penColor: '#0b1020', backgroundColor: 'rgba(255,255,255,0)', minWidth: 0.7, maxWidth: 2.2 });
    pad.addEventListener('endStroke', () => setEmpty(pad.isEmpty()));
    padRef.current = pad;
    return () => { pad.off(); padRef.current = null; };
  }, [mode, w, height]);

  // Type mode: render the typed name (transparent bg, ink only) to the canvas,
  // auto-fitting the size, after the chosen web font has loaded.
  useEffect(() => {
    if (mode !== 'type' || !typeCanvasRef.current) return;
    const canvas = typeCanvasRef.current;
    const draw = () => {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      canvas.width = w * ratio;
      canvas.height = height * ratio;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, w, height);
      const text = typedName.trim();
      if (!text) return;
      ctx.fillStyle = '#0b1020'; // design:allow no-raw-hex — typed signatures use the same ink as drawn ones
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      let size = 52;
      ctx.font = `${size}px ${font.css}`;
      while (ctx.measureText(text).width > w - 24 && size > 14) { size -= 2; ctx.font = `${size}px ${font.css}`; }
      ctx.fillText(text, w / 2, height / 2 + 4);
    };
    if (document.fonts && document.fonts.load) {
      document.fonts.load(`52px ${font.css}`, typedName || 'A').then(draw).catch(draw);
    } else { draw(); }
  }, [mode, typedName, font, w, height]);

  useImperativeHandle(ref, () => ({
    isEmpty: () => (mode === 'draw' ? (padRef.current?.isEmpty() ?? true) : !typedName.trim()),
    toDataURL: () => (mode === 'draw' ? padRef.current?.toDataURL('image/png') : typeCanvasRef.current?.toDataURL('image/png')),
    clear: () => { if (mode === 'draw') { padRef.current?.clear(); setEmpty(true); } else { setTypedName(''); } },
  }), [mode, typedName]);

  const tab = (m, label) => (
    <button type="button" className={`btn btn-sm ${mode === m ? 'btn-primary' : ''}`} onClick={() => setMode(m)} style={{ minWidth: 64 }}>{label}</button>
  );

  return (
    <div ref={wrapRef} style={{ display: 'block', width: '100%', maxWidth: width }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>{tab('draw', 'Draw')}{tab('type', 'Type')}</div>

      {mode === 'draw' ? (
        <>
          <canvas ref={canvasRef} style={{ width: w, height, border: '1px solid var(--card-border)', borderRadius: 8, background: 'var(--card-bg)', touchAction: 'none', display: 'block' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
            <span className="text-xs text-muted">{empty ? 'Draw your signature above' : 'Signed'}</span>
            <button type="button" className="btn btn-link btn-sm" onClick={() => { padRef.current?.clear(); setEmpty(true); }}>Clear</button>
          </div>
        </>
      ) : (
        <>
          <input
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            placeholder="Type your full name"
            style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--card-border)', borderRadius: 8, marginBottom: 6, font: 'inherit', boxSizing: 'border-box' }}
          />
          <canvas ref={typeCanvasRef} style={{ width: w, height, border: '1px solid var(--card-border)', borderRadius: 8, background: 'var(--card-bg)', display: 'block' }} />
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            {FONTS.map((f) => (
              <button type="button" key={f.label} className={`btn btn-sm ${font.label === f.label ? 'btn-primary' : ''}`} style={{ fontFamily: f.css, fontSize: 16 }} onClick={() => setFont(f)}>{f.label}</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
});

export default SignatureCapture;
