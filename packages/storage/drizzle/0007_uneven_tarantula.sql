-- 旧字段只用于图片且历史默认可能为 1–16；升级为文本/图片通用渠道并发时统一重置为不限制。
UPDATE "channels" SET "image_concurrency_max" = 0;--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "image_concurrency_max" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "image_concurrency_max" SET NOT NULL;
