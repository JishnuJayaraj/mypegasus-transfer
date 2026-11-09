ALTER TYPE "public"."audit_event_type" ADD VALUE 'dsv_original_recorded';--> statement-breakpoint
CREATE TABLE "dsv_contract" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"dsv_offer_id" uuid NOT NULL,
	"participant_signed_on" date,
	"customer_signed_on" date,
	"tg_signed_on" date,
	"fully_executed_on" date,
	"participant_accepted_on" date,
	"fully_executed_accepted_on" date,
	"received_on" date,
	"received_by_role" text,
	"participant_accepted_by_role" text,
	"fully_executed_accepted_by_role" text,
	"original_location" text,
	"original_received_on" date,
	"sent_to_customer_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dsv_contract" ADD CONSTRAINT "dsv_contract_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsv_contract" ADD CONSTRAINT "dsv_contract_participation_id_participation_id_fk" FOREIGN KEY ("participation_id") REFERENCES "public"."participation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsv_contract" ADD CONSTRAINT "dsv_contract_dsv_offer_id_dsv_offer_id_fk" FOREIGN KEY ("dsv_offer_id") REFERENCES "public"."dsv_offer"("id") ON DELETE no action ON UPDATE no action;