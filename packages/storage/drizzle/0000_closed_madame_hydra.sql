CREATE TABLE `asset_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`related_asset_id` text NOT NULL,
	`relation` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`related_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_asset_relations_asset` ON `asset_relations` (`asset_id`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`node_run_id` text,
	`page_index` integer,
	`kind` text NOT NULL,
	`file_path` text NOT NULL,
	`mime_type` text DEFAULT 'image/png' NOT NULL,
	`width` integer,
	`height` integer,
	`bytes` integer DEFAULT 0 NOT NULL,
	`checksum` text,
	`metadata_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_run_id`) REFERENCES `node_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_assets_run` ON `assets` (`run_id`);--> statement-breakpoint
CREATE TABLE `job_events` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`event` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_job_events_job` ON `job_events` (`job_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`run_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`idempotency_key` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`recoveries` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`lease_holder` text,
	`lease_expires_at` integer,
	`last_progress_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_jobs_idempotency` ON `jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_jobs_status` ON `jobs` (`status`);--> statement-breakpoint
CREATE TABLE `node_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`node_name` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`input_ref` text,
	`output_ref` text,
	`route_id` text,
	`model` text,
	`prompt_version_id` text,
	`error_category` text,
	`error_summary` text,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`images` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_node_runs_run` ON `node_runs` (`run_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `prompt_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`node_name` text NOT NULL,
	`version` integer NOT NULL,
	`template` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_prompt_node_version` ON `prompt_versions` (`node_name`,`version`);--> statement-breakpoint
CREATE TABLE `provider_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`node_run_id` text,
	`route_id` text NOT NULL,
	`kind` text NOT NULL,
	`model` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`status_code` integer,
	`error_category` text,
	`error_summary` text,
	`provider_request_id` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`duration_ms` integer
);
--> statement-breakpoint
CREATE INDEX `idx_provider_attempts_run` ON `provider_attempts` (`run_id`);--> statement-breakpoint
CREATE TABLE `provider_usages` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`node_run_id` text,
	`route_id` text NOT NULL,
	`model` text,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`images` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_provider_usages_run` ON `provider_usages` (`run_id`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`input_json` text NOT NULL,
	`snapshot_json` text,
	`error_summary` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_runs_project` ON `workflow_runs` (`project_id`);