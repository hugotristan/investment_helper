import { normalizeTransaction, portfolioToday, validatePortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { ApiError } from "./request-body.mjs";

export function purchaseInput(input, now) {
  const fail = message => { throw new ApiError(400, "INVALID_PURCHASE", message); };
  if (typeof input.executed_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.executed_at)) fail("Supply executed_at as an ISO timestamp with an explicit time zone.");
  const day = input.executed_at.slice(0, 10), time = Date.parse(input.executed_at);
  if (!Number.isFinite(time) || new Date(day).toISOString().slice(0, 10) !== day || time > now) fail("Execution time must be a real past date/time.");
  if (typeof input.ticker !== "string" || !/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(input.ticker)) fail("Supply an exact uppercase stock or ETF ticker, including its exchange suffix when needed.");
  if (!["EUR", "USD", "GBP", "JPY", "CHF", "CAD", "AUD"].includes(input.currency)) fail("Supply a supported execution currency.");
  for (const key of ["quantity", "price_per_share", "total_native_cost", "eur_cost_basis"]) if (typeof input[key] !== "number" || !Number.isFinite(input[key]) || input[key] <= 0 || input[key] > 1e9) fail("Quantity, price and cost amounts must be finite positive numbers up to one billion.");
  if (typeof input.fees !== "number" || !Number.isFinite(input.fees) || input.fees < 0 || input.fees > 1e9) fail("Fees must be a finite nonnegative amount in the execution currency.");
  if (!["deduct", "already_recorded"].includes(input.cash_treatment)) fail("Explicitly choose cash_treatment: deduct or already_recorded. Never guess whether cash was already deducted.");
  const cents = input.eur_cost_basis * 100;
  if (Math.abs(cents - Math.round(cents)) > 0.00001) fail("Exact EUR cost basis must use euro-cent precision and include all fees.");
  const factor = input.currency === "JPY" ? 1 : 100;
  if (Math.abs(input.total_native_cost * factor - Math.round(input.total_native_cost * factor)) > 0.00001
    || Math.abs(input.total_native_cost - (input.quantity * input.price_per_share + input.fees)) > 0.5 / factor + 1e-8) fail("Total native cost must reconcile to quantity × price plus fees, allowing only minor-unit rounding.");
  if (input.currency === "EUR" && Math.abs(input.total_native_cost - input.eur_cost_basis) > 1e-8) fail("A EUR purchase must have matching native total and EUR cost basis.");
  return { kind: "purchase", ticker: input.ticker, quantity: input.quantity, executedAt: new Date(time).toISOString(),
    currency: input.currency, price: input.price_per_share, fees: input.fees, totalNativeCost: input.total_native_cost,
    eurCostBasis: Math.round(cents) / 100, cashTreatment: input.cash_treatment };
}

export function purchaseEntry(request, id) {
  return { id, type: "buy", date: portfolioToday(Date.parse(request.executedAt)), executedAt: request.executedAt,
    ticker: request.ticker, currency: request.currency, quantity: request.quantity, price: request.price, fee: request.fees,
    totalCost: request.totalNativeCost, cashCurrency: "EUR", cashAmount: request.eurCostBasis,
    cashAlreadyRecorded: request.cashTreatment === "already_recorded",
    note: request.cashTreatment === "already_recorded" ? "MCP historical purchase: cash already recorded; no additional cash deduction." : "MCP purchase: exact EUR cost deducted once." };
}

export function validatePurchaseForBook(request, book, now) {
  if (book.settings.baseCurrency !== "EUR") throw new ApiError(409, "EUR_REPORTING_REQUIRED", "This purchase tool requires a EUR-reporting portfolio to preserve the exact EUR cost basis.");
  const normalized = normalizeTransaction(purchaseEntry(request, "purchase-preview"), { startDate: book.settings.startDate, baseCurrency: "EUR", now });
  if (!normalized.ok) throw new ApiError(400, "INVALID_PURCHASE", normalized.error);
  if (book.transactions.some(entry => entry.type === "buy" && entry.executedAt === request.executedAt && entry.ticker === request.ticker
    && entry.currency === request.currency && entry.quantity === request.quantity && entry.price === request.price && entry.fee === request.fees
    && entry.cashAmount === request.eurCostBasis)) throw new ApiError(409, "DUPLICATE_PURCHASE", "An identical timed purchase already exists. Review it before recording another entry; do not use a new key to bypass this check.");
  const result = validatePortfolioBook({ ...book, transactions: [...book.transactions, normalized.transaction] }, { now });
  if (!result.ok) throw new ApiError(409, "PURCHASE_HISTORY_CONFLICT", result.error);
  return normalized.transaction;
}
