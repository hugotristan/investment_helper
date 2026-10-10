CREATE TABLE `portfolio_books` (
	`user_id` text PRIMARY KEY NOT NULL,
	`book` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "portfolio_revision_positive" CHECK("portfolio_books"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE `watchlists` (
	`user_id` text PRIMARY KEY NOT NULL,
	`tickers` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "watchlist_revision_positive" CHECK("watchlists"."revision" >= 1)
);
