import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
