import { projectPortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { buildAnalystContext } from "../js/analysis/portfolio-context.js";
import { readCloudRecord } from "./cloud-store.mjs";
import { ApiError } from "./request-body.mjs";
export { buildAnalystContext } from "../js/analysis/portfolio-context.js";

export async function loadAnalystContext({ env, userId, market, expectedRevision, includeNotes = false, now = Date.now() }) {
  const record = await readCloudRecord(env, userId, "portfolio", now);
  if (!record.book) throw new ApiError(409, "NO_PORTFOLIO", "Start portfolio tracking to see portfolio insights.");
  if (expectedRevision !== undefined && expectedRevision !== record.revision) throw new ApiError(409, "PORTFOLIO_CHANGED", "Your portfolio changed. Refresh the figures before reviewing again.");
  const projection = projectPortfolioBook(record.book);
  const tickers = [...new Set([...projection.holdings.map((holding) => holding.ticker).slice(0, 40),
    ...record.book.transactions.map((entry) => entry.ticker).filter(Boolean)])].slice(0, 59);
  tickers.push("SPY");
  const [historyResults, exchangeRate, fxHistory] = await Promise.all([
    Promise.all(tickers.map(async (ticker) => [ticker, await market.loadHistory(ticker).catch(() => null)])),
    market.loadExchangeRate().catch(() => null), market.loadHistoricalFx().catch(() => null),
  ]);
  const current = await readCloudRecord(env, userId, "portfolio", now);
  if (current.revision !== record.revision) throw new ApiError(409, "PORTFOLIO_CHANGED", "Your portfolio changed while the figures were loading. Refresh and try again.");
  return buildAnalystContext({ book: record.book, revision: record.revision, histories: Object.fromEntries(historyResults),
    exchangeRate, fxHistory, includeNotes, now });
}
