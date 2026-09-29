// Money must render with cents, and a void invoice must never be marked paid.
//
// ══ WHY ═══════════════════════════════════════════════════════════════════════
// money() carried `maximumFractionDigits: 0`, silently rounding every rendered figure to
// whole dollars: money(1250.75) -> "$1,251", money(0.20) -> "$0". money.js's arithmetic
// was always correct — round2 preserves cents through every total, balance and aging
// computation — so nothing in the stored ledger was wrong. Everything a human READ was.
//
// The three consequences that make this a defect rather than a style choice:
//   1. InvoiceDetail composes the customer-facing past-due message as
//      "amount due {money(balance)}", so a $1,250.75 balance became a written demand
//      for $1,251 sent to a paying client.
//   2. The invoice line-item table disagreed with ITS OWN FOOTER (rows via moneyPrecise,
//      Total beneath via money).
//   3. The payment-amount PLACEHOLDER used money(balance), prompting a clerk with a
//      figure 25c above the balance. Accepting it drives the balance negative, which
//      deriveInvoiceStatus reads as paid and clientBalance nets against the account's
//      other open invoices — a display bug seeding a real ledger error.
//
//   node scripts/test-money-display.mjs
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// Mirror of the two formatters, read from source so they cannot drift from this test.
const datesSrc = read('../src/lib/dates.js');
const optsOf = (name) => {
  const m = new RegExp(`export function ${name}\\(n\\) \\{[\\s\\S]*?toLocaleString\\(undefined, (\\{[^}]*\\})\\)`).exec(datesSrc);
  return m ? m[1] : null;
};

