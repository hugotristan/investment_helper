CREATE TABLE `development_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`record` text NOT NULL,
	`completed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `development_changes_owner_time` ON `development_changes` (`user_id`,`completed_at`);