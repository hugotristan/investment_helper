CREATE TABLE `coverage_scans` (
	`user_id` text PRIMARY KEY NOT NULL,
	`cursor` integer NOT NULL,
	`revision` text NOT NULL,
	`next_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `market_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`payload` text,
	`succeeded_at` integer,
	`expires_at` integer NOT NULL,
	`retry_at` integer NOT NULL,
	`lease_until` integer NOT NULL,
	`error` text
);
