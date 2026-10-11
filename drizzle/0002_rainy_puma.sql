CREATE TABLE `analyst_usage` (
	`user_id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`requests` integer NOT NULL,
	`next_allowed_at` integer NOT NULL,
	CONSTRAINT "analyst_requests_positive" CHECK("analyst_usage"."requests" >= 1)
);
