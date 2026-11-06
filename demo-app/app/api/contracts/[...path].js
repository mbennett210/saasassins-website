// CONTRACT TRACKING API (CS-194, Matt's CON-1..CON-14). A catch-all domain — its
// `vercel.json` rewrite is `/api/contracts/:rest* -> /api/contracts/_?subpath=:rest*`, and
// without it every pretty URL here 404s while the file path works (BUILD_INTEGRITY §2).
//
//   GET  /api/contracts/list                      -> { contracts, bookValueCents|null, today }
//        each contract carries `buildingsArchived` (every building on it archived: it has left the
//        book and its value is not counted — CS-663, lib/contracts contractLeftTheBook)
//   GET  /api/contracts/for-client?clientId=       -> { contracts }
//   GET  /api/contracts/<id>                      -> { contract }
//   POST /api/contracts/create                    -> { contract, created }
//   POST /api/contracts/<id>/save                 -> { contract }
//   POST /api/contracts/<id>/delete               -> { ok }
//   POST /api/contracts/reminders/<id>            -> { reminder }     CON-10 done/snooze/note
//   POST /api/contracts/<id>/upload-url           -> { path, token, signedUrl }   CON-11
//   POST /api/contracts/<id>/document             -> { ok }           record it after upload
//   POST /api/contracts/<id>/download-url         -> { url }
//   POST /api/contracts/<id>/document-delete      -> { ok }
//
// ── AUTH STANCE (declared at creation, by capability — BUILD_INTEGRITY §2) ───────────────
// READ branches gate on `contracts.view`, WRITE branches on `contracts.edit`, both through
// `requirePermission`, which runs the SAME `can()` the screens run against the COMMITTED
// matrix + per-user overrides. Crew hold neither by default and the route refuses them
// whatever the UI does — RLS is open, so this gate IS the boundary.
//
// 🔴 A SECOND, FINER GATE DECIDES THE MONEY (CS-019 / Q24). A contract's prices and its
// annual value are REVENUE, so they are served only to a holder of `invoices.view`
// (`holdsPermission`, the non-writing read-side check). Two halves, and BOTH are needed:
//   · reads  — `project()` nulls every price for anyone else, and says `moneyVisible: false`
//              so a screen can print "Hidden" rather than "$0.00".
//   · writes — the store IGNORES money fields from the same caller. Without that half, the
//              screen's own round-trip is the bug: read a stripped contract, press Save, and
//              every price is written back as zero. Stripping a read without deafening the
//              write is how a privacy gate becomes a data-loss gate.
//
// Every date the server decides is a DAY KEY in the ORG's timezone, never the process zone
// (this function runs TZ=UTC — THE LAW II.8).
import { requirePermission, holdsPermission } from '../_lib/authz.js';
import { logActivityAs } from '../_lib/activityLog.js';
import { readProtectedSlices } from '../_lib/orgState.js';
import { readErrorStatus } from '../_lib/pagedSelect.js';
import { dayKey } from '../../src/lib/dates.js';
import { annualValueCents, bookValueCents, contractLeftTheBook, customerVisibleChange } from '../../src/lib/contracts.js';
import { queueServiceChange } from '../_lib/customerMessages/contractEvents.js';
import { archivedClientIds } from '../../src/lib/customerStatus.js';
import {
  ContractRefusal, isContractId,
  listContracts, getContract, contractsForClient,
  createContract, saveContract, deleteContract, updateReminder,
  validateUpload, signedUploadUrl, signedDownloadUrl, setDocument, removeDocument,
  project,
} from '../_lib/contracts/store.js';

// The org's calendar day. `company.timezone` is a tiny projection of the shared record, and
// a falsy zone resolves to the org default inside lib/dates (never the process zone).
async function orgToday() {
  try {
    const data = await readProtectedSlices('company:state->company');
    return dayKey(new Date(), (data && data.company && data.company.timezone) || null);
  } catch {
    return dayKey(new Date(), null);
  }
}

// The customers slice, for the activity row's `client_name` and the screens' labels — and which
// customers are ARCHIVED (CS-663: a contract over only those has left the book).
async function clientBook() {
  try {
    const data = await readProtectedSlices('clients:state->clients');
    const rows = Array.isArray(data && data.clients) ? data.clients : [];
    return { names: new Map(rows.map((c) => [c.id, c.name || null])), archived: archivedClientIds(rows) };
  } catch {
    return { names: new Map(), archived: new Set() };
  }
}
const clientNames = async () => (await clientBook()).names;

