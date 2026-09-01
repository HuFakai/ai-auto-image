CREATE TABLE "channel_models" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"type" text NOT NULL,
	"provider_model_id" text NOT NULL,
	"display_name" text NOT NULL,
	"enabled" integer DEFAULT 0 NOT NULL,
	"is_default" integer DEFAULT 0 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"credits_per_call" integer DEFAULT 1 NOT NULL,
	"capabilities_json" text DEFAULT '{}' NOT NULL,
	"discovered_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
DROP INDEX "idx_channels_type_order";--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "user_model_selection_enabled" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "models_fetched_at" bigint;--> statement-breakpoint
ALTER TABLE "channel_models" ADD CONSTRAINT "channel_models_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_channel_models_provider" ON "channel_models" USING btree ("channel_id","provider_model_id");--> statement-breakpoint
CREATE INDEX "idx_channel_models_channel_type_priority" ON "channel_models" USING btree ("channel_id","type","priority");--> statement-breakpoint
CREATE INDEX "idx_channels_type_priority_order" ON "channels" USING btree ("type","priority","sort_order");--> statement-breakpoint
-- 将现有 channels.text_model/image_model 迁移为已启用的默认目录项，保证升级后路由行为不变。
INSERT INTO "channel_models" (
  "id", "channel_id", "type", "provider_model_id", "display_name",
  "enabled", "is_default", "priority", "credits_per_call", "capabilities_json",
  "discovered_at", "last_seen_at", "created_at", "updated_at"
)
SELECT
  'cmodel_legacy_' || substr(md5(c."id" || ':' || c."type" || ':' || model_name), 1, 20),
  c."id",
  c."type",
  model_name,
  model_name,
  1,
  1,
  0,
  1,
  CASE
    WHEN c."type" = 'image' AND c."image_edit_support" = 1
      THEN '{"textToImage":true,"imageEditSingle":true,"imageEditMulti":true}'
    WHEN c."type" = 'image'
      THEN '{"textToImage":true}'
    ELSE '{}'
  END,
  c."created_at",
  c."updated_at",
  c."created_at",
  c."updated_at"
FROM "channels" AS c
CROSS JOIN LATERAL (
  SELECT CASE WHEN c."type" = 'text' THEN c."text_model" ELSE c."image_model" END AS model_name
) AS selected
WHERE selected.model_name IS NOT NULL AND btrim(selected.model_name) <> ''
ON CONFLICT ("channel_id", "provider_model_id") DO NOTHING;
