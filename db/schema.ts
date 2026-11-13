import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// Sites supplies a stable, trusted identity for this private app. Each browser
// reads and writes only the record belonging to its authenticated visitor.
export const portfolioBooks = sqliteTable("portfolio_books", {
  userId: text("user_id").primaryKey(),
  book: text("book").notNull(),
  revision: integer("revision").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [check("portfolio_revision_positive", sql`${table.revision} >= 1`)]);

export const watchlists = sqliteTable("watchlists", {
  userId: text("user_id").primaryKey(),
  tickers: text("tickers").notNull(),
  revision: integer("revision").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [check("watchlist_revision_positive", sql`${table.revision} >= 1`)]);

// The shared password continues to use the owner's original record key.
export const passwordWorkspace = sqliteTable("password_workspace", {
  workspaceKey: text("workspace_key").primaryKey(),
  userId: text("user_id").notNull(),
});

// Attempts are reserved atomically before password verification, across Workers.
export const passwordLoginAttempts = sqliteTable("password_login_attempts", {
  attemptKey: text("attempt_key").primaryKey(),
  attempts: integer("attempts").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [check("password_attempts_positive", sql`${table.attempts} >= 1`), index("password_attempts_expiry").on(table.expiresAt)]);

// Retained for migration history; calculated portfolio insights no longer use counters.
export const analystUsage = sqliteTable("analyst_usage", {
  userId: text("user_id").primaryKey(),
  day: text("day").notNull(),
  requests: integer("requests").notNull(),
  nextAllowedAt: integer("next_allowed_at").notNull(),
}, (table) => [check("analyst_requests_positive", sql`${table.requests} >= 1`)]);

export const developmentChanges = sqliteTable("development_changes", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  record: text("record").notNull(),
  completedAt: text("completed_at").notNull(),
}, table => [index("development_changes_owner_time").on(table.userId, table.completedAt)]);

export const cashOperations = sqliteTable("cash_operations", {
  id: text("id").primaryKey(), userId: text("user_id").notNull(), actor: text("actor").notNull(),
  idempotencyKey: text("idempotency_key").notNull(), request: text("request").notNull(),
  status: text("status").notNull(), expectedRevision: integer("expected_revision").notNull(),
  csrf: text("csrf").notNull(), createdAt: text("created_at").notNull(), expiresAt: integer("expires_at").notNull(),
  confirmedAt: text("confirmed_at"), result: text("result"), reversesId: text("reverses_id"),
}, table => [uniqueIndex("cash_operation_idempotency").on(table.userId, table.idempotencyKey),
  uniqueIndex("cash_operation_one_reversal").on(table.reversesId).where(sql`${table.status} = 'confirmed'`)]);

export const cashAudit = sqliteTable("cash_audit", {
  id: text("id").primaryKey(), userId: text("user_id").notNull(), operationId: text("operation_id").notNull(),
  event: text("event").notNull(), actor: text("actor").notNull(), occurredAt: text("occurred_at").notNull(),
}, table => [index("cash_audit_operation").on(table.userId, table.operationId)]);

// Public market observations only. No portfolio records or credentials are stored here.
export const marketCache = sqliteTable("market_cache", {
  key: text("key").primaryKey(), payload: text("payload"), succeededAt: integer("succeeded_at"),
  expiresAt: integer("expires_at").notNull(), retryAt: integer("retry_at").notNull(),
  leaseUntil: integer("lease_until").notNull(), error: text("error"),
});
export const coverageScans = sqliteTable("coverage_scans", {
  userId: text("user_id").primaryKey(), cursor: integer("cursor").notNull(),
  revision: text("revision").notNull(), nextAt: integer("next_at").notNull(),
});
