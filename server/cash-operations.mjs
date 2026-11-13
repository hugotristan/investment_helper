import { readCloudRecord, validateCloudBook } from "./cloud-store.mjs";
import { normalizeTransaction, portfolioToday, projectPortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { ApiError } from "./request-body.mjs";
import { purchaseInput, purchaseEntry, validatePurchaseForBook } from "./stock-purchase.mjs";

const currencies = ["EUR", "USD", "GBP", "JPY", "CHF", "CAD", "AUD"];
const id = () => crypto.randomUUID().replaceAll("-", "");
const fail = (status, code, message) => { throw new ApiError(status, code, message); };
export function cashAmount(value, currency) {
  const factor = currency === "JPY" ? 1 : 100;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1e9 || Math.abs(value * factor - Math.round(value * factor)) > 0.00001) {
    fail(400, "INVALID_AMOUNT", "Enter a positive amount up to one billion, using the currency's minor-unit precision.");
  }
  return Math.round(value * factor) / factor;
}
function key(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) fail(400, "INVALID_IDEMPOTENCY_KEY", "Supply a unique idempotency_key of 8–80 letters, numbers, underscores or hyphens. Reuse it only for retries of this same request.");
  return value;
}
function operationId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) fail(400, "INVALID_OPERATION", "Supply the operation_id returned by the deposit tool.");
  return value;
}
async function operation(env, userId, operationIdValue) {
  const row = await env.DB.prepare("SELECT * FROM cash_operations WHERE user_id = ? AND id = ?").bind(userId, operationId(operationIdValue)).first();
  if (!row) fail(404, "OPERATION_NOT_FOUND", "This cash operation is not available in your workspace.");
  return row;
}
function receipt(row, origin, now) {
  const status = row.status === "pending" && row.expires_at <= now ? "expired" : row.status;
  return { status: status === "pending" ? "confirmation_required" : status, operationId: row.id, proposal: JSON.parse(row.request),
    confirmationUrl: status === "pending" ? `${origin}/cash-operations/${row.id}` : null,
    expiresAt: new Date(row.expires_at).toISOString(), createdAt: row.created_at, confirmedAt: row.confirmed_at,
    result: row.result ? JSON.parse(row.result) : null,
    message: status === "pending" ? "No cash transaction has been recorded. The user must open confirmationUrl, sign in if needed, review the exact proposal and click Confirm. Never confirm on the user's behalf."
      : status === "confirmed" ? "This bookkeeping operation was recorded. Retrying this idempotency key does not create another transaction."
        : "No new transaction can be recorded from this proposal. Prepare a new request with a new idempotency key if needed." };
}
export async function prepareCashOperation(env, userId, actor, input, { reverse = false, purchase = false, origin, now = Date.now() }) {
  const idempotencyKey = key(input.idempotency_key);
  if (!reverse && (Object.hasOwn(input, "date") && typeof input.date !== "string" || Object.hasOwn(input, "currency") && typeof input.currency !== "string")) fail(400, "INVALID_DEPOSIT", "Date and currency must be strings when supplied.");
  const currency = input.currency ?? "EUR";
  if (!currencies.includes(currency)) fail(400, "INVALID_CURRENCY", "Choose EUR, USD, GBP, JPY, CHF, CAD or AUD.");
  const request = purchase ? purchaseInput(input, now) : reverse ? { kind: "reversal", operationId: operationId(input.operation_id) }
    : { kind: "deposit", amount: cashAmount(input.amount, currency), currency, requestedDate: input.date ?? null };
  const previous = await env.DB.prepare("SELECT * FROM cash_operations WHERE user_id = ? AND idempotency_key = ?").bind(userId, idempotencyKey).first();
  if (previous) {
    if (JSON.stringify(JSON.parse(previous.request).input) !== JSON.stringify(request)) fail(409, "IDEMPOTENCY_CONFLICT", "This idempotency key belongs to a different request. No additional transaction was recorded.");
    return receipt(previous, origin, now);
  }
  const record = await readCloudRecord(env, userId, "portfolio", now);
  if (!record.book) fail(409, "NO_PORTFOLIO", "Start portfolio tracking before recording cash deposits.");
  let amount = request.amount, date = request.requestedDate ?? portfolioToday(now), nativeCurrency = currency, reversesId = null, settlement = null;
  let purchasePreview;
  if (purchase) {
    const entry = validatePurchaseForBook(request, record.book, now);
    amount = request.totalNativeCost; nativeCurrency = request.currency; date = entry.date; settlement = request.eurCostBasis;
    const before = projectPortfolioBook(record.book), after = projectPortfolioBook({ ...record.book, transactions: [...record.book.transactions, entry] });
    const current = before.holdings.find(h => h.ticker === request.ticker && h.currency === request.currency);
    const updated = after.holdings.find(h => h.ticker === request.ticker && h.currency === request.currency);
    purchasePreview = { sharesBefore: current?.shares ?? 0, sharesAfter: updated?.shares ?? 0, averageCostAfter: updated?.averageCost ?? null,
      eurCostBasisAfter: after.eurCostBases.find(h => h.ticker === request.ticker && h.currency === request.currency)?.costBasis ?? null,
      cashMovement: request.cashTreatment === "already_recorded" ? 0 : -request.eurCostBasis, recordedCashAfter: after.reportingCash.amount };
  }
  if (reverse) {
    const original = await operation(env, userId, request.operationId);
    const proposal = JSON.parse(original.request);
    if (original.status !== "confirmed" || proposal.input.kind !== "deposit") fail(409, "NOT_REVERSIBLE", "Only a confirmed deposit created by this tool can be reversed.");
    if (await env.DB.prepare("SELECT id FROM cash_operations WHERE user_id = ? AND reverses_id = ? AND status = 'confirmed'").bind(userId, original.id).first()) fail(409, "ALREADY_REVERSED", "This deposit already has a confirmed reversal.");
    const result = JSON.parse(original.result);
    const entry = record.book.transactions.find(entry => entry.id === result.transactionId);
    if (!entry || entry.type !== "deposit" || entry.currency !== proposal.currency || entry.amount !== proposal.amount
      || entry.cashAmount !== result.cashAmount || entry.cashCurrency !== result.baseCurrency || entry.date !== proposal.date) {
      fail(409, "TRANSACTION_CHANGED", "The original deposit was changed or removed outside MCP. Review the portfolio manually before correcting it.");
    }
    amount = proposal.amount; nativeCurrency = proposal.currency; date = proposal.date; reversesId = original.id; settlement = result.cashAmount;
  }
  const check = normalizeTransaction({ id: "cash-preview", type: reverse ? "withdrawal" : "deposit", date, currency: nativeCurrency, amount },
    { startDate: record.book.settings.startDate, baseCurrency: record.book.settings.baseCurrency, now });
  if (!check.ok) fail(400, "INVALID_DEPOSIT", check.error);
  const operationIdValue = id(), createdAt = new Date(now).toISOString();
  const proposal = { input: request, amount, currency: nativeCurrency, date, baseCurrency: record.book.settings.baseCurrency, settlement,
    ...(purchase ? { purchasePreview } : {}) };
  const payload = JSON.stringify(proposal);
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO cash_operations (id, user_id, actor, idempotency_key, request, status, expected_revision, csrf, created_at, expires_at, reverses_id) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?) ON CONFLICT(user_id, idempotency_key) DO NOTHING")
        .bind(operationIdValue, userId, actor, idempotencyKey, payload, record.revision, id() + id(), createdAt, now + 15 * 60000, reversesId),
      env.DB.prepare("INSERT INTO cash_audit (id, user_id, operation_id, event, actor, occurred_at) SELECT ?, ?, ?, 'prepared', ?, ? WHERE changes() = 1")
        .bind(`${operationIdValue}:prepared`, userId, operationIdValue, actor, createdAt),
    ]);
  } catch { fail(503, "CASH_OPERATION_UNAVAILABLE", "The proposal could not be confirmed. Retry with the same idempotency key."); }
  const saved = await env.DB.prepare("SELECT * FROM cash_operations WHERE user_id = ? AND idempotency_key = ?").bind(userId, idempotencyKey).first();
  if (!saved || JSON.stringify(JSON.parse(saved.request).input) !== JSON.stringify(request)) fail(409, "IDEMPOTENCY_CONFLICT", "Another request used this idempotency key. Review its receipt before retrying.");
  return receipt(saved, origin, now);
}

