import test from "node:test";
import assert from "node:assert/strict";
import { calculateRetirementScenario } from "../js/analysis/retirement-scenario.js";
import { normalizeRetirementScenario } from "../js/analysis/retirement-assumptions.js";
import { createPortfolioBook, projectPortfolioBook, validatePortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { parsePortfolioBackup, serializePortfolioBackup } from "../js/data/portfolio-book-store.js";
const NOW = Date.parse("2026-10-12T12:00:00Z");
const plan = extra => ({ retirementMonth: "2027-10", monthlyContribution: 100, annualReturnPercent: 0,
  annualInflationPercent: 0, monthlyWithdrawal: 100, withdrawalYears: 1, ...extra });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < Math.max(1e-8, Math.abs(expected) * 1e-12), `${actual} != ${expected}`);

test("zero-return saving and withdrawals reconcile every EUR and never create a negative balance", () => {
  const input = plan(), copy = structuredClone(input);
  const m = calculateRetirementScenario(1000, input, { now: NOW });
  assert.equal(m.monthsToRetirement, 12); assert.equal(m.retirementValue, 2200);
  assert.equal(m.retirementRealValue, 2200); assert.equal(m.endValue, 1000);
  assert.equal(m.contributed, 1200); assert.equal(m.withdrawn, 1200); assert.equal(m.growth, 0);
  assert.equal(m.firstShortfallMonth, null); assert.equal(m.rows.length, 25);
  assert.equal(m.rows[12].month, "2027-10"); assert.equal(m.rows[12].contribution, 100);
  assert.equal(m.rows[13].contribution, 0); assert.equal(m.rows[13].actualWithdrawal, 100);
  for (const row of m.rows) close(row.balance, 1000 + row.contributed + row.growth - row.withdrawn);
  assert.deepEqual(input, copy);
  const depleted = calculateRetirementScenario(150, plan({ retirementMonth: "2026-10", monthlyWithdrawal: 100 }), { now: NOW });
  assert.equal(depleted.retirementValue, 150); assert.equal(depleted.firstShortfallMonth, "2026-12");
  assert.equal(depleted.rows[1].actualWithdrawal, 100); assert.equal(depleted.rows[2].actualWithdrawal, 50);
  assert.equal(depleted.rows[2].shortfall, 50); assert.equal(depleted.endValue, 0);
  assert.equal(depleted.withdrawn, 150); assert(depleted.rows.every(row => row.balance >= 0));
});

test("effective annual compounding matches an independent annuity calculation, including fractional EUR", () => {
  const annual = (1.01 ** 12 - 1) * 100;
  const m = calculateRetirementScenario(1000.25, plan({ annualReturnPercent: annual, monthlyContribution: 100.5 }), { now: NOW });
  close(m.rows[1].balance, 1000.25 * 1.01 + 100.5);
  close(m.retirementValue, 1000.25 * 1.01 ** 12 + 100.5 * (1.01 ** 12 - 1) / 0.01);
  close(m.retirementValue, 1000.25 + m.retirementContributions + m.rows[12].growth);
  const year = calculateRetirementScenario(1000, plan({ monthlyContribution: 0, annualReturnPercent: 10, annualInflationPercent: 20, monthlyWithdrawal: 0 }), { now: NOW });
  close(year.retirementValue, 1100); close(year.retirementRealValue, 1100 / 1.2);
});

test("withdrawals maintain today's purchasing power and losses or deflation stay explicit", () => {
  const m = calculateRetirementScenario(100000, plan({ monthlyContribution: 0, annualInflationPercent: 20 }), { now: NOW });
  close(m.rows[24].requestedWithdrawal, 100 * 1.2 ** 2);
  close(m.firstWithdrawal, 100 * 1.2 ** (13 / 12));
  close(m.endValue, 100000 - m.withdrawn);
  close(m.endRealValue, m.endValue / 1.2 ** 2);
  const loss = calculateRetirementScenario(1000, plan({ annualReturnPercent: -10, annualInflationPercent: -5, monthlyContribution: 0, monthlyWithdrawal: 0 }), { now: NOW });
  close(loss.retirementValue, 900); close(loss.retirementRealValue, 900 / 0.95);
  assert(loss.growth < 0); assert.equal(loss.withdrawn, 0); assert.equal(loss.firstWithdrawal, 0);
});

test("invalid, expired and excessive horizons fail closed; the maximum supported horizon remains bounded", () => {
  for (const extra of [{ retirementMonth: "2026-13" }, { retirementMonth: "2026-09" }, { retirementMonth: "2086-11" },
    { monthlyContribution: -1 }, { monthlyWithdrawal: Infinity }, { annualReturnPercent: -100 }, { annualReturnPercent: "5" },
    { annualInflationPercent: 21 }, { withdrawalYears: 0 }, { withdrawalYears: 61 }, { withdrawalYears: 1.5 }, { unknown: 1 }]) {
    assert.throws(() => calculateRetirementScenario(1000, plan(extra), { now: NOW }), TypeError);
  }
  for (const value of [null, NaN, -1, Infinity]) assert.throws(() => calculateRetirementScenario(value, plan(), { now: NOW }), TypeError);
  assert.throws(() => calculateRetirementScenario(Number.MAX_VALUE, plan({ annualReturnPercent: 50 }), { now: NOW }), /number range/);
  const bounded = calculateRetirementScenario(100, plan({ retirementMonth: "2086-10", monthlyContribution: 0, monthlyWithdrawal: 0, withdrawalYears: 60 }), { now: NOW });
  assert.equal(bounded.rows.length, 1441); assert.equal(bounded.yearly.length, 121); assert.equal(bounded.endValue, 100);
});

test("retirement metadata sync/backup validation preserves actual accounting and supports clearing or older books", () => {
  const original = createPortfolioBook({ now: NOW, holdings: [] });
  const withScenario = { ...original, retirementScenario: plan() };
  assert.deepEqual(validatePortfolioBook(original, { now: NOW }).book, original);
  assert.deepEqual(projectPortfolioBook(withScenario), projectPortfolioBook(original));
  const restored = parsePortfolioBackup(serializePortfolioBackup(withScenario, { now: NOW }), { now: NOW });
  assert.equal(restored.ok, true, restored.error); assert.deepEqual(restored.book, withScenario);
  assert.deepEqual(validatePortfolioBook({ ...original, retirementScenario: null }, { now: NOW }).book.retirementScenario, null);
  assert.equal(validatePortfolioBook({ ...original, retirementScenario: plan({ annualReturnPercent: NaN }) }, { now: NOW }).ok, false);
  // A past target remains readable; recalculating it asks the user to update.
  assert.equal(normalizeRetirementScenario(plan({ retirementMonth: "2000-01" })).retirementMonth, "2000-01");
});
