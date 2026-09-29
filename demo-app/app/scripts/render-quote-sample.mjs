// Offline calibration: render the quote template with sample field values +
// stand-in signatures, write /tmp/quote-sample.pdf. No DB needed. Read the
// output to calibrate FIELD_MAP in api/_lib/quotes/pdf.js.
import { writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { renderSignedPdf } from '../api/_lib/quotes/pdf.js';

// Minimal solid-color RGBA PNG (stand-in for a drawn signature, so we can see
// exactly where the image lands on p10).
function solidPng(w, h, [r, g, b, a]) {
  const table = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc = (buf) => { let c = 0xffffffff; for (const b2 of buf) c = table[(c ^ b2) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { const off = y * (w * 4 + 1); raw[off] = 0; for (let x = 0; x < w; x++) { const p = off + 1 + x * 4; raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; raw[p + 3] = a; } }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const sig = solidPng(280, 70, [20, 20, 120, 210]);

const quote = {
  contact_name: 'Jordan Tate',
  admin_signer_name: 'Marcus Alvarez',
  client_signer_name: 'Jordan Tate',
  fields: {
    clientName: 'Jordan Tate',
    companyName: 'Acme Logistics LLC',
    fee: '$1,450/month - weekly cleaning services',
    frequency: 'twice weekly',
    restrooms: '3 restrooms',
    area: 'Warehouse + Mezzanine',
  },
};

const bytes = await renderSignedPdf(quote, { adminPng: sig, clientPng: sig });
writeFileSync('/tmp/quote-sample.pdf', bytes);
console.log('wrote /tmp/quote-sample.pdf —', bytes.length, 'bytes');
