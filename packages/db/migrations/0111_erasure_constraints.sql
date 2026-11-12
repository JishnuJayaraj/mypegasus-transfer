-- Erasure must delete cycles of participation records in one transaction (ADR-0008;
-- data-protection.md, retention and deletion). Ordinary writes still check these FKs immediately;
-- the retention transaction explicitly defers them while removing the complete cycle.
ALTER TABLE public.form_generation ALTER CONSTRAINT form_generation_document_id_document_id_fk DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint
ALTER TABLE public.document ALTER CONSTRAINT document_invalidated_by_correction_evidence_correction_id_fk DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint
ALTER TABLE public.evidence_correction ALTER CONSTRAINT evidence_correction_asu_registration_id_asu_registration_id_fk DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint
ALTER TABLE public.evidence_correction ALTER CONSTRAINT evidence_correction_ba_reporting_task_id_ba_reporting_task_id_f DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint
ALTER TABLE public.participation ALTER CONSTRAINT participation_current_exception_request_fk DEFERRABLE INITIALLY IMMEDIATE;
