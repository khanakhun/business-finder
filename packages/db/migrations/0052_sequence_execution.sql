ALTER TABLE "sequence_enrollments" ADD COLUMN "auto_send" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_outbound_messages__outreach_token" ON "outbound_messages" USING btree ("outreach_token");--> statement-breakpoint
CREATE INDEX "ix_outbound_messages__enrollment" ON "outbound_messages" USING btree ("sequence_enrollment_id");