// Form input only: comma and dot are decimal separators, never digit grouping.
// Stored records and API/backup validation continue to use canonical numbers.
export function parseDecimalInput(value, { min = -Infinity } = {}) {
  if (typeof value !== "number") {
    if (typeof value !== "string" || !/^-?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(value.trim())) return NaN;
    value = Number(value.trim().replace(",", "."));
  }
  return Number.isFinite(value) && value >= min ? value : NaN;
}
