import ScaledPreview from './ScaledPreview';
import MiniApp from './MiniApp';
import '../demo.css';

// Persistent desktop + mobile dashboard preview for the checkout. Renders the
// themed MiniApp at native size, scaled into a desktop-monitor frame and a phone
// frame, side by side. Re-themes whenever `themeKey` changes — no modal, no
// "preview" button.

const DESKTOP = { nw: 1280, nh: 820 };
const MOBILE = { nw: 390, nh: 820 };

export default function DashboardPreview({ themeKey }) {
  return (
    <div className="pp-preview-stage">
      <div className="pp-device pp-device-desktop">
        <div className="pp-device-screen">
          <ScaledPreview nw={DESKTOP.nw} nh={DESKTOP.nh}>
            <MiniApp scope={`.ppd-${themeKey}`} theme={themeKey} screen="dashboard" device="desktop" />
          </ScaledPreview>
        </div>
        <span className="pp-device-stand" aria-hidden="true" />
        <span className="pp-device-cap">Desktop</span>
      </div>

      <div className="pp-device pp-device-phone">
        <div className="pp-device-phone-body">
          <span className="pp-device-notch" aria-hidden="true" />
          <div className="pp-device-screen">
            <ScaledPreview nw={MOBILE.nw} nh={MOBILE.nh}>
              <MiniApp scope={`.ppm-${themeKey}`} theme={themeKey} screen="dashboard" device="mobile" />
            </ScaledPreview>
          </div>
        </div>
        <span className="pp-device-cap">Mobile</span>
      </div>
    </div>
  );
}
