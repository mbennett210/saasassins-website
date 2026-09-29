// GET /api/email/health — sending-domain verification status (NOTIF-01).
// Backs src/lib/email.js getEmailHealth(), consumed by Settings → Integrations
// "Check domain" and the ConnectEmailProviderModal.
//
// Primary source: Resend GET /domains (official status + per-record state).
// Fallback: direct DNS probes of the same records — needed when RESEND_API_KEY
// is a send-only restricted key (the domains endpoint then 401s even though
// sending works). DNS is authoritative enough: Resend's "verified" is exactly
// "these records resolve".

import { requireAuthority } from '../_lib/authz.js';
import { defaultFrom, verifiedDomain } from '../_lib/email.js';

const DNS_TIMEOUT_MS = 4000;

// TXT lookup over DNS-over-HTTPS rather than node:dns — raw port-53 resolution
// is environment-dependent (blocked in some sandboxes/proxies), while HTTPS
// egress is a given anywhere this function already calls the Resend API.
async function txt(host) {
  try {
    const resp = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=TXT`,
      { signal: AbortSignal.timeout(DNS_TIMEOUT_MS) }
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    const answers = Array.isArray(json?.Answer) ? json.Answer : [];
    // type 16 = TXT; data arrives quoted and possibly chunked ("part1" "part2").
    return answers
      .filter((a) => a.type === 16)
      .map((a) => String(a.data || '').replace(/^"|"$/g, '').replace(/"\s+"/g, ''));
  } catch {
    return null; // NXDOMAIN / timeout — treated as "record missing"
  }
}

// Resend statuses → the vocabulary the Integrations badge maps
// ('not_started' | 'pending' | 'verified' | 'failed').
function mapStatus(s) {
  if (s === 'failure') return 'failed';
  if (s === 'temporary_failure') return 'pending';
  return s || 'pending';
}

async function fromResendApi(domain) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  let json;
  try {
    const resp = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!resp.ok) return null; // restricted key or transient API failure → DNS fallback
    json = await resp.json();
  } catch {
    return null;
  }
  const d = (json?.data || []).find((x) => (x.name || '').toLowerCase() === domain);
  if (!d) return { status: 'not_started', dkimRecords: [], spfStatus: null };
  const records = Array.isArray(d.records) ? d.records : [];
  const dkim = records.filter((r) => r.record === 'DKIM');
  const spf = records.filter((r) => r.record === 'SPF');
  return {
    status: mapStatus(d.status),
    dkimRecords: dkim.map((r) => ({ host: r.name, type: r.type, value: r.value, status: mapStatus(r.status) })),
    spfStatus: spf.length && spf.every((r) => r.status === 'verified') ? 'verified' : (mapStatus(spf[0]?.status) || null),
    source: 'resend',
  };
}

async function fromDns(domain) {
  const [dkim, spf] = await Promise.all([
    txt(`resend._domainkey.${domain}`),
    txt(`send.${domain}`),
  ]);
  const dkimOk = Boolean(dkim?.some((r) => r.includes('p=')));
  const spfOk = Boolean(spf?.some((r) => r.toLowerCase().includes('v=spf1')));
  return {
    status: dkimOk && spfOk ? 'verified' : 'pending',
    dkimRecords: dkimOk
      ? [{ host: `resend._domainkey.${domain}`, type: 'TXT', value: dkim.find((r) => r.includes('p=')), status: 'verified' }]
      : [{ host: `resend._domainkey.${domain}`, type: 'TXT', value: null, status: 'pending' }],
    spfStatus: spfOk ? 'verified' : 'pending',
    source: 'dns',
  };
}

// DMARC sits on the organizational domain (relaxed alignment), so probe the
// subdomain first, then walk up to the registrable root.
async function dmarcStatus(domain) {
  const labels = domain.split('.');
  const hosts = [`_dmarc.${domain}`];
  if (labels.length > 2) hosts.push(`_dmarc.${labels.slice(-2).join('.')}`);
  for (const host of hosts) {
    const records = await txt(host);
    if (records?.some((r) => r.toUpperCase().startsWith('V=DMARC1'))) return 'verified';
  }
  return 'missing';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  // A member of the team, not just any session (authz.js ROSTER STATUS).
  if (!(await requireAuthority(req, res))) return;

  const domain = verifiedDomain();
  if (!domain) {
    res.status(200).json({
      status: 'not_started',
      verifiedDomain: null,
      defaultFrom: null,
      dkimRecords: [],
      spfStatus: null,
      dmarcStatus: null,
      lastCheckedAt: new Date().toISOString(),
      failureReason: 'No sending domain configured',
    });
    return;
  }

  const [base, dmarc] = await Promise.all([
    fromResendApi(domain).then((r) => r || fromDns(domain)),
    dmarcStatus(domain),
  ]);

  res.status(200).json({
    status: base.status,
    verifiedDomain: domain,
    defaultFrom: defaultFrom(),
    dkimRecords: base.dkimRecords,
    spfStatus: base.spfStatus,
    dmarcStatus: dmarc,
    lastCheckedAt: new Date().toISOString(),
    source: base.source,
    ...(base.status === 'failed' ? { failureReason: 'Domain verification failed — re-check DNS records in Resend' } : {}),
  });
}
