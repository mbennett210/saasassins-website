import MobileSheet from '../../components/MobileSheet';
import { InstallSteps } from '../../components/InstallWelcome';
import { english } from '../../i18n/core';
import { richText } from '../../i18n/react';
import { IDENTITY } from '../../brand/identity.generated.js';
import { INSTALL_STEPS, INSTALL_NOTE } from '../../lib/installWelcome';
import { hubAlertsInstallVariant } from '../../lib/hubAlerts';

// CREW ON THE WAY on an iPhone or iPad outside its Home Screen app (lib/crewOnTheWay
// HUB_ALERT_DEVICE.install): Safari gives a web page no alerts, so Turn on (Home's row) and "Show me
// how" (the Account card) open this sheet with the Home Screen steps for this browser, the
// welcome's own (components/InstallWelcome InstallSteps, lib/installWelcome), in English like the
// rest of the hub. Once the app is opened from the Home Screen, Turn on asks for alerts there.
const rich = (key, params) => richText(english(key, params));

export default function HubAlertsSteps({ open, onClose, device = 'iPhone' }) {
  const variant = hubAlertsInstallVariant();
  const steps = INSTALL_STEPS[variant] || [];
  const note = INSTALL_NOTE[variant];
  const params = { product: IDENTITY.product.name, browser: 'Safari' }; // i18n-ok: a browser's own name
  return (
    <MobileSheet
      open={open}
      onClose={onClose}
      title="Add the app to your Home Screen"
      footer={<button type="button" className="btn btn-primary" onClick={onClose}>Got it</button>}
    >
      <div className="hub-alerts-steps">
        <p className="text-sm">
          {`On an ${device}, alerts come to the app on your Home Screen. Add it, open it from there, then tap Turn on.`}
        </p>
        <InstallSteps steps={steps} rich={rich} params={params} />
        {note && <p className="text-xs text-muted">{english(note)}</p>}
      </div>
    </MobileSheet>
  );
}
