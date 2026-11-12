# Database: portal access

## Amendment 2026-10-20: no self-registration in the core (Slice 3, PR 3a)

Built in PR 3a (round 35): `main_status` loses `self_registered` and `rejected`, `edge_kind` loses
`anonymous_self_registration`, and `lifecycle_edge` their edges. Postgres can't drop an enum
value, so migration 0033 recreates both types: it drops every object that names them (the
participation and audit `CHECK`s, `lifecycle_edge_values_of_track`, the early-exit trigger,
`end_reason_fits`), converts the columns through `text` and recreates the objects unchanged; it
replaces `change_participation_status`, `set_participation_dates` and `revoke_profiling_exception`
(same signatures) without the `'rejected'` comparison, which would fail at run time. It refuses a
database holding a removed value. `participation_unmatched_has_no_wave` is gone.

## Amendment 2026-10-21: activation-code and notice evidence (Slice 3, PR 3d)

- `activation_code` holds an activation credential's keyed hash, channel and non-secret state;
  `privacy_notice_delivery` is immutable evidence of the exact Article 14 notice version,
  language, method and provision time. Both carry `project_id` and `participation_id`.
  `transfer_app` may select them for authorised projections but has no table-write privilege.
- Five `SECURITY DEFINER` functions own the writes: `issue_activation_code`,
  `record_activation_delivery`, `hand_over_activation_code`, `revoke_activation_code` and
  `record_privacy_notice`. They use the established fixed `search_path`, revoke execution from
  `PUBLIC`, grant it only to `transfer_app`, take the participation/project lock, repeat the
  issuance checks under that lock and write ID/code-only audit details in the same transaction.
- Batch issuance and notice-only letters lock participations in sorted UUID order and are all or
  nothing. The partial unique index permits at most one non-terminal code per participation; a
  conscious reissue revokes the prior code as `reissued` before inserting the replacement.
- A terminal main-status transition invokes an `AFTER UPDATE` trigger in the status transaction
  and revokes every open code as `participation_closed`. Notice rows reject update and delete for
  every role. Database time sets the 30-day code lifetime and every evidence timestamp.
- In-person delivery is a two-transaction protocol around the provider call: issuance commits as
  `pending`; the API sends with the code row id as its idempotency key; then
  `record_activation_delivery` records `sent`, `failed` or `unknown`. Only `sent` creates notice
  evidence, `failed` revokes the code, and `unknown` leaves it valid without claiming delivery.

## Amendment 2026-10-21: participant activation and sessions (Slice 3, PR 3e)

- New tables, each with `project_id`: `participant_account` (one per participation),
  `consent_record`, `participant_channel` (the normalised private address, unique per kind while
  not removed), `one_time_code_challenge` (a keyed hash and the address it went to, 15 minutes,
  5 wrong entries) and `participant_session` (a token's SHA-256, `activating` or `active`, the
  activation steps done, the step-up). `transfer_app` may select them and update
  `participant_session.last_seen_at` only.
- The status body moved into the internal `apply_status_change` (no grant), unchanged in
  behaviour but for the `activation` edge kind; `change_participation_status` keeps its signature,
  asserts `user` or `system` and delegates. `edge_kind` was recreated with `activation` (an
  `ADD VALUE` couldn't be used by the same migration transaction).
- Eight granted functions (`0042_participant_activation_functions.sql`): `start_activation`,
  `check_activation_birth_date`, `check_activation_delivery_address`, `create_one_time_code`,
  `record_one_time_code_delivery`, `complete_activation`, `end_participant_session`,
  `mark_activation_notice_sent`. They lock participation, then code, then session, and repeat
  every step rule under the locks. A counted failure (a wrong birth date or delivery address, a
  wrong one-time code) is **returned**, never raised, so its count commits; the fifth locks the
  code (`activation_code_locked`, actor `system`, job `portal-activation`) or ends the one-time
  code (`one_time_code_exhausted`). An unusable code returns `NULL` from `start_activation` and
  counts nothing.
- `create_one_time_code` serialises an address on a transaction advisory lock and counts its codes
  of the last hour (login and verification together). `complete_activation` writes the code's use,
  the consent, the channel, the account, the audit events and the status change, ends the
  activating sessions and starts the `active` one, all in one transaction; a refusal after the
  verification rolls the verification back too.
- `issue_activation_code` refuses an activated account (`already_activated`); the terminal-status
  trigger also ends the participation's sessions.

## Amendment 2026-10-21: portal login, channels and recovery (Slice 3, PR 3f)

- No new tables. `0043` adds the audit types `participant_login`, `contact_channel_removed`,
  `consent_ended`, `contact_channels_suspended` and the session end reasons `lost_access` and
  `no_channel`; `0044` adds the functions, with 0042's conventions.
- Six new granted functions: `request_login_code` (a live channel's address gets a `login`
  challenge, any other address `NULL` and nothing written), `record_login_code_delivery` (the
  send's outcome, no session needed), `start_participant_session` (the code sent to that address,
  an `active` session with its step-up, `participant_login`), `request_channel_code`,
  `add_participant_channel` (the verified channel with its own consent) and
  `remove_participant_channel` (consent ended `revoked`; the last one ends every session). Counted
  failures are returned as in 0042. The active-session functions lock through the internal
  `lock_active_session` (participation, then session).
- `issue_activation_code` gains `p_purpose` (`activation` by default). `recovery` needs an
  activated account (`not_activated`), skips the cutoff, and in the same transaction ends every
  session (`lost_access`) and suspends every live channel (`contact_channels_suspended`).
  `start_activation`, `create_one_time_code` and `complete_activation` accept a recovery code for
  an activated account; its completion removes the old channels and ends their consents with
  `lost_access_replaced`, writes no account and no status change, and audits a
  `participant_login`. `assert_channel_available` may ignore the participation's own old
  channels (a recovery only); `verify_one_time_code` may require the challenge's address (login).
  Both were dropped and recreated, so no overload remains.
