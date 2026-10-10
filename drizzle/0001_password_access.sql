CREATE TABLE `password_login_attempts` (
	`attempt_key` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT "password_attempts_positive" CHECK("password_login_attempts"."attempts" >= 1)
);
--> statement-breakpoint
CREATE INDEX `password_attempts_expiry` ON `password_login_attempts` (`expires_at`);--> statement-breakpoint
CREATE TABLE `password_workspace` (
	`workspace_key` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL
);
