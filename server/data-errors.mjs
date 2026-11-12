export function dataError(code, message, { ticker = null, provider = null, retryable = false, lastSuccessfulQuoteAt = null } = {}) {
  return { code, message, ticker, provider, retryable, lastSuccessfulQuoteAt };
}
export function normalizeErrors(value) {
  if (Array.isArray(value)) return value.map(normalizeErrors);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ["errors", "warnings"].includes(key) && Array.isArray(item) ? item.map(error => typeof error === "object" && error?.code
      ? dataError(error.code, error.message, error) : error) : normalizeErrors(item)]));
}
