import { useState } from 'react';
import { useAuth } from './useAuth';
import { usePermission } from './usePermission';
import { useToast } from '../components/Toast';
import { useT } from '../i18n/react';
import { scanCodesAllowed, SCAN_CODES_PERMISSION } from '../lib/scanCodes';
import { fetchScanLinks, saveScanLinksCsv } from '../lib/scanCodesApi';

// Every building's QR code links as one spreadsheet, for the office's own label software (QR Wave 1,
// 2026-10-16, EP-412). ONE implementation behind the two buttons that offer it: the Customers list's
// "QR code links" and the QR codes page's (UI_RULES §183). `show` is the QR panel's own rule: the key
// that edits a location's areas AND an office role (crew never, whatever a grant says); `busy` while
// the file is made; `download` asks the server (it mints any missing code), saves the file and says
// how many links from how many buildings, and how many buildings have no areas yet.
export function useScanLinksDownload() {
  const t = useT();
  const toast = useToast();
  const { currentUser } = useAuth();
  const canSitesEdit = usePermission(SCAN_CODES_PERMISSION);
  const show = scanCodesAllowed(currentUser?.role || null, canSitesEdit);
  const [busy, setBusy] = useState(false);
  const download = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetchScanLinks();
      const missing = r.withoutAreas > 0 ? ` ${t('qrLinks.withoutAreas', { count: r.withoutAreas })}` : '';
      if (r.links > 0) {
        saveScanLinksCsv(r.csv, r.filename);
        toast.success(`${t('qrLinks.done', { count: r.buildings, links: r.links })}${missing}`, { duration: 7000 });
      } else {
        toast.info(`${t('qrLinks.none')}${missing}`, { duration: 7000 });
      }
    } catch (e) {
      toast.error(e?.message || t('qrLinks.failed'));
    } finally {
      setBusy(false);
    }
  };
  return { show, busy, download };
}

export default useScanLinksDownload;
