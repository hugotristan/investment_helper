import { projectPortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { buildAnalystContext } from "../js/analysis/portfolio-context.js";
import { readCloudRecord } from "./cloud-store.mjs";
import { ApiError } from "./request-body.mjs";
import { VWCE_TICKERS } from "../js/data/vanguard-holdings.js";
export { buildAnalystContext } from "../js/analysis/portfolio-context.js";

export async function loadAnalystContext({ env, userId, market, fundData, expectedRevision, includeNotes = false, now = Date.now }) {
  const clock = () => typeof now === "function" ? now() : now;
  const record = await readCloudRecord(env, userId, "portfolio", clock());
  if (!record.book) throw new ApiError(409, "NO_PORTFOLIO", "Start portfolio tracking to see portfolio insights.");
  if (expectedRevision !== undefined && expectedRevision !== record.revision) throw new ApiError(409, "PORTFOLIO_CHANGED", "Your portfolio changed. Refresh the figures before reviewing again.");
  const projection = projectPortfolioBook(record.book);
  const tickers = [...new Set([...projection.holdings.map((holding) => holding.ticker).slice(0, 40),
    ...record.book.transactions.map((entry) => entry.ticker).filter(Boolean)])].slice(0, 59);
  tickers.push("SPY");
  const [historyResults, exchangeRate, fxHistory, funds] = await Promise.all([
    Promise.all(tickers.map(async (ticker) => [ticker, await market.loadHistory(ticker).catch(() => null)])),
    market.loadExchangeRate().catch(() => null), market.loadHistoricalFx().catch(() => null),
    fundData && projection.holdings.some(holding => VWCE_TICKERS.includes(holding.ticker)) ? fundData.loadFunds() : undefined,
  ]);
  const current = await readCloudRecord(env, userId, "portfolio", clock());
  if (current.revision !== record.revision) throw new ApiError(409, "PORTFOLIO_CHANGED", "Your portfolio changed while the figures were loading. Refresh and try again.");
  // Validate at completion: FX retrieved during this request can be newer than
  // its start time. Keep genuine future timestamps invalid and source dates intact.
  return buildAnalystContext({ book: record.book, revision: record.revision, histories: Object.fromEntries(historyResults),
    exchangeRate, fxHistory, funds, includeNotes, now: clock() });
}
