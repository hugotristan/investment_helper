import { normalizeExchangeRate } from "../data/exchange-rate.js";

const FUNDING_TYPES = new Set(["opening_cash", "deposit", "withdrawal"]);
const CASH_ROUNDOFF_TOLERANCE = 1e-7;

export function calculatePortfolioTotals({ holdings, book, projection, exchangeRate, now = Date.now() } = {}) {
  const reasons = new Set();
  const rate = normalizeExchangeRate(exchangeRate, { now });
  const convertCurrent = (amount, currency) => {
    if (currency === "EUR") return amount;
    if (currency !== "USD") {
      reasons.add(`Current ${currency || "unknown-currency"} values cannot be converted to EUR.`);
      return null;
    }
    if (!rate) { reasons.add("A recent USD-to-EUR reference rate is unavailable."); return null; }
    const converted = amount * rate.rate;
    if (!Number.isFinite(converted)) { reasons.add("The EUR value exceeds the supported number range."); return null; }
    return converted;
  };

  let contributionComplete = Boolean(book && book.schemaVersion === 1 && book.id === "personal"
    && Array.isArray(book.transactions) && Array.isArray(book.openingHoldings));
  let contributed = 0;
  if (!contributionComplete) reasons.add("Recorded funding history is unavailable.");
  else {
    if (book.openingHoldings.length) {
      contributionComplete = false;
      reasons.add("Funding for opening holdings is not recorded.");
    }
    for (const entry of book.transactions) {
      if (!entry || !FUNDING_TYPES.has(entry.type)) continue;
      const hasCurrency = Object.hasOwn(entry, "cashCurrency");
      const hasAmount = Object.hasOwn(entry, "cashAmount");
      const currency = hasCurrency ? entry.cashCurrency : entry.currency;
      const amount = hasAmount ? entry.cashAmount : entry.amount;
      if (hasCurrency !== hasAmount || !Number.isFinite(amount) || amount < 0) {
        contributionComplete = false;
        reasons.add("A recorded funding amount is incomplete or invalid.");
        continue;
      }
      if (currency !== "EUR") {
        contributionComplete = false;
        reasons.add("Historical funding needs its actual EUR cash amount.");
        continue;
      }
      contributed += entry.type === "withdrawal" ? -amount : amount;
      if (!Number.isFinite(contributed)) {
        contributionComplete = false;
        reasons.add("Recorded funding exceeds the supported number range.");
      }
    }
  }
  if (!contributionComplete) contributed = null;

  let holdingsValue = 0;
  let holdingsComplete = Array.isArray(holdings);
  if (!holdingsComplete) reasons.add("Current holding values are unavailable.");
  else {
    for (const holding of holdings) {
      if (holding?.kind === "manual" || holding?.source === "manual") {
        holdingsComplete = false;
        reasons.add("Legacy amount-only holdings need shares and a current valuation.");
        continue;
      }
      if (!Number.isFinite(holding?.currentValue) || holding.currentValue < 0 || holding.source === "unavailable"
        || /^sample\b/i.test(String(holding.source || ""))) {
        holdingsComplete = false;
        const ticker = typeof holding?.ticker === "string" && holding.ticker.length <= 20 ? holding.ticker : "a holding";
        reasons.add(`A current price is unavailable for ${ticker}.`);
        continue;
      }
      const converted = convertCurrent(holding.currentValue, holding.currency);
      if (converted === null) holdingsComplete = false;
      else {
        holdingsValue += converted;
        if (!Number.isFinite(holdingsValue)) { holdingsComplete = false; reasons.add("The EUR value exceeds the supported number range."); }
      }
    }
  }
  if (!holdingsComplete) holdingsValue = null;

  const cash = projection?.reportingCash;
  let cashValue = null;
  let negativeCash = false;
  if (!cash || cash.complete !== true || !Number.isFinite(cash.amount)
    || Array.isArray(cash.missingTransactionIds) && cash.missingTransactionIds.length > 0) {
    reasons.add("Recorded cash is unavailable or needs actual converted amounts.");
  } else {
    // Summarize floating-point cent arithmetic as zero without changing the ledger.
    const cashAmount = Math.abs(cash.amount) <= CASH_ROUNDOFF_TOLERANCE ? 0 : cash.amount;
    cashValue = convertCurrent(cashAmount, cash.currency);
    negativeCash = cashAmount < 0;
    if (negativeCash) reasons.add("Recorded cash is negative. Add missing funding transactions.");
  }
  let valueComplete = holdingsComplete && cashValue !== null && !negativeCash;
  let totalValue = valueComplete ? holdingsValue + cashValue : null;
  if (totalValue !== null && !Number.isFinite(totalValue)) {
    valueComplete = false;
    totalValue = null;
    reasons.add("The EUR value exceeds the supported number range.");
  }
  return { contributed, totalValue, holdingsValue, cashValue, contributionComplete, valueComplete, reasons: [...reasons] };
}
