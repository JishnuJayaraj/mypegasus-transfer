-- Hand-written (Slice 2 plan, sections 5.2, 5.3 and 5.11; PR 2g): the saved import column mappings.
-- They hold no personal data (a keyed hash of a normalised header and a target, R7) and the plan
-- exempts them from an audited function (D2): the application role writes them itself, with no
-- DELETE (a mapping is replaced, never removed) and no TRUNCATE.
GRANT SELECT, INSERT, UPDATE ON TABLE import_column_mapping TO transfer_app;
