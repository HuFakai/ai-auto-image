DROP INDEX "uq_users_provider_subject";--> statement-breakpoint
CREATE INDEX "idx_workflow_runs_user" ON "workflow_runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_provider_subject" ON "users" USING btree ("auth_provider","provider_subject");