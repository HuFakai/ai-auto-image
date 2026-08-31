ALTER TABLE "wallets" ADD COLUMN "reserved_credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "credits_reserved" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "credits_charged" integer DEFAULT 0 NOT NULL;