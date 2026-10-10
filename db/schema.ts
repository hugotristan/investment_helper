import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
