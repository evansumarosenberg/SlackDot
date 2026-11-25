CREATE TABLE `event_dedup` (
	`key` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`claim_token` text,
	`claim_expires_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `event_dedup_expiry` ON `event_dedup` (`expires_at`);