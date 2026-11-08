CREATE TABLE "dsv_scan_signature" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"participation_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"signed_on" date NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "dsv_offer_id" uuid;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "dsv_received_by" uuid;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "dsv_received_on" date;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "dsv_signatures" jsonb;--> statement-breakpoint
ALTER TABLE "dsv_scan_signature" ADD CONSTRAINT "dsv_scan_signature_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsv_scan_signature" ADD CONSTRAINT "dsv_scan_signature_participation_id_participation_id_fk" FOREIGN KEY ("participation_id") REFERENCES "public"."participation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsv_scan_signature" ADD CONSTRAINT "dsv_scan_signature_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_dsv_offer_id_dsv_offer_id_fk" FOREIGN KEY ("dsv_offer_id") REFERENCES "public"."dsv_offer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_dsv_received_by_staff_user_id_fk" FOREIGN KEY ("dsv_received_by") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;