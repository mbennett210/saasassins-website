// Render a sample quote to quote-test.pdf for visual FIELD_MAP calibration.
//   node scripts/render-quote-test.mjs
import { writeFileSync } from 'node:fs';
import { renderSignedPdf } from '../api/_lib/quotes/pdf.js';

const quote = {
  fields: {
    clientName: 'Daniel Tuccillo',
    companyName: 'Northshore Auto',
    fee: '$1,160/month - weekly cleaning services',
    frequency: 'once per week',
    restrooms: '3 restrooms',
    area: 'Warehouse + Mezzanine',
  },
  contact_name: 'Daniel Tuccillo',
  admin_signer_name: 'Kyle Buyden',
};

const bytes = await renderSignedPdf(quote, {});
const out = new URL('../../quote-test.pdf', import.meta.url);
writeFileSync(out, Buffer.from(bytes));
console.log('wrote', out.pathname);
