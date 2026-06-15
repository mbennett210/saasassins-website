import ScaledPreview from './ScaledPreview';
import MiniApp from './MiniApp';
import 'devices.css/dist/devices.min.css';
import './deviceFrames.css';
import '../demo.css';

// Persistent desktop + mobile dashboard preview for the checkout, rendered inside
// REAL device frames (devices.css, MIT): a MacBook Pro for desktop and an iPhone
// 14 Pro (Dynamic Island) for mobile. The themed MiniApp renders into each frame's
// screen window, so the frames apply to EVERY brand theme (Cobalt / Forge /
// Midnight / Orchid) — only the dashboard inside is brand-coloured.
//
// Sizing (mirrors the original responsive pattern):
//   • Each flex column holds a .pp-framebox with width:100% + the DEVICE aspect
//     ratio, giving ScaledPreview a stable box to measure (putting aspect-ratio
//     on the flex item itself made it over-measure and clip the frame). Columns
//     are flex 3:1 so the MacBook + iPhone render at MATCHED overall height
//     (3·418/618 ≈ 1·868/428). ScaledPreview scales the fixed-size devices.css
//     device to fit that box — fluid/responsive, never clipped.
//   • The MiniApp is fixed-scaled into each screen window (MacBook screen 600×375
//     ← app 1200×750 ·0.5 ; iPhone 390×830 ← 1:1). MacBook's screen is 16:10, the
//     dashboard's aspect, so it fills with no crop. deviceFrames.css clips the
//     screen to its rounded corners and restores the displays devices.css resets.

const DeviceExtras = () => (
  <>
    <div className="device-stripe" />
    <div className="device-header" />
    <div className="device-sensors" />
    <div className="device-btns" />
    <div className="device-power" />
  </>
);

export default function DashboardPreview({ themeKey }) {
  return (
    <div className="pp-preview-stage">
      <div className="pp-dev pp-dev-mac">
        <div className="pp-framebox">
          <ScaledPreview nw={740} nh={434}>
            <div className="device device-macbook-pro">
              <div className="device-frame">
                <div className="device-screen">
                  <div className="pp-screenfit" style={{ width: 1200, height: 750, transform: 'scale(0.5)' }}>
                    <MiniApp scope={`.ppd-${themeKey}`} theme={themeKey} screen="dashboard" device="desktop" />
                  </div>
                </div>
              </div>
              <DeviceExtras />
            </div>
          </ScaledPreview>
        </div>
      </div>

      <div className="pp-dev pp-dev-phone">
        <div className="pp-framebox">
          <ScaledPreview nw={428} nh={868}>
            <div className="device device-iphone-14-pro">
              <div className="device-frame">
                <div className="device-screen">
                  <div className="pp-screenfit" style={{ width: 390, height: 830 }}>
                    <MiniApp scope={`.ppm-${themeKey}`} theme={themeKey} screen="dashboard" device="mobile" />
                  </div>
                </div>
              </div>
              <DeviceExtras />
            </div>
          </ScaledPreview>
        </div>
      </div>
    </div>
  );
}
