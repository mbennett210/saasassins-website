// GUARDED data-op: re-capture inbound Gmail for the 2026-06-18 → now blackout.
//
// The poll's replies-only filter discarded fresh mail before it was stored and
// the ingest fork diverted the rest (both fixed 2026-07-31, commit f9a36cc) —
// so the missed messages exist ONLY in the Gmail mailboxes. This script lists
// every INBOX message in the window for each connected account and BUFFERS it
// into inbound_emails (upsert by gmail_message_id — idempotent, re-runnable).
// The deployed ingest cron then threads the buffer through the FIXED router
// within a minute or two; threading is idempotent by Message-ID.
//
//   node scripts/recover-inbound-window.mjs            # dry run — counts only
//   node scripts/recover-inbound-window.mjs --apply    # buffer for ingest
//
// Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + Google OAuth env (reads
// .env.local). READ-ONLY against Gmail; writes only the inbound_emails buffer.
import { readFileSync } from 'node:fs';

for (const f of ['../.env.local', '../.env.local.bak']) {
  try {
    for (const line of readFileSync(new URL(f, import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    break;
  } catch { /* try next */ }
}

const { getSupabase } = await import('../api/_lib/supabase.js');
const { getFreshAccessToken, bufferInbound } = await import('../api/_lib/accounts.js');
const { gmailGetMessage, parseInboundMessage } = await import('../api/_lib/google.js');

const APPLY = process.argv.includes('--apply');
// No in:inbox restriction: the office ARCHIVES processed mail (drops the INBOX
// label), and archived reports are exactly what we're recovering. Gmail search
// excludes spam/trash by default. Category filters keep promos out.
const WINDOW_QUERY = 'after:2026/06/18 -category:promotions -category:social';

// gmailListRecent caps at 25 with no paging — a 6-week window needs the raw
// paged endpoint. Read-only.
async function listAllIds(token, query) {
  const ids = [];
  let pageToken = null;
  for (let page = 0; page < 40; page++) {
    const params = new URLSearchParams({ q: query, maxResults: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Gmail list failed: ${data.error?.message || res.status}`);
    for (const m of data.messages || []) ids.push(m.id);
    pageToken = data.nextPageToken || null;
    if (!pageToken) break;
  }
  return ids;
}

const db = getSupabase();
const { data: accounts, error } = await db.from('inbox_accounts').select('*');
if (error) { console.error('account list failed:', error.message); process.exit(2); }

let totalFound = 0;
let totalBuffered = 0;
for (const account of accounts || []) {
  try {
    const token = await getFreshAccessToken(account);
    const unique = [...new Set(await listAllIds(token, WINDOW_QUERY))];
    console.log(`${account.email}: ${unique.length} INBOX messages in window`);
    totalFound += unique.length;
    if (!APPLY) continue;
    const rows = [];
    for (const messageId of unique) {
      const full = await gmailGetMessage(token, messageId, { format: 'full' });
      const parsed = parseInboundMessage(full);
      rows.push({
        gmail_message_id: messageId,
        rfc_message_id: parsed.messageId,
        to_inbox_email: account.email,
        from_email: parsed.fromEmail,
        subject: parsed.subject,
        body: parsed.body,
        in_reply_to: parsed.inReplyTo,
        references_header: parsed.references,
        received_at: new Date().toISOString(),
      });
    }
    // Chunked upsert; ignoreDuplicates makes already-buffered ids no-ops.
    for (let i = 0; i < rows.length; i += 100) {
      await bufferInbound(rows.slice(i, i + 100));
    }
    totalBuffered += rows.length;
    console.log(`  buffered ${rows.length}`);
  } catch (e) {
    console.error(`  ${account.email} failed: ${e?.message || e}`);
  }
}

console.log(`\n${APPLY ? 'RECOVERY BUFFERED' : 'DRY RUN'}: ${totalFound} found${APPLY ? `, ${totalBuffered} buffered — the ingest cron threads them within ~2 min` : ' — re-run with --apply to buffer'}`);
