// Encrypted site access codes (door / alarm) for the Swept-replacement ops layer.
//
//   POST /api/site-security/set     { siteId, keyNumber?, accessInstructions?,
//                                     accessLink?, doorCode?, alarmCode?, codeHint? }
//                                    -> ops.edit
//   POST /api/site-security/reveal  { siteId, which: 'door' | 'alarm' }
//                                    -> owner/admin, a holder of ops.revealCodes (the key the
//                                       app's Reveal buttons check), anyone standing-assigned
//                                       to that site, or CREW on a clean there from a day
//                                       before it starts to a day after it ends, a clean
//                                       longer than 36 h counting as 36 h
//                                       (src/lib/siteAccess.js, the rule JobDetail shows the
//                                       button by; crew only, see requireSiteAssignment).
//                                       That last path
//                                       is safe only while browser writes to public.jobs stay
//                                       revoked (Increment 1e): see requireSiteAssignment.
//
// Door/alarm codes are AES-256-GCM encrypted at rest with a DEDICATED key
// (OPS_CODE_ENCRYPTION_KEY) and written into the org_state blob as ciphertext via
// a CAS-retry loop (minimal patch so a concurrent client edit isn't clobbered).
// Plaintext is never persisted and never returned in bulk — only the single
// requested code, only to an authorized caller, only via /reveal. Because the
// blob's RLS is open and the ciphertext ships to every client, protection rests
// entirely on the key staying server-side (NEVER VITE_-prefixed) and the reveal
// route's server-side authorization. See CLEANSPACE_SWEPT.md §2.4.

import { encrypt, decrypt } from '../_lib/crypto.js';
import { readOrgState, writeOrgState } from '../_lib/orgState.js';
import { requirePermission, requireSiteAssignment } from '../_lib/authz.js';
import { fanOutOpsNotification } from '../../src/lib/notifications.js';
import { CODE_REVEAL_WINDOW } from '../../src/lib/siteAccess.js';

const OPS_KEY = 'OPS_CODE_ENCRYPTION_KEY';

// CAS-retry: read current org_state, patch ONLY the one site's security block,
// write with optimistic version check, retry a few times on a concurrent bump.
// `actorEmail` (the manager saving codes) drives the accountOpsUpdated fan-out
// so a door/alarm code change pings the account's assigned crew — the same
// notification the client Operations tab fires — instead of changing silently.
async function casPatchSiteSecurity(siteId, makeSecurity, { actorEmail } = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const { state, version } = await readOrgState();
    const sites = Array.isArray(state?.sites) ? state.sites : [];
    const idx = sites.findIndex((s) => s.id === siteId);
    if (idx < 0) return { ok: false, notfound: true };
    const security = makeSecurity(sites[idx].security || {}, state);
    const nextSites = sites.slice();
    nextSites[idx] = { ...sites[idx], security };
    let nextState = { ...state, sites: nextSites };
    // Notify the account's crew — computed against the patched state and written
    // atomically with the site so a CAS retry can't split the two. Best-effort:
    // a fan-out error must never block persisting the (already-encrypted) codes.
    try {
      const site = nextSites[idx];
      if (site.clientId) {
        const users = Array.isArray(state?.users) ? state.users : [];
        const actor = users.find((u) => (u.email || '').toLowerCase() === (actorEmail || '').toLowerCase());
        nextState = {
          ...nextState,
          notifications: fanOutOpsNotification(nextState, {
            clientId: site.clientId,
            actorName: actor?.name,
            summary: 'Access or security details were updated.',
          }),
        };
      }
    } catch { /* best-effort — persist the codes regardless */ }
    const ok = await writeOrgState(nextState, version);
    if (ok) return { ok: true, security };
  }
  return { ok: false, conflict: true };
}

export default async function handler(req, res) {
  // Vercel rewrites multi-segment paths in via ?subpath=; single-seg still hits
  // the catch-all directly. Handle both (matches the quotes route pattern).
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
    : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [action] = path;
  const body = req.body || {};
  const siteId = body.siteId;

  try {
    if (action === 'set' && req.method === 'POST') {
      const g = await requirePermission(req, res, 'ops.edit');
      if (!g) return;
      if (!siteId) return res.status(400).json({ error: 'siteId is required' });

      const result = await casPatchSiteSecurity(siteId, (prev) => {
        // undefined => keep existing; '' => clear; value => (re)encrypt.
        const setCipher = (plain, prevCipher) =>
          plain === undefined ? (prevCipher ?? null)
            : plain === '' ? null
              : encrypt(plain, OPS_KEY);
        return {
          ...prev,
          keyNumber: body.keyNumber ?? prev.keyNumber ?? '',
          accessInstructions: body.accessInstructions ?? prev.accessInstructions ?? '',
          accessLink: body.accessLink ?? prev.accessLink ?? null,
          doorCodeCipher: setCipher(body.doorCode, prev.doorCodeCipher),
          alarmCodeCipher: setCipher(body.alarmCode, prev.alarmCodeCipher),
          codeHint: body.codeHint ?? prev.codeHint ?? null,
          updatedAt: new Date().toISOString(),
          updatedByUserId: g.orgUserId,
        };
      }, { actorEmail: g.user.email });

      if (result.notfound) return res.status(404).json({ error: 'Site not found' });
      if (!result.ok) return res.status(409).json({ error: 'Write conflict — please retry' });
      // Return the safe fields + presence flags only; never the ciphertext or plaintext.
      const s = result.security;
      return res.status(200).json({
        security: {
          keyNumber: s.keyNumber,
          accessInstructions: s.accessInstructions,
          accessLink: s.accessLink,
          codeHint: s.codeHint,
          hasDoorCode: !!s.doorCodeCipher,
          hasAlarmCode: !!s.alarmCodeCipher,
          updatedAt: s.updatedAt,
          updatedByUserId: s.updatedByUserId,
        },
      });
    }

    if (action === 'reveal' && req.method === 'POST') {
      if (!siteId) return res.status(400).json({ error: 'siteId is required' });
      const g = await requireSiteAssignment(req, res, siteId, {
        managerRoles: ['owner', 'admin'],
        bypassPermission: 'ops.revealCodes',
        allowJobBased: true,
        jobRoles: ['crew'],
        jobWindow: CODE_REVEAL_WINDOW,
      });
      if (!g) return;
      const which = body.which === 'alarm' ? 'alarm' : 'door';
      const { state } = await readOrgState();
      const site = (Array.isArray(state?.sites) ? state.sites : []).find((s) => s.id === siteId);
      const cipher = which === 'alarm' ? site?.security?.alarmCodeCipher : site?.security?.doorCodeCipher;
      if (!cipher) return res.status(404).json({ error: 'No code set for this site' });
      let code;
      try {
        code = decrypt(cipher, OPS_KEY);
      } catch {
        return res.status(500).json({ error: 'Could not decrypt code' });
      }
      // Sensitive-action audit (server log; a richer in-app audit trail can follow).
      console.log(`[site-security] ${g.user.email} revealed ${which} code for site ${siteId}`);
      return res.status(200).json({ which, code });
    }

    return res.status(404).json({ error: 'Unknown route' });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}
