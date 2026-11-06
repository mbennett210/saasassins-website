// A supply catalog PICTURE FROM A LINK (task 257: the import's Photo column may hold a web address —
// a supplier's own image link, an IMAGE() formula, a hyperlink). The route is POST
// /api/supplies/catalog/image-link; the browser cannot read another site's picture (CORS), so the
// server downloads it and hands the bytes back, and the browser shrinks and stores it through the
// ordinary product-image door (EP-399). Nothing here writes anything.
//
// 🔴 A SERVER THAT FETCHES A URL SOMEONE TYPED MUST NEVER BE A WAY INTO A PRIVATE NETWORK. So:
//   · http or https only, on the default ports (80 / 443), no user name or password in the link;
//   · every address the name resolves to is checked INSIDE THE SOCKET'S OWN LOOKUP (guardedLookup),
//     so the address connected to is the address checked — a name that answers a public address to
//     a first lookup and a private one to the second gets nowhere. Any private, loopback,
//     link-local, carrier-grade NAT, multicast, documentation or reserved address refuses the whole
//     name; an address written in the link is checked the same way;
//   · redirects are followed by hand, at most LINK_IMAGE_MAX_REDIRECTS, each one checked again;
//   · one deadline for the whole download (LINK_IMAGE_TIMEOUT_MS), at most LINK_IMAGE_MAX_BYTES
//     read (a bigger declared or streamed body is cut off), and the bytes must BE a picture the
//     browser can draw (JPEG, PNG, GIF, WebP, BMP — read from the first bytes, never the server's
//     word). What comes back is the bytes; nothing of the remote page is passed on.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { pictureType, DRAWABLE_PICTURES } from '../../../src/lib/xlsx.js';

export const LINK_IMAGE_MAX_BYTES = 3 * 1024 * 1024; // its data URL stays under the platform's 4.5 MB answer
export const LINK_IMAGE_TIMEOUT_MS = 8000;
export const LINK_IMAGE_MAX_REDIRECTS = 3;
export const LINK_IMAGE_MAX_LENGTH = 2000;
// Per login: a few hundred rows of links is one import; this is a ceiling, not a pace.
export const LINK_IMAGE_RATE = { limit: 1000, windowMs: 60 * 60 * 1000 };

