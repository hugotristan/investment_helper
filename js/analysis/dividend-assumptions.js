import { isBlockedAssetTicker } from "../shared/symbols.js";
import { VWCE_TICKERS } from "../data/vanguard-holdings.js";

export const DIVIDEND_INTERVALS = Object.freeze({ once: 0, monthly: 1, quarterly: 3, semiannual: 6, annual: 12, none: null });
export const dividendPositionKey = ({ ticker, currency }) => `${ticker}|${currency}`;
export const isAccumulatingFund = ticker => VWCE_TICKERS.includes(ticker);
const currencies = new Set(["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD"]);
const keys = new Set(["ticker", "currency", "amountPerShare", "firstPaymentDate", "frequency"]);

export function normalizeDividendAssumptions(input) {
  if (!Array.isArray(input) || input.length > 500) throw new TypeError("Use at most 500 dividend assumptions.");
  const identities = new Set();
  return input.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || ![Object.prototype, null].includes(Object.getPrototypeOf(entry))
      || Object.keys(entry).some(key => !keys.has(key)) || keys.size !== Object.keys(entry).length
      || typeof entry.ticker !== "string" || !/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(entry.ticker) || isBlockedAssetTicker(entry.ticker)
      || !currencies.has(entry.currency) || !Object.hasOwn(DIVIDEND_INTERVALS, entry.frequency)
      || !Number.isFinite(entry.amountPerShare) || entry.amountPerShare < 0 || entry.amountPerShare > 1000000) {
      throw new TypeError("Choose a valid position, dividend per share and payment interval.");
    }
    const key = dividendPositionKey(entry);
    if (identities.has(key)) throw new TypeError("Each position can have only one dividend assumption.");
    identities.add(key);
    if (entry.frequency === "none") {
      if (entry.amountPerShare !== 0 || entry.firstPaymentDate !== null) throw new TypeError("No cash dividend needs a zero amount and no payment date.");
    } else {
      const date = entry.firstPaymentDate;
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))
        || new Date(date).toISOString().slice(0, 10) !== date || date < "1900-01-01" || date > "2199-12-31") {
        throw new TypeError("Enter a valid expected payment date.");
      }
      if (isAccumulatingFund(entry.ticker)) throw new TypeError("This accumulating ETF reinvests dividends; it has no cash-dividend schedule.");
    }
    return { ticker: entry.ticker, currency: entry.currency, amountPerShare: entry.amountPerShare,
      firstPaymentDate: entry.firstPaymentDate, frequency: entry.frequency };
  });
}

// Anchor every recurrence to the original day. Jan 31 -> Feb 28 -> Mar 31.
export function dividendDateAfterMonths(date, months) {
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

export function nextDividendDate(plan, from) {
  if (plan.frequency === "none") return null;
  const interval = DIVIDEND_INTERVALS[plan.frequency];
  if (!interval) return plan.firstPaymentDate >= from ? plan.firstPaymentDate : null;
  const month = date => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
  let index = Math.max(0, Math.floor((month(from) - month(plan.firstPaymentDate)) / interval));
  let date = dividendDateAfterMonths(plan.firstPaymentDate, index * interval);
  if (date < from) date = dividendDateAfterMonths(plan.firstPaymentDate, ++index * interval);
  return date;
}
