ALTER TABLE "credit_ledger" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "display_title" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "operator_user_id" text;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_operator_user_id_users_id_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_credit_ledger_run" ON "credit_ledger" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_orders_operator" ON "orders" USING btree ("operator_user_id","created_at");--> statement-breakpoint
-- 尽力把历史生图流水补齐到 Run 与作品标题；无法关联的历史记录保持为空。
UPDATE "credit_ledger" AS ledger
SET "run_id" = node."run_id",
    "display_title" = project."title"
FROM "node_runs" AS node
JOIN "workflow_runs" AS run ON run."id" = node."run_id"
JOIN "projects" AS project ON project."id" = run."project_id"
WHERE ledger."run_id" IS NULL
  AND ledger."ref_type" = 'workflow_node'
  AND ledger."ref_id" = node."id";--> statement-breakpoint
UPDATE "credit_ledger"
SET "display_title" = "note"
WHERE "display_title" IS NULL
  AND "reason" = 'admin_adjust'
  AND "note" IS NOT NULL;
