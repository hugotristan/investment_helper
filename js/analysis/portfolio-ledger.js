import { isBlockedAssetTicker } from "../shared/symbols.js";

const CURRENCIES = new Set(["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD"]);
const TYPES = new Set(["buy", "sell", "deposit", "withdrawal", "dividend", "fee", "opening_cash"]);
const BOOK_KEYS = ["schemaVersion", "id", "settings", "openingHoldings", "transactions", "createdAt", "updatedAt", "legacyPortfolioInput"];
const TRANSACTION_KEYS = ["id", "type", "date", "currency", "ticker", "quantity", "price", "amount", "fee", "note"];
const tallinnDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Tallinn", year: "numeric", month: "2-digit", day: "2-digit" });

export function portfolioToday(now = Date.now()) {
  if (typeof now === "string" && /^\d{4}-\d{2}-\d{2}$/.test(now)) return calendarDate(now, "Current date");
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Current time is invalid.");
  const parts = Object.fromEntries(tallinnDate.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function createPortfolioBook({ holdings = [], legacyPortfolioInput = "", baseCurrency = "EUR", startDate, now = Date.now() } = {}) {
  if (!Array.isArray(holdings) || holdings.length > 500) throw new TypeError("Opening holdings must contain at most 500 positions.");
  const timestamp = instant(now, "Current time");
  const book = {
    schemaVersion: 1, id: "personal",
    settings: { baseCurrency: currencyCode(baseCurrency), startDate: startDate ?? portfolioToday(now) },
    openingHoldings: holdings.map((holding, index) => normalizeOpening(holding, false, `opening:${index}`)),
    transactions: [], createdAt: timestamp, updatedAt: timestamp, legacyPortfolioInput
  };
  const validated = validatePortfolioBook(book, { now });
  if (!validated.ok) throw new TypeError(validated.error);
  return validated.book;
}

export function normalizeTransaction(input, { startDate, now = Date.now() } = {}) {
  try {
    const firstDate = calendarDate(startDate, "Portfolio start date");
    return { ok: true, transaction: transaction(input, firstDate, portfolioToday(now), false), error: null };
  } catch (error) {
    return { ok: false, transaction: null, error: error.message };
  }
}

export function validatePortfolioBook(input, { now = Date.now() } = {}) {
  try {
    const book = normalizeBook(input, now);
    projectNormalized(book);
    return { ok: true, book, error: null };
  } catch (error) {
    return { ok: false, book: null, error: error.message };
  }
}

// Projection is independent of the clock; reads/restores use validatePortfolioBook first.
export function projectPortfolioBook(input) {
  return projectNormalized(normalizeBook(input));
}

function normalizeBook(input, now) {
  allowedKeys(input, BOOK_KEYS, "Portfolio book");
  if (input.schemaVersion !== 1 || input.id !== "personal") throw new TypeError("This is not a supported personal portfolio book.");
  allowedKeys(input.settings, ["baseCurrency", "startDate"], "Portfolio settings");
  const baseCurrency = currencyCode(input.settings.baseCurrency, true);
  const startDate = calendarDate(input.settings.startDate, "Portfolio start date");
  const today = now === undefined ? null : portfolioToday(now);
  if (today && startDate > today) throw new TypeError("Portfolio start date cannot be in the future.");
  const createdAt = instant(input.createdAt, "Created time", true);
  const updatedAt = instant(input.updatedAt, "Updated time", true);
  if (Date.parse(createdAt) > Date.parse(updatedAt)) throw new TypeError("Updated time cannot precede created time.");
  if (today) {
    const dateOnly = typeof now === "string" && /^\d{4}-\d{2}-\d{2}$/.test(now);
    // A monotonic revision may advance a millisecond when consecutive saves share a clock tick.
    if (dateOnly ? portfolioToday(Date.parse(updatedAt) - 1000) > today : Date.parse(updatedAt) > new Date(now).getTime() + 1000) {
      throw new TypeError("Portfolio timestamps cannot be in the future.");
    }
  }
  if (!Array.isArray(input.openingHoldings) || input.openingHoldings.length > 500) throw new TypeError("Opening holdings must contain at most 500 positions.");
  if (!Array.isArray(input.transactions) || input.transactions.length > 10000) throw new TypeError("Transactions must contain at most 10,000 entries.");
  const legacyPortfolioInput = boundedText(input.legacyPortfolioInput, 1000000, "Legacy portfolio source");
  const openingHoldings = input.openingHoldings.map((holding) => normalizeOpening(holding, true));
  const transactions = input.transactions.map((entry) => transaction(entry, startDate, today, true));
  const ids = new Set();
  for (const entry of [...openingHoldings, ...transactions]) {
    if (ids.has(entry.id)) throw new TypeError("Portfolio entry IDs must be unique.");
    ids.add(entry.id);
  }
  const openingCurrencies = new Set();
  for (const entry of transactions.filter(({ type }) => type === "opening_cash")) {
    if (openingCurrencies.has(entry.currency)) throw new TypeError("Only one opening cash entry is allowed per currency.");
    openingCurrencies.add(entry.currency);
  }
  return { schemaVersion: 1, id: "personal", settings: { baseCurrency, startDate }, openingHoldings, transactions, createdAt, updatedAt, legacyPortfolioInput };
}

function normalizeOpening(input, strict, fallbackId) {
  if (!plainObject(input)) throw new TypeError("Opening holding must be an object.");
  const position = input.kind === "position";
  if (!position && input.kind !== "manual") throw new TypeError("Opening holding kind is unsupported.");
  allowedKeys(input, position ? ["id", "kind", "ticker", "label", "shares", "averageCost", "currency"] : ["id", "kind", "ticker", "label", "amount", "status", "currency"], "Opening holding");
  const ticker = tickerCode(input.ticker, strict);
  const label = input.label === undefined && !strict ? ticker : boundedText(input.label, 120, "Holding label");
  const id = entryId(input.id == null && !strict ? fallbackId : input.id);
  const currency = currencyCode(input.currency, strict);
  if (position) {
    const shares = number(input.shares, "Share quantity", strict, true);
    const averageCost = number(input.averageCost, "Average cost", strict);
    finite(shares * averageCost);
    return { id, kind: "position", ticker, label: label || ticker, shares, averageCost, currency };
  }
  const amount = number(input.amount, "Manual holding amount", strict);
  if (!["up", "down", "flat", "unknown"].includes(input.status)) throw new TypeError("Manual holding status is unsupported.");
  return { id, kind: "manual", ticker, label: label || ticker, amount, status: input.status, currency };
}

function transaction(input, startDate, today, strict) {
  allowedKeys(input, TRANSACTION_KEYS, "Transaction");
  const id = entryId(input.id);
  if (!TYPES.has(input.type)) throw new TypeError("Choose a supported transaction type.");
  const type = input.type;
  const date = calendarDate(input.date, "Transaction date");
  if (date < startDate) throw new TypeError("Transaction date cannot precede the portfolio start date.");
  if (today && date > today) throw new TypeError("Transaction date cannot be in the future.");
  const currency = currencyCode(input.currency, strict);
  const result = { id, type, date, currency };
  if (Object.hasOwn(input, "note")) result.note = boundedText(input.note, 500, "Transaction note");
  const isTrade = type === "buy" || type === "sell";
  const applicable = isTrade ? ["ticker", "quantity", "price", "amount", "fee"] : type === "dividend" ? ["ticker", "amount"] : ["amount"];
  for (const key of ["ticker", "quantity", "price", "amount", "fee"]) {
    if (!applicable.includes(key) && Object.hasOwn(input, key) && (strict || ![undefined, null, ""].includes(input[key]))) {
      throw new TypeError(`${key} does not apply to ${type} transactions.`);
    }
  }
  if (isTrade || type === "dividend") result.ticker = tickerCode(input.ticker, strict);
  if (isTrade) {
    result.quantity = number(input.quantity, "Share quantity", strict, true);
    result.price = number(input.price, "Trade price", strict);
    result.amount = finite(result.quantity * result.price);
    result.fee = input.fee === undefined ? 0 : number(input.fee, "Trade fee", strict);
    finite(result.amount + result.fee);
  } else {
    result.amount = number(input.amount, "Transaction amount", strict, type !== "opening_cash");
    if (type === "opening_cash" && date !== startDate) throw new TypeError("Opening cash must be dated on the portfolio start date.");
  }
  return result;
}

function projectNormalized(book) {
  const positions = new Map();
  const manual = [];
  const cash = new Map();
  const reservedIds = new Set(book.openingHoldings.map(({ id }) => id));
  for (const holding of book.openingHoldings) {
    if (holding.kind === "manual") { manual.push({ ...holding }); continue; }
    const key = `${holding.ticker}|${holding.currency}`;
    const previous = positions.get(key);
    if (!previous) { positions.set(key, { ...holding }); continue; }
    const shares = finite(previous.shares + holding.shares);
    const cost = finite(finite(previous.shares * previous.averageCost) + finite(holding.shares * holding.averageCost));
    previous.shares = shares;
    previous.averageCost = finite(cost / shares);
  }
  const entries = book.transactions.map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.date.localeCompare(b.entry.date) || a.index - b.index);
  for (const { entry } of entries) {
    const { type, currency, amount, fee = 0 } = entry;
    let change = amount;
    if (type === "buy" || type === "sell") {
      const key = `${entry.ticker}|${currency}`;
      let holding = positions.get(key);
      if (type === "buy") {
        if (!holding) {
          const id = `ledger:${entry.ticker}:${currency}`;
          if (reservedIds.has(id)) throw new TypeError("An opening holding ID conflicts with a generated ledger position ID.");
          reservedIds.add(id);
          holding = { id, kind: "position", ticker: entry.ticker, label: entry.ticker, shares: 0, averageCost: 0, currency };
          positions.set(key, holding);
        }
        const shares = finite(holding.shares + entry.quantity);
        const cost = finite(finite(holding.shares * holding.averageCost) + finite(amount + fee));
        holding.shares = shares;
        holding.averageCost = finite(cost / shares);
        change = -finite(amount + fee);
      } else {
        const tolerance = Number.EPSILON * 8 * Math.max(holding?.shares || 0, entry.quantity);
        if (!holding || entry.quantity - holding.shares > tolerance) throw new TypeError(`Cannot sell more ${entry.ticker} shares than are held in ${currency} on ${entry.date}.`);
        const remaining = holding.shares - entry.quantity;
        holding.shares = Math.abs(remaining) <= tolerance ? 0 : remaining;
        if (!holding.shares) holding.averageCost = 0;
        change = finite(amount - fee);
      }
    } else if (type === "withdrawal" || type === "fee") change = -amount;
    cash.set(currency, finite((cash.get(currency) || 0) + change));
  }
  const balances = [...cash].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, amount: Object.is(amount, -0) ? 0 : amount }));
  const warnings = balances.filter(({ amount }) => amount < 0).map(({ currency }) => `${currency} cash is negative. Funding history may be incomplete.`);
  if (manual.length) warnings.push("Amount-only legacy holdings do not provide share quantities or cost basis.");
  return { holdings: [...positions.values()].filter(({ shares }) => shares > 0).map((holding) => ({ ...holding })).concat(manual), cash: balances, warnings };
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function allowedKeys(value, keys, label) {
  if (!plainObject(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new TypeError(`${label} contains unsupported fields.`);
}
function boundedText(value, max, label) {
  if (typeof value !== "string" || value.length > max) throw new TypeError(`${label} must be text of at most ${max.toLocaleString("en-US")} characters.`);
  return value;
}
function entryId(value) {
  const id = boundedText(value, 120, "Entry ID");
  if (!id.trim() || /[\u0000-\u001f]/.test(id)) throw new TypeError("Entry ID must be nonempty text without control characters.");
  return id;
}
function tickerCode(value, strict = false) {
  if (typeof value !== "string") throw new TypeError("Enter a valid stock or ETF ticker.");
  const ticker = value.trim().toUpperCase();
  if ((strict && ticker !== value) || !/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(ticker) || isBlockedAssetTicker(ticker)) throw new TypeError("Enter a valid stock or ETF ticker.");
  return ticker;
}
function currencyCode(value, strict = false) {
  if (typeof value !== "string") throw new TypeError("Choose a supported currency.");
  const currency = value.trim().toUpperCase();
  if (!CURRENCIES.has(currency) || (strict && currency !== value)) throw new TypeError("Choose a supported currency.");
  return currency;
}
function number(value, label, strict, positive = false) {
  const parsed = typeof value === "number" ? value : !strict && typeof value === "string" && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isFinite(parsed) || (positive ? parsed <= 0 : parsed < 0)) throw new TypeError(`${label} must be ${positive ? "positive" : "zero or positive"} and finite.`);
  return Object.is(parsed, -0) ? 0 : parsed;
}
function finite(value) {
  if (!Number.isFinite(value)) throw new TypeError("Portfolio amounts exceed the supported number range.");
  return value;
}
function calendarDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new TypeError(`${label} must be a valid YYYY-MM-DD calendar date.`);
  return value;
}
function instant(value, label, strict = false) {
  if (strict && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))) throw new TypeError(`${label} must be an ISO UTC timestamp.`);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) calendarDate(value, label);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || (strict && date.toISOString().slice(0, 10) !== value.slice(0, 10))) throw new TypeError(`${label} is invalid.`);
  return date.toISOString();
}
