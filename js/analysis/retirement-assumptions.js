const keys = ["retirementMonth", "monthlyContribution", "annualReturnPercent", "annualInflationPercent", "monthlyWithdrawal", "withdrawalYears"];

export function normalizeRetirementScenario(input) {
  if (input === null) return null;
  if (!input || typeof input !== "object" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key))
    || typeof input.retirementMonth !== "string" || !/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(input.retirementMonth)) {
    throw new TypeError("Enter a valid retirement month and supported scenario fields.");
  }
  for (const field of ["monthlyContribution", "monthlyWithdrawal"]) {
    if (!Number.isFinite(input[field]) || input[field] < 0 || input[field] > 1000000) throw new TypeError("Monthly EUR amounts must be between 0 and 1,000,000.");
  }
  if (!Number.isFinite(input.annualReturnPercent) || input.annualReturnPercent < -99 || input.annualReturnPercent > 50) {
    throw new TypeError("Use an effective annual return between -99% and 50%.");
  }
  if (!Number.isFinite(input.annualInflationPercent) || input.annualInflationPercent < -10 || input.annualInflationPercent > 20) {
    throw new TypeError("Use annual inflation between -10% and 20%.");
  }
  if (!Number.isInteger(input.withdrawalYears) || input.withdrawalYears < 1 || input.withdrawalYears > 60) {
    throw new TypeError("Choose 1 to 60 years after retirement.");
  }
  return Object.fromEntries(keys.map(key => [key, input[key]]));
}

export const retirementMonthNumber = month => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
export function retirementMonthAfter(month, offset) {
  const index = retirementMonthNumber(month) + offset;
  return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}`;
}
