// Display conversion only: stored transactions and native holding calculations stay unchanged.
export function portfolioMoney(value, currency, { exchangeRate = null, signed = false, locale } = {}) {
  if (!Number.isFinite(value)) return "Unavailable";
  const format = (amount, code) => {
    const prefix = signed && amount > 0 ? "+" : "";
    try { return prefix + new Intl.NumberFormat(locale, { style: "currency", currency: code, maximumFractionDigits: 2 }).format(amount); }
    catch { return `${prefix}${amount.toFixed(2)} ${code || ""}`.trim(); }
  };
  const native = format(value, currency);
  if (currency !== "USD") return native;
  const converted = exchangeRate?.available === true && exchangeRate.base === "USD" && exchangeRate.quote === "EUR"
    && Number.isFinite(exchangeRate.rate) && exchangeRate.rate > 0 ? value * exchangeRate.rate : NaN;
  return `${native} (${Number.isFinite(converted) ? format(converted, "EUR") : "EUR unavailable"})`;
}
