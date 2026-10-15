-- Hand-written: table grants for the runtime role (docs/plans/slice-0.md, section 5.3).
-- Only what a feature needs. No UPDATE/DELETE yet; Slice 1 adds status/audit grants the same way.
GRANT SELECT, INSERT ON TABLE "project" TO transfer_app;--> statement-breakpoint
GRANT SELECT ON TABLE "staff_user" TO transfer_app;
