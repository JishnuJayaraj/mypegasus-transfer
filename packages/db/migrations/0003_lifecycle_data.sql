-- Hand-written data migration (Slice 1 plan, section 5.10; AC-17, AC-20).

-- Slice 0 kept the contractual dates on the project. Each existing ta_tg project gets one wave W1
-- with those dates; latest_entry_date stays null, so the project is flagged
-- (latest_entry_date_missing) until the PL records it. The domain reads wave dates only; Slice 2
-- moves the project form to waves and drops the old columns.
INSERT INTO "project_entry_wave" ("project_id", "code", "name", "signing_deadline", "default_tg_start", "default_tg_end")
SELECT "id", 'W1', 'W1', "signing_deadline", "default_tg_start", "default_tg_end"
FROM "project"
WHERE "type" = 'ta_tg';
--> statement-breakpoint

-- The domain's edge list (packages/domain/src/lifecycle/edges.ts), read by the status functions.
-- A drift test keeps the two equal; change both together.
INSERT INTO "lifecycle_edge" ("track", "from_value", "to_value", "kind", "actors", "project_types") VALUES
  ('main', null, 'imported', 'manual', '{user}', null),
  ('main', null, 'self_registered', 'anonymous_self_registration', '{participant}', null),
  ('main', 'self_registered', 'imported', 'manual', '{user}', null),
  ('main', 'self_registered', 'rejected', 'manual', '{user}', null),
  ('main', 'self_registered', 'rejected', 'system', '{system}', null),
  ('main', 'imported', 'contacted', 'manual', '{user}', null),
  ('main', 'contacted', 'informed', 'manual', '{user}', null),
  ('main', 'contacted', 'unreachable', 'manual', '{user}', null),
  ('main', 'unreachable', 'contacted', 'manual', '{user}', null),
  ('main', 'informed', 'active_in_tg', 'scheduled_entry', '{system}', '{ta_tg}'),
  ('main', 'informed', 'active_in_tg', 'scheduled_entry_catchup', '{system}', '{ta_tg}'),
  ('main', 'informed', 'active_in_tg', 'reconciliation', '{user}', '{ta_tg}'),
  ('main', 'informed', 'ta_completed', 'manual', '{user}', '{ta_only}'),
  ('main', 'active_in_tg', 'exited', 'manual', '{user}', null),
  ('main', 'imported', 'withdrawn', 'manual', '{user}', null),
  ('main', 'imported', 'withdrawn', 'system', '{system}', null),
  ('main', 'contacted', 'withdrawn', 'manual', '{user}', null),
  ('main', 'contacted', 'withdrawn', 'system', '{system}', null),
  ('main', 'unreachable', 'withdrawn', 'manual', '{user}', null),
  ('main', 'unreachable', 'withdrawn', 'system', '{system}', null),
  ('main', 'informed', 'withdrawn', 'manual', '{user}', null),
  ('main', 'informed', 'withdrawn', 'system', '{system}', null),
  ('profiling', 'not_started', 'profiling_accepted', 'manual', '{user}', null),
  ('profiling', 'not_started', 'profiling_declined', 'manual', '{user}', null),
  ('profiling', 'profiling_accepted', 'profiling_in_progress', 'manual', '{user}', null),
  ('profiling', 'profiling_accepted', 'profiling_declined', 'manual', '{user}', null),
  ('profiling', 'profiling_in_progress', 'profiling_done', 'manual', '{user}', null),
  ('profiling', 'profiling_in_progress', 'profiling_declined', 'manual', '{user}', null),
  ('profiling', 'profiling_declined', 'profiling_accepted', 'manual', '{user}', null),
  ('dsv', 'not_offered', 'dsv_offered', 'manual', '{user}', null),
  ('dsv', 'dsv_offered', 'dsv_signed', 'manual', '{user}', null),
  ('dsv', 'dsv_offered', 'dsv_declined', 'manual', '{user}', null),
  ('dsv', 'dsv_offered', 'dsv_expired', 'system', '{system}', null),
  ('dsv', 'dsv_declined', 'dsv_offered', 'manual', '{user}', null),
  ('dsv', 'dsv_expired', 'dsv_offered', 'manual', '{user}', null);
