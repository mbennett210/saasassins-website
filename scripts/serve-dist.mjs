// Serve the assembled site (dist/) the way vercel.json does, for local checks and Forge's styling measures:
// clean URLs, the filesystem only. (vercel.json's redirects of the old /polishpoint addresses aren't served here.)
//   npm run build && node scripts/serve-dist.mjs [port]      (default 4317, or $PORT)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.argv[2] || process.env.PORT || 4317);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.PNG': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.mjs': 'text/javascript',
};
const file = (p) => { try { return fs.statSync(p).isFile() ? p : null; } catch { return null; } };

if (!fs.existsSync(root)) { console.error('serve-dist: no dist/ yet, run `npm run build` first'); process.exit(1); }
http.createServer((req, res) => {
  const p = path.normalize(decodeURIComponent(new URL(req.url, 'http://local').pathname));
  if (p.includes('..')) { res.writeHead(400); return res.end(); }
  let f = file(path.join(root, p)) || file(path.join(root, `${p}.html`)) || file(path.join(root, p, 'index.html'));
  if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(f).pipe(res);
}).listen(port, () => console.log(`serve-dist: http://localhost:${port}`));