// What a contract row is ABOUT, for the log. A master agreement covers several buildings and
// the log has one `client_id` column, so it files under the first and the summary names the
// agreement — better than filing a ten-building contract under nobody.
function logSubject(contract, names) {
  const clientId = (contract.clientIds || [])[0] || null;
  const clientName = clientId ? (names.get(clientId) || null) : null;
  const label = contract.name || clientName || 'a contract';
  const extra = (contract.clientIds || []).length > 1 ? ` (+${contract.clientIds.length - 1} more buildings)` : '';
  return { clientId, clientName, label: `${label}${extra}` };
}

// before/after for the log (LOG-3). Money in CENTS, dates as day keys — the pair a dispute
// turns on. Never a formatted timestamp: a write point has no org zone and a stored string
// cannot be re-zoned later, so every reader formats these itself.
const logShape = (c) => (c ? {
  status: c.status,
  startDate: c.startDate,
  endDate: c.endDate,
  termType: c.termType,
  termMonths: c.termMonths,
  monthlyCents: c.baseMonthlyCents,
  yearPricesCents: (c.years || []).map((y) => y.monthlyCents),
  lineCents: (c.lines || []).map((l) => l.monthlyCents),
  clientIds: c.clientIds,
} : null);

function editSummary(label, before, after) {
  const moved = [];
  const b = logShape(before);
  const a = logShape(after);
  if (b.status !== a.status) moved.push(`status ${b.status} → ${a.status}`);
  if (b.monthlyCents !== a.monthlyCents) moved.push(`monthly ${b.monthlyCents} → ${a.monthlyCents} cents`);
  if (b.startDate !== a.startDate) moved.push(`start ${b.startDate} → ${a.startDate}`);
  if (b.endDate !== a.endDate) moved.push(`end ${b.endDate || 'none'} → ${a.endDate || 'none'}`);
  if (b.termType !== a.termType) moved.push(`term ${b.termType} → ${a.termType}`);
  if (JSON.stringify(b.yearPricesCents) !== JSON.stringify(a.yearPricesCents)) moved.push('year prices changed');
  if (JSON.stringify(b.lineCents) !== JSON.stringify(a.lineCents)) moved.push('extra services changed');
  if (JSON.stringify(b.clientIds) !== JSON.stringify(a.clientIds)) moved.push('buildings changed');
  return `${label}: ${moved.length ? moved.join(', ') : 'edited'}`;
}

