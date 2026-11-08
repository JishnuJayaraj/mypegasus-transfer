CREATE TABLE "dsv_offer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"generation_id" uuid,
	"origin" text NOT NULL,
	"template_version" text NOT NULL,
	"offer_deadline" date NOT NULL,
	"printed_tg_start" date NOT NULL,
	"printed_tg_end" date NOT NULL,
	"offered_by" uuid NOT NULL,
	"offered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_event_id" uuid,
	"ended_as" text,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "dsv_offer" ADD CONSTRAINT "dsv_offer_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsv_offer" ADD CONSTRAINT "dsv_offer_participation_id_participation_id_fk" FOREIGN KEY ("participation_id") REFERENCES "public"."participation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsv_offer" ADD CONSTRAINT "dsv_offer_generation_id_form_generation_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."form_generation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsv_offer" ADD CONSTRAINT "dsv_offer_offered_by_staff_user_id_fk" FOREIGN KEY ("offered_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;