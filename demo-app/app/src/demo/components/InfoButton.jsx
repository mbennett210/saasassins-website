import { useState } from 'react';
import Modal from '../../components/Modal';
import '../demo.css';

// Glowing "info" affordance. Radiates a pulse to pull attention until a visitor
// opens it for the first time, then settles to a quiet button (per-key "seen"
// memory in localStorage so each distinct info point glows once). Opens the
// shared Modal with in-depth content. Generic: pass `title` + children.
//
//   <InfoButton title="Field Ops" glowKey="mod:fieldops">…rich explanation…</InfoButton>

const SEEN_KEY = 'pp.demo.infoSeen.v1';

function loadSeen() {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(SEEN_KEY)) || []);
  } catch {
    return new Set();
  }
}

function markSeen(key) {
  try {
    const s = loadSeen();
    s.add(key);
    window.localStorage.setItem(SEEN_KEY, JSON.stringify([...s]));
  } catch {
    /* ignore */
  }
}

export default function InfoButton({ title, children, glowKey, label = 'More info', glow = true, size }) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(() => (glowKey ? loadSeen().has(glowKey) : true));
  const isGlowing = glow && !seen;

  const handleOpen = () => {
    setOpen(true);
    if (glowKey && !seen) {
      markSeen(glowKey);
      setSeen(true);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`pp-info-btn${isGlowing ? ' is-glowing' : ''}${size === 'sm' ? ' pp-info-btn-sm' : ''}`}
        onClick={handleOpen}
        aria-label={label}
        title={label}
      >
        i
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={title} size="sm">
        <div className="pp-info-pop">{children}</div>
      </Modal>
    </>
  );
}
