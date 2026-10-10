import { validatePortfolioBook } from "../js/analysis/portfolio-ledger.js";
import { isBlockedAssetTicker } from "../js/shared/symbols.js";
import { ApiError } from "./request-body.mjs";

const tables = {
  portfolio: { table: "portfolio_books", column: "book" },
  watchlist: { table: "watchlists", column: "tickers" },
};

export function sitesUserId(request) {
  const id = request.headers.get("oai-authenticated-user-id");
  if (!id || id.length > 256 || /[\s\x00-\x1f\x7f]/.test(id)) {
    throw new ApiError(401, "SIGN_IN_REQUIRED", "Sign in with ChatGPT to open your saved data.");
  }
  return id;
}

export function storageAvailable(env) {
  return !!env?.DB && typeof env.DB.prepare === "function";
}

function database(env) {
  if (!storageAvailable(env)) throw new ApiError(503, "STORAGE_UNAVAILABLE", "Cloud storage is temporarily unavailable. Your saved data was not replaced.");
  return env.DB;
}

export function validateCloudBook(input, now = Date.now()) {
  const result = validatePortfolioBook(input, { now });
  if (!result.ok) throw new ApiError(400, "INVALID_BOOK", result.error || "The portfolio is invalid.");
  return JSON.parse(JSON.stringify(result.book));
}

export function validateCloudTickers(input) {
  if (!Array.isArray(input) || input.length > 90 || input.some((ticker) => typeof ticker !== "string"
    || !/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(ticker) || isBlockedAssetTicker(ticker))) {
    throw new ApiError(400, "INVALID_WATCHLIST", "Choose up to 90 stock or ETF tickers.");
  }
  if (new Set(input).size !== input.length) throw new ApiError(400, "INVALID_WATCHLIST", "Watchlist tickers must be unique.");
  return [...input];
}

export function validateSaveEnvelope(input, kind, now = Date.now()) {
  const field = kind === "portfolio" ? "book" : "tickers";
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => ![field, "expectedRevision"].includes(key))
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
    || input.expectedRevision >= Number.MAX_SAFE_INTEGER) {
    throw new ApiError(400, "INVALID_REVISION", "Save with a valid expected revision and supported fields.");
  }
  return { value: kind === "portfolio" ? validateCloudBook(input.book, now) : validateCloudTickers(input.tickers),
    expectedRevision: input.expectedRevision };
}

function envelope(kind, row, now) {
  if (!row) return kind === "portfolio" ? { book: null, revision: 0, updatedAt: null }
    : { tickers: null, revision: 0, updatedAt: null };
  if (!Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.updated_at !== "string"
    || new Date(row.updated_at).toISOString() !== row.updated_at) throw new Error("Invalid saved record.");
  const value = JSON.parse(row[tables[kind].column]);
  return kind === "portfolio" ? { book: validateCloudBook(value, now), revision: row.revision, updatedAt: row.updated_at }
    : { tickers: validateCloudTickers(value), revision: row.revision, updatedAt: row.updated_at };
}

export async function readCloudRecord(env, userId, kind, now = Date.now()) {
  const db = database(env);
  const { table, column } = tables[kind];
  try {
    const row = await db.prepare(`SELECT ${column}, revision, updated_at FROM ${table} WHERE user_id = ?`).bind(userId).first();
    return envelope(kind, row, now);
  } catch {
    throw new ApiError(503, "STORAGE_UNAVAILABLE", "Cloud storage could not load your saved data. Existing data was not replaced.");
  }
}

export async function saveCloudRecord(env, userId, kind, value, expectedRevision, now = Date.now()) {
  const db = database(env);
  const { table, column } = tables[kind];
  const timestamp = new Date(now).toISOString();
  let row;
  try {
    // Creation and updates each perform one conditional statement. Two writers
    // with the same revision cannot both succeed, including the first import.
    row = expectedRevision === 0
      ? await db.prepare(`INSERT INTO ${table} (user_id, ${column}, revision, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(user_id) DO NOTHING RETURNING ${column}, revision, updated_at`)
        .bind(userId, JSON.stringify(value), timestamp).first()
      : await db.prepare(`UPDATE ${table} SET ${column} = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ? RETURNING ${column}, revision, updated_at`)
        .bind(JSON.stringify(value), timestamp, userId, expectedRevision).first();
    if (row) return envelope(kind, row, now);
  } catch {
    throw new ApiError(503, "STORAGE_UNAVAILABLE", "Cloud storage did not confirm the save. Reload your saved data before retrying.");
  }
  throw new ApiError(409, "CONFLICT", "This data changed on another device or tab. Reload its latest version before saving.");
}
