CREATE TABLE `delivery_notices` (
	`event_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`last_error` text,
	`result` text,
	`created_at` integer NOT NULL
);
