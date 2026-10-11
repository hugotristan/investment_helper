import { isBlockedAssetTicker } from "../shared/symbols.js";

const currencies = new Set(["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD"]);
const plain = (value) => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const shape = (value, keys, label) => {
  if (!plain(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new TypeError(`${label} contains unsupported fields.`);
};

export function normalizePortfolioOrganization(input) {
  shape(input, ["groups", "positions"], "Portfolio organization");
  if (!Array.isArray(input.groups) || input.groups.length > 50) throw new TypeError("Use at most 50 portfolio groups.");
  if (!Array.isArray(input.positions) || input.positions.length > 500) throw new TypeError("Use at most 500 position notes.");
  const ids = new Set(), names = new Set(), positions = new Set();
  const groups = input.groups.map((group) => {
    shape(group, ["id", "name"], "Portfolio group");
    if (typeof group.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(group.id) || ids.has(group.id)) throw new TypeError("Group IDs must be valid and unique.");
    if (typeof group.name !== "string" || !group.name.trim() || group.name.trim().length > 80 || /[\u0000-\u001f]/.test(group.name)) throw new TypeError("Enter a group name of 1–80 characters.");
    const name = group.name.trim().normalize("NFC");
    if (names.has(name.toLowerCase())) throw new TypeError("Group names must be unique.");
    ids.add(group.id); names.add(name.toLowerCase());
    return { id: group.id, name };
  });
  const entries = input.positions.map((entry) => {
    shape(entry, ["ticker", "currency", "groupId", "note"], "Position note");
    if (typeof entry.ticker !== "string" || !/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(entry.ticker)
      || isBlockedAssetTicker(entry.ticker) || !currencies.has(entry.currency)) throw new TypeError("Position notes need a stock or ETF ticker and supported currency.");
    const key = positionKey(entry);
    if (positions.has(key)) throw new TypeError("Each position can have only one group and note.");
    positions.add(key);
    if (entry.groupId !== null && !ids.has(entry.groupId)) throw new TypeError("The selected portfolio group no longer exists.");
    if (typeof entry.note !== "string" || entry.note.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(entry.note)) throw new TypeError("Notes must be text of at most 2,000 characters.");
    return { ticker: entry.ticker, currency: entry.currency, groupId: entry.groupId, note: entry.note };
  });
  return { groups, positions: entries };
}

export function positionKey(position) { return `${position.ticker}|${position.currency}`; }
export function positionOrganization(organization, position) {
  return organization?.positions.find((entry) => positionKey(entry) === positionKey(position)) || { groupId: null, note: "" };
}

export function setPositionOrganization(organization, position, { groupId, note }) {
  const key = positionKey(position);
  const positions = organization.positions.filter((entry) => positionKey(entry) !== key);
  if (groupId !== null || note.trim()) positions.push({ ticker: position.ticker, currency: position.currency, groupId, note });
  return normalizePortfolioOrganization({ groups: organization.groups, positions });
}

export function removePortfolioGroup(organization, id) {
  return normalizePortfolioOrganization({ groups: organization.groups.filter((group) => group.id !== id),
    positions: organization.positions.map((entry) => entry.groupId === id ? { ...entry, groupId: null } : entry) });
}
