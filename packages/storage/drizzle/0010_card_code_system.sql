ALTER TABLE "orders" ADD COLUMN "card_id" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "batch_id" text;
--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "card_id" text;
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value_json" text DEFAULT '{}' NOT NULL,
	"updated_by" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_no" text NOT NULL,
	"name" text NOT NULL,
	"benefit_type" text DEFAULT 'credits' NOT NULL,
	"benefit_json" text DEFAULT '{}' NOT NULL,
	"quantity" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" bigint,
	"source" text DEFAULT 'admin' NOT NULL,
	"api_key_id" text,
	"external_batch_id" text,
	"sales_channel" text,
	"remark" text,
	"created_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redemption_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"code_prefix" text NOT NULL,
	"code_last4" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" bigint,
	"redeemed_by" text,
	"redeemed_at" bigint,
	"redemption_order_id" text,
	"metadata_json" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_redemptions" (
	"id" text PRIMARY KEY NOT NULL,
	"card_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"user_id" text NOT NULL,
	"order_id" text NOT NULL,
	"status" text DEFAULT 'succeeded' NOT NULL,
	"failure_code" text,
	"ip_hash" text,
	"user_agent_hash" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes_json" text DEFAULT '["cards:generate"]' NOT NULL,
	"ip_allowlist_json" text DEFAULT '[]' NOT NULL,
	"rate_limit_per_minute" integer DEFAULT 60 NOT NULL,
	"webhook_url" text,
	"webhook_secret_encrypted" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_used_at" bigint,
	"expires_at" bigint,
	"created_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_idempotency_records" (
	"id" text PRIMARY KEY NOT NULL,
	"api_key_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"response_encrypted" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"api_key_id" text NOT NULL,
	"event_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"endpoint_url" text NOT NULL,
	"secret_encrypted" text,
	"payload_json" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint NOT NULL,
	"last_error" text,
	"delivered_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"batch_id" text,
	"card_id" text,
	"api_key_id" text,
	"detail_json" text,
	"ip_hash" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "card_batches" ADD CONSTRAINT "card_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "redemption_cards" ADD CONSTRAINT "redemption_cards_batch_id_card_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."card_batches"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "redemption_cards" ADD CONSTRAINT "redemption_cards_redeemed_by_users_id_fk" FOREIGN KEY ("redeemed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "card_redemptions" ADD CONSTRAINT "card_redemptions_card_id_redemption_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."redemption_cards"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "card_redemptions" ADD CONSTRAINT "card_redemptions_batch_id_card_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."card_batches"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "card_redemptions" ADD CONSTRAINT "card_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "external_api_keys" ADD CONSTRAINT "external_api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "api_idempotency_records" ADD CONSTRAINT "api_idempotency_records_api_key_id_external_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."external_api_keys"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "card_webhook_deliveries" ADD CONSTRAINT "card_webhook_deliveries_api_key_id_external_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."external_api_keys"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_card_batches_no" ON "card_batches" USING btree ("batch_no");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_card_batches_source_external" ON "card_batches" USING btree ("source","external_batch_id");
--> statement-breakpoint
CREATE INDEX "idx_card_batches_status_created" ON "card_batches" USING btree ("status","created_at");
--> statement-breakpoint
CREATE INDEX "idx_card_batches_api_key" ON "card_batches" USING btree ("api_key_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_redemption_cards_hash" ON "redemption_cards" USING btree ("code_hash");
--> statement-breakpoint
CREATE INDEX "idx_redemption_cards_batch_status" ON "redemption_cards" USING btree ("batch_id","status");
--> statement-breakpoint
CREATE INDEX "idx_redemption_cards_redeemed_by" ON "redemption_cards" USING btree ("redeemed_by","redeemed_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_card_redemptions_card" ON "card_redemptions" USING btree ("card_id");
--> statement-breakpoint
CREATE INDEX "idx_card_redemptions_user_created" ON "card_redemptions" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_card_redemptions_batch_created" ON "card_redemptions" USING btree ("batch_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_external_api_keys_hash" ON "external_api_keys" USING btree ("key_hash");
--> statement-breakpoint
CREATE INDEX "idx_external_api_keys_status" ON "external_api_keys" USING btree ("status","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_api_idempotency_key" ON "api_idempotency_records" USING btree ("api_key_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "idx_api_idempotency_expiry" ON "api_idempotency_records" USING btree ("expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_card_webhook_event" ON "card_webhook_deliveries" USING btree ("api_key_id","event_id");
--> statement-breakpoint
CREATE INDEX "idx_card_webhook_pending" ON "card_webhook_deliveries" USING btree ("status","next_attempt_at");
--> statement-breakpoint
CREATE INDEX "idx_card_audit_created" ON "card_audit_logs" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "idx_card_audit_batch" ON "card_audit_logs" USING btree ("batch_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_orders_card" ON "orders" USING btree ("card_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_orders_batch" ON "orders" USING btree ("batch_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_credit_ledger_card" ON "credit_ledger" USING btree ("card_id");
--> statement-breakpoint
INSERT INTO "system_settings" ("key", "value_json", "updated_at") VALUES
	('card_system_enabled', '0', (extract(epoch from clock_timestamp()) * 1000)::bigint),
	('card_redeem_enabled', '1', (extract(epoch from clock_timestamp()) * 1000)::bigint),
	('card_api_enabled', '0', (extract(epoch from clock_timestamp()) * 1000)::bigint)
ON CONFLICT ("key") DO NOTHING;
