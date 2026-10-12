import { portfolioToday } from "./portfolio-ledger.js";
import { normalizeRetirementScenario, retirementMonthAfter, retirementMonthNumber } from "./retirement-assumptions.js";

// annualReturnPercent is an effective annual rate: twelve monthly factors
// multiply to 1 + annualReturnPercent/100. Contributions occur after growth.
export function calculateRetirementScenario(initialValue, input, { now = Date.now() } = {}) {
  const assumptions = normalizeRetirementScenario(input);
  if (!assumptions) throw new TypeError("Enter scenario assumptions first.");
  if (!Number.isFinite(initialValue) || initialValue < 0) throw new TypeError("A complete, non-negative current EUR portfolio value is required.");
  const from = portfolioToday(now).slice(0, 7);
  const monthsToRetirement = retirementMonthNumber(assumptions.retirementMonth) - retirementMonthNumber(from);
  if (monthsToRetirement < 0 || monthsToRetirement > 720) throw new TypeError("Choose a retirement month from this month to 60 years ahead.");
  const months = monthsToRetirement + assumptions.withdrawalYears * 12;
  const growthFactor = Math.pow(1 + assumptions.annualReturnPercent / 100, 1 / 12);
  const inflationFactor = Math.pow(1 + assumptions.annualInflationPercent / 100, 1 / 12);
  let balance = initialValue, contributed = 0, withdrawn = 0, growth = 0, firstShortfallMonth = null;
  let retirementValue = initialValue, retirementRealValue = initialValue, firstWithdrawal = null;
  const rows = [{ month: from, elapsedMonths: 0, phase: monthsToRetirement ? "Saving" : "Retirement", balance, realValue: balance,
    contribution: 0, requestedWithdrawal: 0, actualWithdrawal: 0, shortfall: 0, contributed, withdrawn, growth }];
  for (let index = 1; index <= months; index++) {
    const month = retirementMonthAfter(from, index), inflation = Math.pow(inflationFactor, index);
    const before = balance;
    balance *= growthFactor;
    growth += balance - before;
    const saving = index <= monthsToRetirement;
    const contribution = saving ? assumptions.monthlyContribution : 0;
    const requestedWithdrawal = saving ? 0 : assumptions.monthlyWithdrawal * inflation;
    if (!saving && firstWithdrawal === null) firstWithdrawal = requestedWithdrawal;
    balance += contribution;
    const actualWithdrawal = Math.min(balance, requestedWithdrawal);
    const shortfall = Math.max(0, requestedWithdrawal - actualWithdrawal);
    balance = Math.max(0, balance - actualWithdrawal);
    contributed += contribution; withdrawn += actualWithdrawal;
    // Ignore arithmetic dust, not a material missing payment.
    if (shortfall > Math.max(1e-7, requestedWithdrawal * 1e-12) && !firstShortfallMonth) firstShortfallMonth = month;
    const realValue = balance / inflation;
    if (![balance, realValue, contribution, requestedWithdrawal, actualWithdrawal, shortfall, contributed, withdrawn, growth].every(Number.isFinite)) {
      throw new TypeError("This scenario exceeds the supported number range. Reduce the amounts, rates or horizon.");
    }
    rows.push({ month, elapsedMonths: index, phase: saving ? "Saving" : "Retirement", balance, realValue,
      contribution, requestedWithdrawal, actualWithdrawal, shortfall, contributed, withdrawn, growth });
    if (index === monthsToRetirement) { retirementValue = balance; retirementRealValue = realValue; }
  }
  const yearly = rows.filter(row => row.elapsedMonths % 12 === 0 || row.elapsedMonths === monthsToRetirement || row.elapsedMonths === months);
  return { assumptions, from, initialValue, monthsToRetirement, rows, yearly, retirementValue, retirementRealValue,
    retirementContributions: assumptions.monthlyContribution * monthsToRetirement, firstWithdrawal, firstShortfallMonth,
    endValue: balance, endRealValue: rows.at(-1).realValue, contributed, withdrawn, growth };
}
