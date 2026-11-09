ALTER TYPE "public"."audit_event_type" ADD VALUE 'dsv_customer_notified';--> statement-breakpoint
CREATE TABLE "dsv_customer_notice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"notified_on" date NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dsv_customer_notice_once" UNIQUE("participation_id")
);
--> statement-breakpoint
ALTER TABLE "dsv_customer_notice" ADD CONSTRAINT "dsv_customer_notice_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsv_customer_notice" ADD CONSTRAINT "dsv_customer_notice_participation_id_participation_id_fk" FOREIGN KEY ("participation_id") REFERENCES "public"."participation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsv_customer_notice" ADD CONSTRAINT "dsv_customer_notice_recorded_by_staff_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsv_customer_notice" ADD CONSTRAINT "dsv_customer_notice_participation_project_fk" FOREIGN KEY ("participation_id","project_id") REFERENCES "public"."participation"("id","project_id") ON DELETE no action ON UPDATE no action;