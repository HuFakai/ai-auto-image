CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key_encrypted` text NOT NULL,
	`api_key_hint` text DEFAULT '' NOT NULL,
	`text_model` text,
	`image_model` text,
	`aspect_ratio_param` text DEFAULT 'aspect_ratio' NOT NULL,
	`response_format` text DEFAULT 'b64_json' NOT NULL,
	`resolution` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`image_concurrency_max` integer,
	`last_test_ok` integer,
	`last_test_at` integer,
	`last_test_detail` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_channels_type_order` ON `channels` (`type`,`sort_order`);