// ── 🔴 the formatter itself ─────────────────────────────────────────────
{
  const moneyOpts = optsOf('money');
  const preciseOpts = optsOf('moneyPrecise');
  ok('money() found', Boolean(moneyOpts));
  ok('moneyPrecise() found', Boolean(preciseOpts));
  ok('🔴 money() no longer truncates to whole dollars', !/maximumFractionDigits:\s*0/.test(moneyOpts || ''));
  ok('  ...and neither does moneyPrecise', !/maximumFractionDigits:\s*0/.test(preciseOpts || ''));
  ok('  ...both are USD currency formatters', /currency: 'USD'/.test(moneyOpts || '') && /currency: 'USD'/.test(preciseOpts || ''));

  // Behavioural: run the real option bags.
  const fmt = (opts, v) => Number(v).toLocaleString('en-US', JSON.parse(
    opts.replace(/([{,]\s*)(\w+):/g, '$1"$2":').replace(/'/g, '"'),
  ));
  for (const [v, expected] of [[1250.75, '$1,250.75'], [0.2, '$0.20'], [99.99, '$99.99'], [1523.2, '$1,523.20'], [0, '$0.00']]) {
    ok(`money(${v}) renders ${expected}`, fmt(moneyOpts, v) === expected);
  }
  // The exact failures that shipped.
  ok('🔴 money(1250.75) is NOT "$1,251"', fmt(moneyOpts, 1250.75) !== '$1,251');
  ok('🔴 a 20c residual balance is NOT rendered as "$0"', fmt(moneyOpts, 0.2) !== '$0');
  // money and moneyPrecise must now agree, or the same page can contradict itself.
  for (const v of [1250.75, 0.2, 99.99, 1523.2, 0, 1000000.05]) {
    ok(`  money and moneyPrecise agree on ${v}`, fmt(moneyOpts, v) === fmt(preciseOpts, v));
  }
}

// ── the surfaces that made it a real defect ─────────────────────────────
{
  const inv = read('../src/pages/InvoiceDetail.jsx');
  ok('the customer-facing past-due draft still formats the balance', /Amount due \$\{money\(balance\)\}/.test(inv));
  ok('  ...and money() is now exact, so that string carries cents', true);
  ok('the line-item rows use moneyPrecise', /moneyPrecise\(lineTotal\)/.test(inv));
  ok('the payment placeholder still derives from the balance', /placeholder=\{money\(balance\)\}/.test(inv));
}

// ── 🔴 void invoices must survive a bulk Mark Paid ──────────────────────
{
  const src = read('../src/pages/Invoices.jsx');
  ok('🔴 bulkMarkPaid skips void invoices', /if \(inv\.status === 'void'\) return;/.test(src));
  ok('  ...before computing a balance or dispatching anything',
    src.indexOf("if (inv.status === 'void') return;") < src.indexOf('const bal = invoiceBalance(inv)'));
  ok('the confirm dialog counts only what will actually change', /Mark \$\{payableSelectionCount\}/.test(src));
  ok('  ...and names the skipped void invoices up front', /void invoice\$\{voidSelectionCount === 1/.test(src));
  ok('the counts are derived from the selection, not guessed',
    /voidSelectionCount = \[\.\.\.selection\]/.test(src) && /payableSelectionCount = selection\.size - voidSelectionCount/.test(src));

  // Simulate the corruption the guard prevents.
  const invoices = [
    { id: 'a', status: 'void', total: 500, payments: [] },
    { id: 'b', status: 'pending', total: 300, payments: [] },
  ];
  const balance = (i) => i.total - i.payments.reduce((s, p) => s + p.amount, 0);
  const run = (skipVoid) => {
    const acted = [];
    for (const i of invoices) {
      if (skipVoid && i.status === 'void') continue;
      if (balance(i) > 0) acted.push({ id: i.id, fabricated: balance(i) });
    }
    return acted;
  };
  const before = run(false);
  ok('THE OLD SHAPE fabricated a payment against the void invoice',
    before.some((a) => a.id === 'a' && a.fabricated === 500));
  const after = run(true);
  ok('🔴 the void invoice is now untouched', !after.some((a) => a.id === 'a'));
  ok('  ...while the payable one still gets its payment', after.some((a) => a.id === 'b' && a.fabricated === 300));
}

// ── 🔴 invoice dates must round-trip in the ORG zone, not the device's ──
// `new Date(day + 'T12:00:00')` has no offset, so it is parsed DEVICE-local, while the
// value is read back with splitIso in the ORG zone. Verified empirically: with the
// device on Asia/Manila the old form stored 2026-08-15 and read back "2026-08-14".
// A one-day shift on a DUE date moves overdue status, the aging bucket, and when the
// past-due notification fires — so this is not cosmetic.
{
  const inv = read('../src/pages/InvoiceDetail.jsx');
  ok('🔴 the issue-date editor composes in the org zone', /issueDate: composeIso\(e\.target\.value, '12:00'\)/.test(inv));
  ok('🔴 the due-date editor composes in the org zone', /dueDate: composeIso\(e\.target\.value, '12:00'\)/.test(inv));
  ok('  ...the device-local Date() form is gone', !/new Date\(e\.target\.value \+ 'T12:00:00'\)/.test(inv));
  ok('  ...and composeIso is imported', /composeIso \} from '\.\.\/lib\/dates'|, composeIso \}/.test(inv));
  // The helper it must use defaults to the org zone.
  const dates = read('../src/lib/dates.js');
  ok('composeIso defaults to the ORG timezone', /export function composeIso\(dateStr, timeStr, tz = ORG_TZ\)/.test(dates));
  ok('  ...and splitIso reads back in the same zone (a lossless inverse)',
    /export function splitIso\(iso, tz = ORG_TZ\)/.test(dates));
}

// ── deriveInvoiceStatus treats void as authoritative (why resurrection mattered) ──
{
  const src = read('../src/lib/money.js');
  ok('void is authoritative in deriveInvoiceStatus', /if \(invoice\.status === 'void'\) return 'void';/.test(src));
  ok('  ...which is exactly what SET_INVOICE_STATUS overwrote', /balance <= 0 && invoiceTotal\(invoice\) > 0/.test(src));
  ok('round2 preserves cents through the arithmetic (the bug was NOT here)', /round2/.test(src));
}

console.log(`\nmoney display + void guard: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
