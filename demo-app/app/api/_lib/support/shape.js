// PURE shaping for the in-app "Report an issue" proxy (/api/support/*).
//
// The browser never talks to the SaaSassins CRM and never sees the portal
// token: the two routes under api/support/ forward to the CRM public support
// API with a server-env token. Everything here is pure and IO-free so
// scripts/test-support-report.mjs can pin the semantics offline.
//
// Contract (CRM side, verified 2026-07-31 against the live route):
//   POST {base}/{token}/uploads  {name,mimeType,sizeBytes} → 200 {attachmentId, path, signedUrl, ...}
//   POST {base}/{token}/tickets  {subject, description, priority, submitterName,
//                                 submitterEmail, attachments, context} → 201 {ticket}
//   404 = unknown token · 410 = revoked token · 400 = caller error (message is safe to relay)

// Self-service priorities. The CRM clamps 'urgent' → 'high' on the public path
// (a button everyone presses means nothing); mirror it here so the UI's promise
// ("High") matches what lands in the queue, and junk falls to 'normal'.
export const SUPPORT_PRIORITIES = ['normal', 'high', 'low'];

export function clampPriority(priority) {
  if (priority === 'urgent') return 'high';
  return SUPPORT_PRIORITIES.includes(priority) ? priority : 'normal';
}

// Metadata rows for files the browser already PUT to Storage via signed URLs we
// minted. Untrusted input: cap the count, require the identifying fields, and
// coerce/slice everything. The CRM re-derives storage paths from the ids it
// minted, so a forged path here cannot reach another client's file — this trim
// is about not forwarding garbage, not about access control.
export const ATTACHMENT_MAX_COUNT = 6;

export function sanitizeAttachments(list) {
  const rows = Array.isArray(list) ? list : [];
  return rows
    .filter((a) => a && typeof a === 'object' && a.id && a.path && a.name)
    .slice(0, ATTACHMENT_MAX_COUNT)
    .map((a) => ({
      id: String(a.id).slice(0, 100),
      path: String(a.path).slice(0, 500),
      name: String(a.name).slice(0, 200),
      mimeType: String(a.mimeType || '').slice(0, 100),
      sizeBytes: Number(a.sizeBytes) || 0,
    }));
}

// Diagnostics the app captures silently. Whitelist — an unknown key from the
// browser does not ride into the CRM (its Environment panel renders unknown
// keys generically, so a spoofed key would render as if staff-trusted).
// `source`, `user`, and the whole identity block (userId / role / roleSource /
// identitySource) are ALWAYS server-authored: identity comes from the JWT, never
// from the body — a reporter must not be able to self-declare a role or a healthy
// identity provenance that staff might trust when acting on the ticket.
const CONSOLE_ERRORS_MAX = 10;
const CONSOLE_ERROR_CHARS = 2000;

export function buildContext(clientCtx, { name, email, userId, role, roleSource, identitySource } = {}) {
  const c = clientCtx && typeof clientCtx === 'object' ? clientCtx : {};
  const str = (v, max) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined);
  // null/'' would coerce to 0 through Number(); reject them so a blank never
  // rides in as a spurious zero.
  const num = (v) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const bool = (v) => (typeof v === 'boolean' ? v : undefined);
  const errors = Array.isArray(c.consoleErrors)
    ? c.consoleErrors
        .filter((e) => typeof e === 'string' && e.trim())
        .slice(-CONSOLE_ERRORS_MAX)
        .map((e) => e.slice(0, CONSOLE_ERROR_CHARS))
    : [];
  const who = name && email ? `${name} <${email}>` : (email || undefined);
  const tabAge = num(c.tabAgeSec);
  const out = {
    source: 'in-app',
    route: str(c.route, 500),
    appVersion: str(c.appVersion, 100),
    appBuild: num(c.appBuild),                 // monotonic build id (fleet-reload gate)
    // When + where: the browser's own clock/zone beside company.timezone is what
    // makes a stale-tab or wrong-zone report self-evident to a backend dev.
    clientTime: str(c.clientTime, 40),         // client ISO timestamp at submit
    timezone: str(c.timezone, 60),             // resolved IANA zone
    locale: str(c.locale, 20),
    userAgent: str(c.userAgent, 400),
    viewport: str(c.viewport, 40),
    dpr: num(c.dpr),
    colorScheme: str(c.colorScheme, 10),
    // Session/connectivity: a stale tab (high tabAgeSec, low appBuild) and an
    // offline/queued client are the two commonest "it's broken" non-bugs.
    online: bool(c.online),
    syncStatus: str(c.syncStatus, 20),
    tabId: str(c.tabId, 40),
    tabAgeSec: tabAge !== undefined ? Math.max(0, Math.round(tabAge)) : undefined,
    // Data-layer sync state: which shared-blob (CAS) version the client was on and
    // whether work was still queued locally — the "I saved it and it vanished",
    // "I'm seeing old data", and crew "my photos aren't uploading" classes.
    orgStateVersion: num(c.orgStateVersion),
    pendingWrites: num(c.pendingWrites),
    dirty: bool(c.dirty),
    mediaQueueDepth: num(c.mediaQueueDepth),
    checklistQueueDepth: num(c.checklistQueueDepth),
    user: who,
    // ── Server-authored identity provenance (NOT read from the body) ──────────
    userId: userId || undefined,
    role: role || undefined,
    roleSource: roleSource || undefined,       // 'claim' | 'blob'
    identitySource: identitySource || undefined, // roster | email-match | claim-only | blob-fallback
    consoleErrors: errors.length ? errors : undefined,
  };
  // Drop undefined keys so the CRM's Environment panel doesn't render blanks.
  Object.keys(out).forEach((k) => { if (out[k] === undefined) delete out[k]; });
  return out;
}

// Map a CRM failure onto what OUR caller should see. 404/410 mean the portal
// token is wrong/revoked — that is a config/ops problem, not the reporter's,
// so it surfaces as a generic "support unavailable" 503 (never leaks token
// state). 400 messages are written for end users on the CRM side and are safe
// to relay. Anything else is a 502.
export function mapCrmFailure(status, crmError) {
  if (status === 400 && crmError) return { status: 400, error: String(crmError).slice(0, 300) };
  if (status === 404 || status === 410) {
    return { status: 503, error: 'Support is temporarily unavailable. Please try again shortly, or email your account manager.' };
  }
  return { status: 502, error: 'Support is temporarily unavailable. Please try again shortly.' };
}
