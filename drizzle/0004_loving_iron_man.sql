CREATE TABLE `cash_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`event` text NOT NULL,
	`actor` text NOT NULL,
	`occurred_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cash_audit_operation` ON `cash_audit` (`user_id`,`operation_id`);--> statement-breakpoint
CREATE TABLE `cash_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`actor` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request` text NOT NULL,
	`status` text NOT NULL,
	`expected_revision` integer NOT NULL,
	`csrf` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` integer NOT NULL,
	`confirmed_at` text,
	`result` text,
	`reverses_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cash_operation_idempotency` ON `cash_operations` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `cash_operation_one_reversal` ON `cash_operations` (`reverses_id`) WHERE "cash_operations"."status" = 'confirmed';