CREATE TABLE `brand_kits` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`theme_id` text DEFAULT 'darkroom' NOT NULL,
	`style_keywords_json` text DEFAULT '[]' NOT NULL,
	`negative_keywords_json` text DEFAULT '[]' NOT NULL,
	`logo_asset_id` text,
	`built_in` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`page_index` integer NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text,
	`asset_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_revisions_run_page` ON `revisions` (`run_id`,`page_index`);--> statement-breakpoint
ALTER TABLE `assets` ADD `superseded_at` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `payload_json` text;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `review_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `review_note` text;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `reviewed_at` integer;