export default async function handler(req, res) {
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const body = req.body || {};
  const [head, tail] = path;

  try {
    // ── reads ───────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const g = await requirePermission(req, res, 'contracts.view');
      if (!g) return;
      const money = await holdsPermission(g, 'invoices.view');
      const today = await orgToday();

      if (head === 'list') {
        const full = await listContracts({ today });
        const { names, archived } = await clientBook();
        const contracts = full.map((c) => ({
          ...project(c, { money }),
          annualValueCents: money ? annualValueCents(c, { years: c.years, lines: c.lines }, today) : null,
          clientNames: (c.clientIds || []).map((id) => names.get(id) || null),
          buildingsArchived: contractLeftTheBook(c, archived),
        }));
        return res.status(200).json({
          contracts,
          today,
          // The book total is money, so it is served to nobody else — null, not 0. A contract
          // whose every building is archived has left the book (CS-663).
          bookValueCents: money
            ? bookValueCents(full.map((c) => ({ contract: c, years: c.years, lines: c.lines })), today, archived)
            : null,
          moneyVisible: money,
        });
      }

      if (head === 'for-client') {
        const clientId = typeof req.query.clientId === 'string' ? req.query.clientId : '';
        if (!clientId) return res.status(400).json({ error: 'clientId is required' });
        const full = await contractsForClient(clientId);
        const names = await clientNames();
        return res.status(200).json({
          today,
          moneyVisible: money,
          contracts: full.map((c) => ({
            ...project(c, { money }),
            annualValueCents: money ? annualValueCents(c, { years: c.years, lines: c.lines }, today) : null,
            clientNames: (c.clientIds || []).map((id) => names.get(id) || null),
          })),
        });
      }

      if (isContractId(head) && !tail) {
        const c = await getContract(head);
        if (!c) return res.status(404).json({ error: 'Contract not found' });
        const names = await clientNames();
        return res.status(200).json({
          today,
          moneyVisible: money,
          contract: {
            ...project(c, { money }),
            annualValueCents: money ? annualValueCents(c, { years: c.years, lines: c.lines }, today) : null,
            clientNames: (c.clientIds || []).map((id) => names.get(id) || null),
          },
        });
      }
      return res.status(404).json({ error: 'Unknown route' });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // ── CON-10: a reminder is marked done, snoozed, or noted ────────────────
    if (head === 'reminders' && tail) {
      const g = await requirePermission(req, res, 'contracts.edit');
      if (!g) return;
      const reminder = await updateReminder(tail, {
        status: body.status, snoozeUntil: body.snoozeUntil, note: body.note, actor: g.orgUserId,
      });
      return res.status(200).json({ reminder });
    }

    // ── writes ──────────────────────────────────────────────────────────────
    if (head === 'create') {
      const g = await requirePermission(req, res, 'contracts.edit');
      if (!g) return;
      const money = await holdsPermission(g, 'invoices.view');
      const today = await orgToday();
      const { contract, created } = await createContract(body, { actor: g.orgUserId, money, today });
      if (created) {
        const names = await clientNames();
        const subject = logSubject(contract, names);
        // Best-effort and loud: a failed audit row must never undo a contract the office
        // just entered (api/_lib/activityLog reports `activity_log.write_failed`).
        await logActivityAs(g, {
          action: 'contract.created',
          entityId: contract.id,
          clientId: subject.clientId,
          clientName: subject.clientName,
          summary: `${subject.label}: contract added (${contract.status})`,
          before: null,
          after: logShape(contract),
        });
      }
      return res.status(200).json({ contract: project(contract, { money }), created });
    }

    if (isContractId(head) && tail === 'save') {
      const g = await requirePermission(req, res, 'contracts.edit');
      if (!g) return;
      const money = await holdsPermission(g, 'invoices.view');
      const today = await orgToday();
      const { before, contract } = await saveContract(head, body, { money, today });
      // The service-change confirmation (Matt's approved messages): a change the customer would
      // notice is queued for the reminders run, one per building. Best-effort: the save stands.
      const change = customerVisibleChange(before, contract, today);
      if (change) await queueServiceChange(contract, change, today);
      const names = await clientNames();
      const subject = logSubject(contract, names);
      await logActivityAs(g, {
        action: 'contract.edited',
        entityId: contract.id,
        clientId: subject.clientId,
        clientName: subject.clientName,
        summary: editSummary(subject.label, before, contract),
        before: logShape(before),
        after: logShape(contract),
      });
      return res.status(200).json({ contract: project(contract, { money }) });
    }

    if (isContractId(head) && tail === 'delete') {
      const g = await requirePermission(req, res, 'contracts.edit');
      if (!g) return;
      const { before } = await deleteContract(head);
      if (!before) return res.status(404).json({ error: 'Contract not found' });
      const names = await clientNames();
      const subject = logSubject(before, names);
      await logActivityAs(g, {
        action: 'contract.deleted',
        entityId: head,
        clientId: subject.clientId,
        clientName: subject.clientName,
        summary: `${subject.label}: contract deleted`,
        before: logShape(before),
        after: null,
      });
      return res.status(200).json({ ok: true });
    }

    // ── CON-11: the signed PDF ──────────────────────────────────────────────
    if (isContractId(head) && tail === 'upload-url') {
      const g = await requirePermission(req, res, 'contracts.edit');
      if (!g) return;
      const v = validateUpload({ mimeType: body.mimeType, sizeBytes: body.sizeBytes });
      if (!v.ok) return res.status(400).json({ error: v.error });
      return res.status(200).json(await signedUploadUrl({ contractId: head, mimeType: body.mimeType }));
    }

    if (isContractId(head) && tail === 'document') {
      const g = await requirePermission(req, res, 'contracts.edit');
      if (!g) return;
      if (!body.storagePath) return res.status(400).json({ error: 'storagePath is required' });
      await setDocument(head, { name: body.name, size: body.size, storagePath: body.storagePath });
      return res.status(200).json({ ok: true });
    }

    if (isContractId(head) && tail === 'download-url') {
      const g = await requirePermission(req, res, 'contracts.view');
      if (!g) return;
      if (!body.storagePath) return res.status(400).json({ error: 'storagePath is required' });
      return res.status(200).json(await signedDownloadUrl({ contractId: head, storagePath: body.storagePath }));
    }

    if (isContractId(head) && tail === 'document-delete') {
      const g = await requirePermission(req, res, 'contracts.edit');
      if (!g) return;
      if (!body.storagePath) return res.status(400).json({ error: 'storagePath is required' });
      await removeDocument({ contractId: head, storagePath: body.storagePath });
      return res.status(200).json({ ok: true });
    }

    return res.status(404).json({ error: 'Unknown route' });
  } catch (e) {
    // A refusal the office caused (a taken building, a bad date) is its own status and its
    // own sentence; anything else is a server error with no schema in the body.
    if (e instanceof ContractRefusal) {
      return res.status(e.status).json({ error: e.message, code: e.code, ...(e.clientIds ? { clientIds: e.clientIds } : {}) });
    }
    const status = readErrorStatus(e);
    if (status !== 500) return res.status(status).json({ error: e.message });
    console.error('[api/contracts]', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
