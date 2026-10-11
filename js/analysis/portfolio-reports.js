import { validatePortfolioBook } from "./portfolio-ledger.js";

export const TRANSACTION_LABELS = { buy: "Buy", sell: "Sell", deposit: "Deposit", withdrawal: "Withdrawal", dividend: "Dividend", fee: "Fee", opening_cash: "Starting cash" };
const negative = new Set(["buy", "withdrawal", "fee"]);
const finite = (number) => Number.isFinite(number) ? number : null;
const dateValid = (value) => { const date = new Date(`${value}T00:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; };
export function transactionCash(entry) {
  const sign = negative.has(entry.type) ? -1 : 1;
  const native = entry.amount + (entry.type === "buy" ? entry.fee || 0 : entry.type === "sell" ? -(entry.fee || 0) : 0);
  const currency = entry.cashCurrency || entry.currency;
  const amount = finite(sign * (entry.cashAmount ?? native));
  return { currency, amount, eurAmount: currency === "EUR" ? amount : null };
}
export function transactionReport(book, { from = "", to = "", type = "", search = "", now = Date.now() } = {}) {
  const validated = validatePortfolioBook(book, { now });
  if (!validated.ok) return { rows: [], error: validated.error };
  if (from && !dateValid(from) || to && !dateValid(to) || from && to && from > to) return { rows: [], error: "Choose a valid date range; From must be on or before To." };
  const term = String(search).trim().toLocaleLowerCase();
  const rows = validated.book.transactions.map((entry, index) => ({ ...entry, order: index, cash: transactionCash(entry) }))
    .filter((entry) => (!from || entry.date >= from) && (!to || entry.date <= to) && (!type || entry.type === type)
      && (!term || `${entry.ticker || ""} ${entry.note || ""} ${entry.currency} ${TRANSACTION_LABELS[entry.type]}`.toLocaleLowerCase().includes(term)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.order - a.order);
  return { rows, error: null };
}
export function fundingReport(book, filters = {}) {
  const result = transactionReport(book, filters);
  const rows = result.rows.filter((row) => ["deposit", "withdrawal", "opening_cash"].includes(row.type));
  const sum = (entries) => entries.every((row) => row.cash.eurAmount !== null) ? finite(entries.reduce((total, row) => total + Math.abs(row.cash.eurAmount), 0)) : null;
  const total = (type) => sum(rows.filter((row) => row.type === type));
  const deposits = total("deposit"), withdrawals = total("withdrawal"), openingCash = total("opening_cash");
  const months = [...new Set(rows.map((row) => row.date.slice(0, 7)))].sort().map((month) => {
    const entries = rows.filter((row) => row.date.startsWith(month));
    const deposits = sum(entries.filter((row) => row.type === "deposit"));
    const withdrawals = sum(entries.filter((row) => row.type === "withdrawal"));
    return { month, deposits, withdrawals, net: deposits === null || withdrawals === null ? null : finite(deposits - withdrawals), openingCash: sum(entries.filter((row) => row.type === "opening_cash")) };
  });
  return { rows, months, deposits, withdrawals, openingCash,
    net: deposits === null || withdrawals === null ? null : finite(deposits - withdrawals), missing: rows.filter((row) => row.cash.eurAmount === null).length, error: result.error };
}
