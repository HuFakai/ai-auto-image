CREATE TABLE "asset_relations" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"related_asset_id" text NOT NULL,
	"relation" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"node_run_id" text,
	"page_index" integer,
	"kind" text NOT NULL,
	"file_path" text NOT NULL,
	"mime_type" text DEFAULT 'image/png' NOT NULL,
	"width" integer,
	"height" integer,
	"bytes" integer DEFAULT 0 NOT NULL,
	"checksum" text,
	"metadata_json" text,
	"superseded_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_kits" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"theme_id" text DEFAULT 'darkroom' NOT NULL,
	"style_keywords_json" text DEFAULT '[]' NOT NULL,
	"negative_keywords_json" text DEFAULT '[]' NOT NULL,
	"logo_asset_id" text,
	"built_in" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"api_key_hint" text DEFAULT '' NOT NULL,
	"text_model" text,
	"image_model" text,
	"aspect_ratio_param" text DEFAULT 'aspect_ratio' NOT NULL,
	"response_format" text DEFAULT 'b64_json' NOT NULL,
	"resolution" text,
	"enabled" integer DEFAULT 1 NOT NULL,
	"sort_order" bigint DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"image_concurrency_max" integer,
	"image_edit_support" integer DEFAULT 0 NOT NULL,
	"last_test_ok" integer,
	"last_test_at" bigint,
	"last_test_detail" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"event" text NOT NULL,
	"detail" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"run_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload_json" text,
	"idempotency_key" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"recoveries" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"lease_holder" text,
	"lease_expires_at" bigint,
	"last_progress_at" bigint,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"node_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"input_ref" text,
	"output_ref" text,
	"route_id" text,
	"model" text,
	"prompt_version_id" text,
	"error_category" text,
	"error_summary" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"images" integer DEFAULT 0 NOT NULL,
	"cost_usd" real,
	"started_at" bigint,
	"finished_at" bigint
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"node_name" text NOT NULL,
	"version" integer NOT NULL,
	"template" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"node_run_id" text,
	"route_id" text NOT NULL,
	"kind" text NOT NULL,
	"model" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status_code" integer,
	"error_category" text,
	"error_summary" text,
	"provider_request_id" text,
	"started_at" bigint NOT NULL,
	"finished_at" bigint,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "provider_usages" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"node_run_id" text,
	"route_id" text NOT NULL,
	"model" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"images" integer DEFAULT 0 NOT NULL,
	"cost_usd" real,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"page_index" integer NOT NULL,
	"kind" text NOT NULL,
	"payload_json" text,
	"asset_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"auth_provider" text DEFAULT 'password' NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text,
	"role" text DEFAULT 'user' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"auth_provider" text DEFAULT 'password' NOT NULL,
	"provider_subject" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"input_json" text NOT NULL,
	"snapshot_json" text,
	"error_summary" text,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"review_note" text,
	"reviewed_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"started_at" bigint,
	"finished_at" bigint
);
--> statement-breakpoint
ALTER TABLE "asset_relations" ADD CONSTRAINT "asset_relations_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_relations" ADD CONSTRAINT "asset_relations_related_asset_id_assets_id_fk" FOREIGN KEY ("related_asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_node_run_id_node_runs_id_fk" FOREIGN KEY ("node_run_id") REFERENCES "public"."node_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_runs" ADD CONSTRAINT "node_runs_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_asset_relations_asset" ON "asset_relations" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "idx_assets_run" ON "assets" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_channels_type_order" ON "channels" USING btree ("type","sort_order");--> statement-breakpoint
CREATE INDEX "idx_job_events_job" ON "job_events" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_jobs_idempotency" ON "jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_jobs_status" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_node_runs_run" ON "node_runs" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prompt_node_version" ON "prompt_versions" USING btree ("node_name","version");--> statement-breakpoint
CREATE INDEX "idx_provider_attempts_run" ON "provider_attempts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_provider_usages_run" ON "provider_usages" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_revisions_run_page" ON "revisions" USING btree ("run_id","page_index");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sessions_token_hash" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_username" ON "users" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_provider_subject" ON "users" USING btree ("provider_subject");--> statement-breakpoint
CREATE INDEX "idx_workflow_runs_project" ON "workflow_runs" USING btree ("project_id");