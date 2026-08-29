ALTER TABLE "brand_kits" ADD COLUMN "brand_name" text;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN "slogan" text;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN "footer_signature" text;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN "watermark_text" text;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN "watermark_position" text DEFAULT 'corner' NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN "watermark_opacity" real DEFAULT 0.18 NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN "title_font" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN "palette_json" text;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD COLUMN "cover_layout" text DEFAULT 'default' NOT NULL;