export async function cashOperationStatus(env, userId, operationIdValue, origin, now = Date.now()) {
  const row = await operation(env, userId, operationIdValue);
  const audit = await env.DB.prepare("SELECT event, actor, occurred_at FROM cash_audit WHERE user_id = ? AND operation_id = ? ORDER BY occurred_at, CASE WHEN event = 'prepared' THEN 0 ELSE 1 END, id").bind(userId, row.id).all();
  return { ...receipt(row, origin, now), audit: audit.results };
}

export async function confirmCashOperation(env, userId, operationIdValue, csrf, { cancel = false, settledAmount, purchaseAcknowledged = false, now = Date.now() } = {}) {
  const row = await operation(env, userId, operationIdValue);
  if (typeof csrf !== "string" || csrf !== row.csrf) fail(403, "INVALID_CONFIRMATION", "Open the authenticated confirmation page before submitting.");
  if (row.status === "confirmed") return { status: "confirmed", duplicate: true };
  if (row.status !== "pending" || row.expires_at <= now) fail(409, "CONFIRMATION_EXPIRED", "This proposal expired or was cancelled. Prepare a new request and review it again.");
  const timestamp = new Date(now).toISOString();
  if (cancel) {
    await env.DB.batch([
      env.DB.prepare("UPDATE cash_operations SET status = 'cancelled' WHERE user_id = ? AND id = ? AND status = 'pending'").bind(userId, row.id),
      env.DB.prepare("INSERT INTO cash_audit (id, user_id, operation_id, event, actor, occurred_at) SELECT ?, ?, ?, 'cancelled', 'password-confirmation', ? WHERE changes() = 1").bind(`${row.id}:cancelled`, userId, row.id, timestamp),
    ]);
    return { status: "cancelled" };
  }
  const proposal = JSON.parse(row.request);
  const record = await readCloudRecord(env, userId, "portfolio", now);
  if (!record.book || record.revision !== row.expected_revision) fail(409, "PORTFOLIO_CHANGED", "The portfolio changed after this proposal was prepared. No cash was added. Prepare a new request with a new idempotency key and review it again.");
  const isReversal = proposal.input.kind === "reversal";
  const isPurchase = proposal.input.kind === "purchase";
  if (isPurchase && purchaseAcknowledged !== true) fail(400, "PURCHASE_REVIEW_REQUIRED", "Review the cash treatment and confirm the purchase is not already included in your holdings/history.");
  if (isPurchase) validatePurchaseForBook(proposal.input, record.book, now);
  if (proposal.baseCurrency !== record.book.settings.baseCurrency) fail(409, "PORTFOLIO_CHANGED", "The reporting currency changed. Prepare a new proposal.");
  const cash = proposal.settlement ?? (proposal.currency === proposal.baseCurrency ? proposal.amount : cashAmount(settledAmount, proposal.baseCurrency));
  const entry = isPurchase ? purchaseEntry(proposal.input, `mcp-purchase-${row.id}`) : { id: `mcp-cash-${row.id}`, type: isReversal ? "withdrawal" : "deposit", date: proposal.date, currency: proposal.currency,
    amount: proposal.amount, cashCurrency: proposal.baseCurrency, cashAmount: cash,
    note: isReversal ? `Reversal of MCP deposit operation ${row.reverses_id}` : `MCP deposit operation ${row.id}` };
  const book = validateCloudBook({ ...record.book, transactions: [...record.book.transactions, entry], updatedAt: timestamp }, now);
  const serialized = JSON.stringify(book);
  if (new TextEncoder().encode(serialized).length > 1024 * 1024) fail(413, "BOOK_TOO_LARGE", "The portfolio exceeds the supported record size. No deposit was recorded.");
  const result = { transactionId: entry.id, portfolioRevision: record.revision + 1, baseCurrency: proposal.baseCurrency, cashAmount: cash,
    recordedCash: projectPortfolioBook(book).reportingCash.amount,
    ...(isPurchase ? { cashMovement: proposal.purchasePreview.cashMovement, purchase: proposal.input } : {}) };
  let changed;
  try {
    changed = await env.DB.batch([
      env.DB.prepare("UPDATE portfolio_books SET book = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ? AND EXISTS (SELECT 1 FROM cash_operations WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at > ?) AND NOT EXISTS (SELECT 1 FROM cash_operations WHERE reverses_id = ? AND status = 'confirmed')")
        .bind(serialized, timestamp, userId, record.revision, row.id, userId, now, row.reverses_id),
      env.DB.prepare("UPDATE cash_operations SET status = 'confirmed', confirmed_at = ?, result = ? WHERE id = ? AND user_id = ? AND status = 'pending' AND changes() = 1")
        .bind(timestamp, JSON.stringify(result), row.id, userId),
      env.DB.prepare("INSERT INTO cash_audit (id, user_id, operation_id, event, actor, occurred_at) SELECT ?, ?, ?, 'confirmed', 'password-confirmation', ? WHERE changes() = 1")
        .bind(`${row.id}:confirmed`, userId, row.id, timestamp),
    ]);
  } catch { fail(503, "CASH_WRITE_UNCONFIRMED", "The cash write was not confirmed. Check the operation receipt before retrying; do not use a new key yet."); }
  if (changed[0].meta.changes !== 1) {
    const current = await operation(env, userId, row.id);
    if (current.status === "confirmed") return { status: "confirmed", duplicate: true };
    fail(409, "PORTFOLIO_CHANGED", "The portfolio or reversal status changed. Nothing was added; prepare a new proposal.");
  }
  return { status: "confirmed", result };
}

export async function cashConfirmationView(env, userId, operationIdValue, now = Date.now()) {
  const row = await operation(env, userId, operationIdValue);
  return { ...receipt(row, "", now), csrf: row.csrf };
}