// ── which addresses are the public internet ─────────────────────────────────────────────────
function v4(ip) {
  const p = String(ip).split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
}
export function isPublicIPv4(ip) {
  const p = v4(ip);
  if (!p) return false;
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127) return false;            // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false;             // carrier-grade NAT
  if (a === 169 && b === 254) return false;                       // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return false;              // private
  if (a === 192 && b === 168) return false;                       // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;  // IETF, documentation
  if (a === 192 && b === 88 && c === 99) return false;            // 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return false;          // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;           // documentation
  if (a === 203 && b === 0 && c === 113) return false;            // documentation
  if (a >= 224) return false;                                     // multicast, reserved, broadcast
  return true;
}
// An IPv6 address as its eight 16-bit groups (an IPv4 tail read as two), or null.
function v6Groups(ip) {
  let s = String(ip).toLowerCase();
  if (s.includes('%')) return null; // a zone id: link-local, never the internet
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const p = v4(tail[1]);
    if (!p) return null;
    s = s.slice(0, -tail[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0) return null;
  const groups = [...left, ...Array(fill).fill('0'), ...right].map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  return groups.length === 8 && groups.every((n) => Number.isInteger(n)) ? groups : null;
}
export function isPublicIPv6(ip) {
  const g = v6Groups(ip);
  if (!g) return false;
  const zeroTo = (n) => g.slice(0, n).every((x) => x === 0);
  if (zeroTo(5) && g[5] === 0xffff) return isPublicIPv4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`); // IPv4-mapped
  if (zeroTo(6)) return false;                                   // ::, ::1, IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return false;            // NAT64
  if (g[0] === 0x100 && zeroTo(0) && g[1] === 0 && g[2] === 0 && g[3] === 0) return false; // discard
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8 || (g[1] >= 0x10 && g[1] <= 0x2f))) return false; // Teredo, documentation, ORCHID
  if (g[0] === 0x2002) return false;                             // 6to4
  return g[0] >= 0x2000 && g[0] <= 0x3fff;                       // only global unicast
}
export function isPublicAddress(ip) {
  const family = net.isIP(String(ip || ''));
  if (family === 4) return isPublicIPv4(ip);
  if (family === 6) return isPublicIPv6(ip);
  return false;
}

// ── the link itself ─────────────────────────────────────────────────────────────────────────
// → { ok: true, url } | { ok: false, code: 'bad_link' | 'blocked_port' | 'blocked_address' }
export function checkLink(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.length > LINK_IMAGE_MAX_LENGTH) return { ok: false, code: 'bad_link' };
  let u;
  try { u = new URL(s); } catch { return { ok: false, code: 'bad_link' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, code: 'bad_link' };
  if (u.username || u.password) return { ok: false, code: 'bad_link' };
  if (u.port && u.port !== '80' && u.port !== '443') return { ok: false, code: 'blocked_port' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, code: 'bad_link' };
  if (net.isIP(host)) return isPublicAddress(host) ? { ok: true, url: u.href } : { ok: false, code: 'blocked_address' };
  if (/(^|\.)(localhost|local|internal|home\.arpa)$/i.test(host) || !host.includes('.')) return { ok: false, code: 'blocked_address' };
  return { ok: true, url: u.href };
}

// The socket's lookup, refusing a name any of whose addresses is not the public internet. Node calls
// it as lookup(hostname, options, callback), asking for every address (`all`) or one.
export function guardedLookup(lookupImpl = dns.lookup) {
  return (hostname, options, callback) => {
    const opts = options && typeof options === 'object' ? options : { family: Number(options) || 0 };
    lookupImpl(hostname, { family: opts.family || 0, hints: opts.hints, all: true }, (err, addresses) => {
      if (err) { callback(err); return; }
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(String(addresses)) }];
      if (!list.length || list.some((a) => !a || !isPublicAddress(a.address))) {
        callback(Object.assign(new Error('That address is not on the public internet.'), { code: 'EBLOCKED' }));
        return;
      }
      if (opts.all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    });
  };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const defaultGet = (url, opts, onResponse) => (url.startsWith('https:') ? https : http).get(url, opts, onResponse);
// Tests swap the network for a stand-in (the suites block the real one); the route never passes any.
let deps = { lookup: dns.lookup, get: defaultGet };
export function __setLinkImageDeps(next) { deps = next ? { ...deps, ...next } : { lookup: dns.lookup, get: defaultGet }; }

function requestOnce(url, { lookup, get, deadline, maxBytes }) {
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const left = deadline - Date.now();
    const timer = setTimeout(() => { finish({ ok: false, code: 'timeout' }); try { if (req) req.destroy(); } catch { /* gone */ } }, Math.max(0, left));
    function finish(v) { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } }
    if (left <= 0) { finish({ ok: false, code: 'timeout' }); return; }
    try {
      req = get(url, {
        lookup, agent: false,
        headers: { 'user-agent': 'supply-catalog-import/1.0', accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8' },
      }, (res) => {
        const status = res.statusCode || 0;
        if (REDIRECTS.has(status)) {
          const to = res.headers && res.headers.location;
          res.resume();
          finish(to ? { redirect: String(to) } : { ok: false, code: 'unreachable' });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          finish({ ok: false, code: status === 404 || status === 410 ? 'not_found' : 'unreachable' });
          return;
        }
        const declared = Number(res.headers && res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) { res.destroy(); finish({ ok: false, code: 'too_large' }); return; }
        const parts = [];
        let total = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          total += chunk.length;
          if (total > maxBytes) { res.destroy(); finish({ ok: false, code: 'too_large' }); return; }
          parts.push(chunk);
        });
        res.on('end', () => {
          const bytes = Buffer.concat(parts);
          const type = pictureType(bytes);
          finish(bytes.length && DRAWABLE_PICTURES.has(type) ? { ok: true, bytes, type } : { ok: false, code: 'not_an_image' });
        });
        res.on('error', () => finish({ ok: false, code: 'unreachable' }));
      });
      req.on('error', (e) => finish({ ok: false, code: e && e.code === 'EBLOCKED' ? 'blocked_address' : 'unreachable' }));
    } catch {
      finish({ ok: false, code: 'unreachable' });
    }
  });
}

// DOWNLOAD THE PICTURE BEHIND A LINK. → { ok: true, bytes: Buffer, type } | { ok: false, code:
// 'bad_link' | 'blocked_port' | 'blocked_address' | 'not_found' | 'unreachable' | 'timeout' |
// 'too_large' | 'not_an_image' | 'too_many_redirects' }.
export async function fetchLinkImage(raw, { timeoutMs = LINK_IMAGE_TIMEOUT_MS, maxBytes = LINK_IMAGE_MAX_BYTES } = {}) {
  const first = checkLink(raw);
  if (!first.ok) return first;
  const lookup = guardedLookup(deps.lookup);
  const deadline = Date.now() + timeoutMs;
  let url = first.url;
  for (let hop = 0; ; hop += 1) {
    const r = await requestOnce(url, { lookup, get: deps.get, deadline, maxBytes });
    if (!r.redirect) return r;
    if (hop >= LINK_IMAGE_MAX_REDIRECTS) return { ok: false, code: 'too_many_redirects' };
    let next;
    try { next = new URL(r.redirect, url).href; } catch { return { ok: false, code: 'bad_link' }; }
    const checked = checkLink(next);
    if (!checked.ok) return checked;
    url = checked.url;
  }
}
