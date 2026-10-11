import test from "node:test";
import assert from "node:assert/strict";
import { createPortfolioBook, projectPortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { holdingEurReturn } from "../js/analysis/portfolio-returns.js";

const fx = { available: true, base: "USD", quote: "EUR", rate: 0.9 };
const buy = (id, quantity, cashAmount, date = "2026-10-01") => ({ id, type: "buy", date,
  ticker: "MSFT", currency: "USD", quantity, price: 100, fee: 1, cashCurrency: "EUR", cashAmount });
const book = (transactions, openingHoldings = []) => ({ ...createPortfolioBook({ holdings: openingHoldings,
  startDate: "2026-10-01", now: "2026-10-09" }), transactions });

test("EUR profit includes the FX change on invested capital using the recorded all-in payments", () => {
  const ledger = book([buy("first", 2, 160), buy("second", 1, 85, "2026-10-02")]);
  const before = structuredClone(ledger);
  const projection = projectPortfolioBook(ledger);
  const holding = { ...projection.holdings[0], costBasis: 302, currentValue: 300 };
  const result = holdingEurReturn(holding, { eurCostBases: projection.eurCostBases, exchangeRate: fx });
  assert.deepEqual(result, { costBasis: 245, currentValue: 270, gain: 25, gainPercent: 25 / 245 });
  assert.equal(holding.currentValue - holding.costBasis, -2); // USD loss can coexist with a EUR gain.
  assert.equal(holdingEurReturn(holding, { eurCostBases: projection.eurCostBases,
    exchangeRate: { ...fx, rate: 0.8 } }).gain, -5);
  assert.equal(holdingEurReturn(holding, { eurCostBases: projection.eurCostBases }).gain, null);
  assert.deepEqual(ledger, before);
});

test("partial sales remove proportional EUR purchase cost, and a full sale resets an unknown opening basis", () => {
  const sell = { ...buy("sale", 1, 120, "2026-10-03"), type: "sell", price: 150 };
  const ledger = book([buy("first", 2, 160), buy("second", 1, 80, "2026-10-02"), sell]);
  const projection = projectPortfolioBook(ledger);
  assert.equal(projection.holdings[0].shares, 2);
  assert.equal(projection.eurCostBases[0].costBasis, 160);
  const opening = { id: "opening", kind: "position", ticker: "MSFT", label: "Microsoft",
    shares: 1, averageCost: 100, currency: "USD" };
  assert.equal(projectPortfolioBook(book([buy("later", 1, 80)], [opening])).eurCostBases[0].costBasis, null);
  const rebought = projectPortfolioBook(book([sell, buy("rebuy", 2, 170, "2026-10-04")], [opening]));
  assert.equal(rebought.eurCostBases[0].costBasis, 170);
  const missing = buy("missing", 2, 160); delete missing.cashCurrency; delete missing.cashAmount;
  assert.equal(projectPortfolioBook(book([missing])).eurCostBases[0].costBasis, null);
  const eur = projectPortfolioBook(book([{ ...buy("eur", 2, 0), currency: "EUR", cashAmount: 201 }]));
  assert.equal(eur.eurCostBases[0].costBasis, 201);
});
