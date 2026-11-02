CREATE TABLE `deliveries` (
	`event_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_at` integer NOT NULL,
	`deadline` integer NOT NULL,
	`claim` text,
	`lease_until` integer,
	`last_error` text,
	PRIMARY KEY(`event_id`, `subscription_id`)
);
--> statement-breakpoint
CREATE INDEX `delivery_due` ON `deliveries` (`state`,`next_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation` text NOT NULL,
	`thread` text NOT NULL,
	`payload` text NOT NULL,
	`accepted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`accepted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`args` text NOT NULL,
	`conversation` text NOT NULL,
	`thread` text,
	`callback` text NOT NULL,
	`secret` text,
	`secret_hash` text NOT NULL,
	`verified_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`active` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `writes` (
	`id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`state` text NOT NULL,
	`result` text,
	`created_at` integer NOT NULL
);
