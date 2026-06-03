import { useState } from 'react';
import { useTour } from '../tour/tourContext';
import { resetDemo } from '../resetDemo';
import '../demo.css';

// Floating demo control, mounted in the live CRM only (AppLayout, behind IS_DEMO).
// A small toggle to replay the guided tour or reset the sandbox. (Brand styling is
// chosen at checkout via swatchboard examples — the demo itself stays PolishPoint.)

export default function DemoControls() {
  const tour = useTour();
  const [open, setOpen] = useState(false);

  return (
    <div className="pp-demo-controls">
      {open && (
        <div className="pp-demo-controls-panel">
          <div className="pp-demo-controls-actions">
            <button type="button" className="pp-link-muted" onClick={() => { setOpen(false); tour.start(); }}>Take the tour</button>
            <button type="button" className="pp-link-muted" onClick={resetDemo}>Reset demo</button>
          </div>
        </div>
      )}
      <button
        type="button"
        className="pp-demo-controls-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span aria-hidden="true">✨</span> Demo
      </button>
    </div>
  );
}
