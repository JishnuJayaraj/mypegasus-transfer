# Slice 3 — Auth & roles: plan

Status: approved 2026-10-20 ([round 36](../decisions/2026-10-20-answers-round-36.md)). Scope:
[roadmap](../roadmap.md) Slice 3, [ADR-0007](../adr/0007-auth.md) with its 2026-10-20 amendment,
[round 35](../decisions/2026-10-20-answers-round-35.md) (Q112–Q120) and round 36 (Q121–Q130).

## Decisions

**Staff login**
- D1. **One server-side session store for both login modes.** `AUTH_MODE=oidc` (authorization
  code flow with PKCE, `state` and `nonce`, `openid-client`) and the dev stub (`AUTH_MODE=dev`,
  user switcher) both create a `staff_session` row; nothing else differs after login. The Slice 0
  signed cookie goes.
- D2. **Session tokens:** 32 random bytes in the cookie; the table keeps only their SHA-256, so a
  database read gives no live session. A new token at every login (no fixation). Staff: 8 hours
  absolute, no sliding (ADR-0007). Logout and deactivation end the row.
- D3. **Cookies:** `__Host-tp_staff` and `__Host-tp_portal` (`Secure`, `HttpOnly`, `SameSite=Lax`,
  `Path=/`) outside development; `tp_staff`/`tp_portal` over plain http in development. Staff
  routes read only the staff cookie, portal routes only the portal cookie. Web and portal stay on
  one origin in Slice 3 (separate hostnames are Slice 9, overview.md).
- D4. **CSRF:** every unsafe method (`POST`, `PUT`, `PATCH`, `DELETE`) on `/api/*` needs an
  `Origin` in `APP_ORIGINS`, or without `Origin` a `Sec-Fetch-Site: same-origin`; else 403
  `csrf_origin`. This replaces Hono's `csrf()` (which checks only form content types). With
  JSON-only bodies (415), no CORS and `SameSite=Lax`, there is no token scheme.
- D5. **Binding an Entra account:** staff accounts are created in the app by an admin (Q7, Q126).
  The first OIDC login of an active, unbound account whose email matches the `email` claim (else
  `preferred_username`), case-insensitively, binds `(iss, sub)` to it (audited); later logins
  match `(iss, sub)` only. Unknown, deactivated or differently bound accounts are refused with a
  code. MFA stays the IdP's (Conditional Access, Q7); the app does not check `amr`.
- D6. **Staff login audit** goes to a new `staff_audit_event` table (no `project_id`, so not
  `audit_event`): logins, logouts, refused logins (code only, never the claimed email), identity
  bindings, account and org-role changes.

**Org model (deferred from Slice 2; Q126)**
- D7. **Regions:** a `region` table (Niederlassung, Q35) and `project.region_id`. The creator
  chooses the region of a new project; its PL changes it only while draft, a global admin at any
  time. Org roles become region-scoped: `staff_org_role` rows (`admin` global, `regional_admin`
  and `regional_operations_manager` per region). A project without a region is seen only by global
  roles. `PermissionTarget.regionId` is the project's region from now on.
- D8. **The flat `staff_user.role` goes.** Today's flat `project_lead` becomes
  `staff_user.may_create_projects`; a project's creator becomes its first PL. Only a global admin
  creates and deactivates accounts, grants org roles and sets the flag. The migration maps `admin`
  to a global org role and `project_lead` to the flag; flat regional roles get no org role (no
  region is known; the seed grants them).
- D9. **Memberships:** the project's PL adds and removes members and their project roles. A global
  admin may add a replacement PL (never themselves, so they gain no case access). Regional admins
  don't manage teams in Slice 3. The last active PL can't be removed (`last_project_lead`).
  Removing the `consultant` role ends that person's assignments in the project.
- D10. **Participant assignments (Q62):** the PL assigns participations to members holding
  `consultant` in the project, zero or more per participation; rows are closed, never deleted.
  `staffSubjectOf` loads the open ones into `assignedParticipationIds`. Back office needs no
  assignment: "assigned back office" (Q118) is a back-office member of the project.
- D11. **Deactivating a staff account** (global admin): refused while they are the last active PL
  of a project; ends their sessions, memberships and assignments in one transaction (Q59
  unchanged: never deleted).

**Activation codes (rounds 35 and 36)**
- D12. **Format:** 12 characters of Crockford base32 (no I, L, O, U; about 60 bits), printed
  `XXXX-XXXX-XXXX`. Input is normalised: upper case, spaces and hyphens dropped, O→0, I/L→1.
- D13. **Generated in the request that issues it** (`crypto.randomBytes`), never at import, never
  stored: the row keeps an HMAC under a key derived from a separate `ACCESS_CODE_SECRET` with
  HKDF, one context each for activation codes (`activation-code:v1`), delivery addresses
  (`delivery-address:v1`) and one-time codes (`one-time-code:v1`). Rotating it invalidates open
  codes and challenges (reissue), never sessions.
- D14. **Validity and failures (Q118, Q128):** 30 days from issuance (database time); the fifth
  failure locks atomically under the row lock. A failure is a well-formed wrong birth date for a
  valid open code, or, for an `in_person` code, a wrong normalised delivery address. Syntax errors
  don't count; unknown, expired, revoked, used or locked codes count nothing and get a generic
  answer. Every code submission passes a per-IP throttle (10 per 15 minutes); in memory in Slice 3,
  a shared limiter is a pre-pilot item before a multi-process deployment with real data.
- D15. **Issuance channels, the PL's choice per participant (Q120, Q127):**
  - `letter`: batch-printed to the imported address; needs the address and a birth date (Q113).
    Assurance: possession of the code plus the birth-date check.
  - `sheet`: printed (`printed`), then **handed over** at the event after staff inspected an
    original official photo ID against the imported identity (`handed_over`, audited with
    confirmer, time and method; no ID number, copy or image). Only a handed-over sheet can be
    activated; sheets not handed over are revoked (`not_handed_over`).
  - `in_person`: the same photo-ID check, recorded at issuance; the PL types a private email or
    mobile, the server sends the link there and keeps only the address's keyed hash. The address
    is never returned, logged or audited; the response never contains the code.
- D16. **Who issues and when:** the PL or a back-office member of the project
  (`issueActivationCode`, `recordHandover`, `revokeActivationCode`, `providePrivacyNotice`); never
  a consultant, admin or participant; no anonymous or self-service path (Q118). Only in an `active`
  project, never for a terminal participation, and for a participation still in `imported`,
  `contacted` or `unreachable` only while `before_cutoff` holds (Q121).
- D17. **One open code per participation.** A new issuance revokes the open one (`reissued`) and
  needs `replaceOpenCode: true` when one is open (`open_code_exists`), so a reprint is a conscious
  reissue. Revocation without a new code: `not_handed_over`, `lost`. An activated account gets a
  code only through the lost-access recovery (D24).
- D18. **The Art. 14 notice is supplied at issuance (Q114, Q124):** the letter and the sheet
  contain it; the first `in_person` message carries a durable link to the versioned notice page
  (`<PORTAL_PUBLIC_URL>notice/art14/<version>`, public, no personal data). Each delivery is a
  `privacy_notice_delivery` row: version, language, method (`letter`, `sheet`, `email`, `sms`,
  `in_person_print`), time sent or handed over, by whom. The portal repeats the notice at
  activation and records the version shown, never as the first delivery. German and English
  variants for every format; German by default, the PL chooses per issuance. Controller and DPO
  contact details come from `packages/config` (`organisation.json`, synthetic in dev). Final
  wording: external DPO review before real data.
- D19. **Notice deadline (Q124):** due on the participation's creation date (the day the data was
  received, Berlin) plus one calendar month (month end clamped), and in any case before the first
  communication, which in Slice 3 is always an issuance that carries the notice. The PL sees
  `provided`, `due` (with the date) or `overdue` per participation, and can provide the notice
  without a code (notice-only letter, or handed over in person) for people who get no code yet.

**Delivery of messages**
- D20. **External sends are never inside a transaction (round 36, correction 3).** A message with
  a secret (activation link, one-time code) is sent synchronously in the request because the
  secret exists only in memory: commit the code or challenge as `pending`, send with the row id as
  the provider's idempotency key, then record the outcome: `sent`, or on a definitive failure
  revoke the code / invalidate the challenge (`503 delivery_failed`). When the outcome is unknown
  (timeout, response lost), the row becomes `delivery_unknown` and stays valid: only the intended
  address can hold the secret. The PL sees "Zustellung unklar" and may revoke and reissue; the
  participant may request a new one-time code.
- D21. **Notices without a secret** (the activation notice) go through a pg-boss job,
  **at least once** (correction 4): payload `{ channelId }`, `singletonKey` the channel id, the
  provider idempotency key `activation-notice:<channelId>` where supported, `notice_sent_at`
  recorded after the send.

**Activation, one-time codes, participant sessions**
- D22. **The code arrives in the link's fragment** (`<PORTAL_PUBLIC_URL>activate#<code>`). The
  page moves it into memory, removes it with `history.replaceState` and posts it only on the
  participant's click. Codes, one-time codes and addresses never appear in a URL the server sees.
- D23. **Steps:** code → notice (repeated) → birth date (skipped only for a handed-over sheet or an
  `in_person` code whose participation has no birth date, Q129) → for an `in_person` code, retype
  the delivery address (a mismatch is a failure, D14; a match with link possession verifies that
  channel) → for any other channel, an email or mobile with consent and a one-time code to it →
  done. One transaction completes it: code `used`, account with its identity-assurance record,
  channel, consent record, the status change, the audit events; the session becomes `active` with
  a new token.
- D24. **Lost access (Q130), a `recovery` code:** after staff verify the person, issuing it ends
  all participant sessions and suspends every old channel for login and notifications at once.
  Completing it replaces the channels; the old consents end with `lost_access_replaced`. If it
  expires, the old channels stay suspended and assisted recovery remains. No status change.
- D25. **The status change (Q116, Q121):** `complete_activation` calls the ungranted internal
  status primitive with new edges `imported → contacted` and `unreachable → contacted` of kind
  `activation`, actor `participant`. A first activation in `imported`, `contacted` or
  `unreachable` needs `before_cutoff`, checked again with database time at completion; a failure
  refuses it (`before_cutoff`). In `informed` or `active_in_tg` it activates after the cutoff with
  no status change. The granted `change_participation_status` keeps refusing participant actors.
- D26. **Terminal participations (Q121):** a transition to a terminal status revokes open codes
  (`participation_closed`) and ends the participant's sessions in the same transaction; no
  issuance, activation or login afterwards.
- D27. **One-time codes:** 6 digits, single-use, 15 minutes, at most 5 per address per hour (login
  and channel verification together), their own counter of 5 wrong entries. The email carries the
  code and a link with it in the fragment; the page logs in only on a click (no login on a bare
  GET). The login request answers `202` whether or not the address exists.
- D28. **Channels (Q112, Q117, Q119, Q123, Q125):** at least one verified private email or mobile
  per activated account, chosen by the participant, each with its own consent record (purpose
  `portal_contact`: login and versioned portal notifications; text versioned, de/en). One
  normalised address belongs to at most one active account; a collision is the generic
  `channel_in_use` after authentication, never naming the other account. Never the imported work
  email; the import never writes channels (Q112 by construction). The participant adds and removes
  channels; removing one revokes its consent; removing the last ends the session. Staff see kind,
  verification and consent state and dates, never the address.
- D29. **Participant sessions:** 30 minutes idle, 12 hours absolute (`last_seen_at` written at
  most once a minute). An `activating` session (code accepted, not finished) lives 30 minutes idle
  and opens only the activation steps. **Identity assurance (correction 6):** the account records
  how the identity was assured at activation (`birth_date` or `photo_id`, with confirmer and time
  for `photo_id`); the session records step-ups (`birth_date`, `one_time_code`) with their time.
  The step-up before special-category data comes with the first such field (Slice 4a); until then
  participants activated by `photo_id` see none (Q129).

**Lifecycle core**
- D30. **`self_registered` and `rejected` leave the core** in their own PR (3a): enum values,
  edges, the `anonymous_self_registration` edge kind and permission denial, the `CHECK`s, the
  generated table. The migration recreates the enum types and refuses if any row holds a removed
  value.

## PRs

One planned PR = one branch = one PR, each in its own session. 3a and 3b start from `main` in
parallel and merge one after the other (the second renumbers its migration if both took the same
number); each later PR starts from `main` once its predecessor merged. Estimates are changed lines
without tests and generated files: guidance, not a ceiling; a PR stays cohesive.

| PR | Content | After | Estimate |
|---|---|---|---|
| 3a | Remove `self_registered`, `rejected` and the anonymous edge kind (D30) | — | ~300 |
| 3b | Staff sessions, OIDC + dev stub, CSRF, `staff_audit_event`, web login/logout (D1–D6) | — | ~1,100 |
| 3c | Regions, org roles, staff accounts, memberships, assignments, admin and team UI (D7–D11) | 3b | ~1,450 |
| 3d | Activation codes: issuance (three channels), sheet handover, revoke, delivery outcome, Art. 14 notice delivery and deadline, notice catalog, Mailer/SmsSender mocks, terminal revocation, PL status and print views (D12–D20, D26 codes) | 3c | ~1,750 |
| 3e | Portal activation: participant sessions, one-time codes for verification, `complete_activation` and the status edges, activation UI, notice job (D21–D23, D25, D26 sessions, D28, D29) | 3d | ~1,400 |
| 3f | Portal login with one-time code, logout, channel management and consent revocation, lost-access recovery (D24, D27) | 3e | ~1,100 |

## Design

### Data model

New tables (data catalog: `dataClass`, `retentionClass`, `holdsParticipantData`; the access
category is the field catalog's for what staff may read; hashes and addresses are never served to
staff):

| Table | PR | Columns (short) | dataClass | accessCategory | retentionClass |
|---|---|---|---|---|---|
| `staff_session` | 3b | `token_hash` PK, `staff_user_id`, `created_at`, `expires_at`, `ended_at`, `end_reason` (`logout`, `deactivated`, `superseded`) | internal | — (staff) | `access_credential` |
| `staff_audit_event` | 3b | `seq`, `event_type`, `actor_staff_user_id`, `subject_staff_user_id`, `reason_code`, `details` (ids/codes), `occurred_at`, `request_id` | internal | — (staff) | `audit_log` |
| `region` | 3c | `id`, `code`, `name`, `created_at` | internal | — | `reference_data` |
| `staff_org_role` | 3c | `staff_user_id`, `role`, `region_id` (null only for `admin`), `granted_by`, `granted_at` | internal | — (staff) | `staff_account` |
| `participant_assignment` | 3c | `id`, `project_id`, `participation_id`, `staff_user_id`, `assigned_by/at`, `ended_by/at`, `end_reason` | internal | `case_internal` | `participation_record` |
| `activation_code` | 3d | `id`, `project_id`, `participation_id`, `purpose` (`activation`, `recovery`), `code_hash` (unique), `channel`, `notice_language`, `identity_check` (`none`, `photo_id`) with `identity_checked_by/at`, `printed_at`, `handed_over_by/at` (sheet), `delivery_kind`, `delivery_address_hash`, `delivery_status` (`pending`, `sent`, `failed`, `unknown`), `issued_by/at`, `expires_at`, `failed_attempts`, `locked_at`, `revoked_by/at`, `revoke_reason`, `used_at` | confidential | `case_internal` (status, dates, kinds); hashes never served | `access_credential` |
| `privacy_notice_delivery` | 3d | `id`, `project_id`, `participation_id`, `notice_version`, `language`, `method`, `activation_code_id`, `provided_by`, `provided_at` | internal | `case_internal` | `personnel_file` |
| `participant_account` | 3e | `participation_id` PK, `project_id`, `activated_at`, `activation_code_id`, `identity_assurance` (`birth_date`, `photo_id`), `identity_assured_by/at`, `language` | internal | `case_internal` | `personnel_file` |
| `participant_channel` | 3e | `id`, `project_id`, `participation_id`, `kind` (`email`, `sms`), `address` (normalised), `verified_at`, `verified_by` (`one_time_code`, `activation_link`), `consent_id`, `notice_sent_at`, `suspended_at`, `suspension_reason`, `removed_at`, `removed_reason` (`consent_revoked`, `lost_access_replaced`); unique `(kind, address)` while not removed | confidential | `confidential`, not listable; staff see kind, state and dates only | `personnel_file` (the address and hash erased 30 days after removal, Q122) |
| `consent_record` | 3e | `id`, `project_id`, `participation_id`, `purpose` (`portal_contact`), `channel_id`, `text_version`, `language`, `given_at`, `ended_at`, `end_reason` (`revoked`, `lost_access_replaced`), actor | confidential | `confidential` | `personnel_file` |
| `one_time_code_challenge` | 3e | `id`, `project_id`, `participation_id`, `purpose` (`login`, `channel_verification`), `kind`, `address` (normalised), `code_hash`, `delivery_status`, `created_at`, `expires_at`, `failed_attempts`, `consumed_at` | confidential | never served | `access_credential` |
| `participant_session` | 3e | `token_hash` PK, `project_id`, `participation_id`, `state` (`activating`, `active`), `activation_code_id`, `created_at`, `last_seen_at`, `ended_at`, `end_reason`, `step_up_method`, `step_up_at` | internal | never served to staff | `access_credential` |

Changed: `staff_user` (3b: `oidc_issuer`, `oidc_subject`, unique together, and `deactivated_at`,
which the 3b login refuses and 3c's `deactivate_staff_user` sets; a unique index on `lower(email)`;
3c: `may_create_projects`, drop `role`); `project` (3c: `region_id`); the
`main_status` and `edge_kind` enums (3a: values removed; 3e: `activation` added). The new class
`access_credential` (Q122: deleted or stripped of hashes and addresses 30 days after use, expiry,
lock, revocation or end; a legal hold never keeps a secret usable) is `unset` in
`retentionPeriods` like the others until Slice 7. Field catalog: `activationStatus` and
`privacyNoticeState` (internal, `case_internal`, listable), `portalChannels` (confidential,
`confidential`, self-service, not listable, `personnel_file`).

### Database functions and grants

All `SECURITY DEFINER`, owned by `transfer_owner`, fixed `search_path`, `EXECUTE` to
`transfer_app` only, `P0001` codes, audit event in the same transaction, ADR-0002 conventions.
`transfer_app` gets `SELECT` on the new tables and no `INSERT`/`UPDATE`/`DELETE`, except
`UPDATE (last_seen_at)` on `participant_session` (D29).

| PR | Functions |
|---|---|
| 3a | the enum recreation; `change_participation_status` and the helpers whose signatures name the types recreated unchanged in behaviour |
| 3b | `start_staff_session`, `end_staff_session`, `bind_staff_identity`, `record_staff_login_refused` |
| 3c | `create_region`, `update_region`, `create_staff_user`, `update_staff_user`, `deactivate_staff_user`, `grant_org_role`, `revoke_org_role`, `add_project_member`, `remove_project_member`, `assign_participations`, `unassign_participation`; `create_project` and `update_project` replaced with a region parameter |
| 3d | `issue_activation_code` (locks the participation, revokes the open code, re-checks D15–D17, writes the notice delivery for letter and in-person), `record_activation_delivery` (outcome; a failure revokes), `hand_over_activation_code` (writes the sheet's notice delivery), `revoke_activation_code`, `record_privacy_notice`; an `AFTER UPDATE OF status` trigger revoking open codes at a terminal status |
| 3e | the status body moves into the internal `apply_status_change` (no grant); `change_participation_status` keeps its signature and refuses `participant`; `start_activation`, `check_activation_birth_date`, `check_activation_delivery_address` (both count and lock under the row lock), `create_one_time_code` (per-address advisory lock, 5/hour), `record_one_time_code_delivery`, `verify_one_time_code`, `complete_activation`, `end_participant_session`, `mark_activation_notice_sent`; the terminal trigger also ends sessions |
| 3f | `start_participant_session`, `add_participant_channel`, `remove_participant_channel`, `issue_activation_code` with purpose `recovery` (ends sessions, suspends channels) |

Audit event types (`audit_event`, codes and ids only): `activation_code_issued` (code id, purpose,
channel, identity check, delivery kind, notice version and language), `activation_code_delivery`
(outcome), `activation_code_handed_over`, `activation_code_revoked`, `activation_code_locked`
(actor `system`, job `portal-activation`), `privacy_notice_provided`, `participant_activated`,
`consent_given`, `consent_ended`, `contact_channel_added`, `contact_channel_removed`,
`contact_channels_suspended`, `participant_login`, `participant_logout`,
`one_time_code_exhausted`, `project_member_added`, `project_member_removed`,
`participant_assigned`, `participant_unassigned`; plus `status_changed` with actor `participant`
(D25). `staff_audit_event` types: `staff_login`, `staff_logout`, `staff_login_refused`,
`staff_identity_bound`, `staff_account_created`, `staff_account_changed`,
`staff_account_deactivated`, `org_role_granted`, `org_role_revoked`, `region_created`,
`region_changed`. The audit Zod model and the `CHECK`s grow with each PR.

### Domain (`packages/domain`, tests first, 100 % coverage)

- `lifecycle`: 3a removes the values, edges and the denial; 3e adds the `activation` edges.
  `mayPerformTransition`: a participant takes exactly the `activation` edges of their own
  participation.
- `access/permissions`: operations `issueActivationCode`, `recordHandover`,
  `revokeActivationCode`, `providePrivacyNotice` (PL, back office), `manageMembers`,
  `assignParticipations` (PL; a global admin adds a replacement PL, never themselves),
  `setProjectRegion` (PL while draft, global admin); org administration
  `mayAdminister(subject, "staff" | "regions")` (global admin).
- `activation/code.ts`: alphabet, format, normalise. `activation/issuance.ts`:
  `issuanceRefusals(...)` → `participation_closed`, `project_not_active`, `birth_date_required`,
  `address_required`, `identity_not_checked`, `before_cutoff`, `open_code_exists`,
  `already_activated`. `activation/status.ts`: `activationStatus` → `{ account: activated |
  not_activated, code: none | printed | open | delivery_unknown | expired | locked | revoked | used
  }` with dates. `activation/steps.ts`: the step machine of D23.
- `privacy/notice-state.ts`: `privacyNoticeState(receivedOn, deliveries, today)` → `provided`,
  `due` (date), `overdue` (D19, calendar month with month-end clamping).
- `portal/contact.ts`: email and mobile normalisation (German national numbers to `+49`, else
  E.164 with `+`). `portal/limits.ts`: the constants of D14, D27, D29 (a drift test holds the SQL
  to them).
- `notices/`: catalog of `art14-activation:v1` and `portal-contact-consent:v1`, each de and en, with
  each text's SHA-256; a released text never changes (test, like the template manifest).

### Adapters (`packages/adapters`, ADR-0006)

- `Mailer.send({ to, subject, text, idempotencyKey })` and `SmsSender.send({ to, text,
  idempotencyKey })` → `sent`, `failed` (definitive) or throws (unknown). Mocks keep the last 100
  messages in memory, deduplicate by key and log only a message id; a test switch makes them fail
  or time out. `MAIL_ADAPTER` and `SMS_ADAPTER` accept `mock` only until a provider (with AVV) is
  chosen.
- Dev only (`AUTH_MODE=dev`, refused in production): `GET /api/v1/dev/outbox` lists the mock
  messages, for development and e2e.
- No adapter for OIDC (ADR-0006).

### API (`/api/v1`, ADR-0010)

| PR | Routes |
|---|---|
| 3b | `GET /auth/login` (302 to the IdP; `tp_oidc` signed cookie with state, nonce, verifier, return path, 10 minutes), `GET /auth/callback`, `POST /auth/logout`, `GET /me` (+ `sessionExpiresAt`); dev `POST/DELETE /dev/session` on the session store |
| 3c | `GET/POST /regions`, `PATCH /regions/{id}`; `GET/POST /staff-users`, `PATCH /staff-users/{id}`, `POST /staff-users/{id}/deactivation`, `PUT /staff-users/{id}/org-roles`; `GET /staff-directory?search=` (id and name of active staff, for member pickers); `GET/POST /projects/{id}/members`, `DELETE /projects/{id}/members/{staffUserId}/{role}`; `POST /projects/{id}/assignments` (bulk, ≤ 500), `DELETE /participations/{id}/assignments/{staffUserId}`; `regionId` on project create/update |
| 3d | `POST /projects/{id}/activation-codes` (`letter` or `sheet`, language, ≤ 500 participations, all or nothing; `201` with the codes and print data, `Cache-Control: no-store`), `POST /participations/{id}/activation-codes/handover`, `POST /participations/{id}/activation-codes/in-person` (no code in the response), `POST /participations/{id}/activation-codes/revocation`, `GET /participations/{id}/activation`; `POST /projects/{id}/privacy-notices` (notice-only letters), `POST /participations/{id}/privacy-notices` (handed over); `activationStatus` and `privacyNoticeState` in list items (filterable) and the detail, with capabilities |
| 3e | `POST /portal/activation` (code), `POST /portal/activation/birth-date`, `POST /portal/activation/delivery-address`, `POST /portal/activation/channel`, `POST /portal/activation/completion`, `GET /portal/me`, `POST /portal/logout` |
| 3f | `POST /portal/login/code-request` (`202` always), `POST /portal/login`, `GET/POST /portal/channels`, `POST /portal/channels/verification`, `DELETE /portal/channels/{id}`; `POST /participations/{id}/activation-codes` with purpose `recovery` |

New problem codes (422 unless noted): `csrf_origin` (403), `unknown_account`,
`account_deactivated`, `identity_mismatch`, `last_project_lead`, `not_consultant`,
`region_required`, the issuance refusals above, `code_invalid` (the one generic answer for an
unknown, expired, revoked, used or locked code), `knowledge_check_failed`, `one_time_code_invalid`,
`rate_limited` (429, a new problem type `too-many-requests`, with `Retry-After`),
`channel_in_use`, `channel_invalid`, `delivery_failed` (503). Portal routes never say whether an
address exists. Logs: the portal request line carries `participationId` (an id), never an address,
code or token.

Environment (`.env.example`): `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (secret
store), `OIDC_REDIRECT_URL`; `ACCESS_CODE_SECRET` (≥ 32 characters, required outside
development, a fixed dev value otherwise so a watch restart keeps printed dev codes);
`PORTAL_PUBLIC_URL` (required outside development).

### Web (`apps/web`, de)

- 3b: login page (`oidc`: "Anmelden" to `/auth/login`; `dev`: the user switcher), the user and
  "Abmelden" in the header, a 401 anywhere returns to the login page with "Sitzung abgelaufen".
- 3c: `/admin/staff` and `/admin/regions` (global admin only); project "Team" tab (members, roles,
  add and remove); region on project create and setup; participants list: assigned consultants
  column, bulk "Zuweisen"; detail: assignments.
- 3d: participants list: activation and notice state columns and filters, row selection, bulk
  "Aktivierungsbriefe drucken", "Aktivierungsblätter drucken", "Datenschutzhinweis drucken"
  (language de/en, capability per row, a confirmation for reissues); an event hand-out view
  listing printed sheets with "Ausweis geprüft, übergeben" per person and "nicht übergebene
  widerrufen"; detail: activation panel (status, channel, delivery, dates, issuer, attempts left,
  "Persönlich senden" after the ID-check confirmation, "Code widerrufen", "Neu ausstellen") and
  notice state; print views for the letter (DIN 5008 window address), the sheet and the
  notice-only letter, with the notice text, the grouped code, its expiry and a QR of the link
  (client-side QR library, pinned). Codes live only in the mutation result; leaving the print view
  drops them.

### Portal (`apps/portal`, de + en, mobile-first, RTL-ready)

- 3d: `/notice/art14/<version>`: the public notice page (de/en), no API call, no personal data.
- 3e: `/activate` (fragment handling, notice, birth date `TT.MM.JJJJ` or the delivery address,
  channel choice with the consent text, one-time code, done), `/` (logged in: greeting,
  channels); an expired or idle session returns to `/login` (3f) or the activation start.
- 3f: `/login` (address → code; the email link pre-fills the code from the fragment and waits for
  the click), `/channels` (add with verification and consent, remove with a warning for the last
  one), "Abmelden".

### Jobs (ADR-0011)

- `portal.activation-notice` (3e): `exclusive` queue, D21, logs ids and outcome only.

### Docs each PR updates

ADR-0007 (as built), ADR-0002 (functions, grants), ADR-0006 (Mailer, SmsSender, idempotency,
dev outbox; SMS no longer "primary"), ADR-0010 (cookies, CSRF, problem codes), data-protection.md
(Authentication, the retention-class table, the new tables), process-and-lifecycle.md (3a removal,
3e activation edges, the generated transitions table), overview.md, `.env.example`, the pre-pilot
checklist (shared rate limiter, D14); 3f moves this plan to `docs/plans/archive/` and marks Slice 3
done in the roadmap.

## User flows

1. **Staff login.** Unauthenticated → login page → Entra (MFA by Conditional Access) → callback:
   first login binds the account, a session starts (8 h), `staff_login`. Unknown account → "Kein
   Zugang" page, `staff_login_refused`. Dev: the switcher does the same against the store.
2. **PL issues letters.** Participants list → filter "nicht aktiviert" → select → "Aktivierungs-
   briefe drucken", language → rows with an open code need the reissue confirmation; rows without
   address or birth date, or past the cutoff, are refused with their code → print view → print →
   the PL posts them (Q115). Every code: `activation_code_issued` and `privacy_notice_provided`.
3. **PL issues sheets** for an info event: print the sheets (`printed`, not yet activatable) → at
   the event, for each person, inspect the original photo ID against the imported name and birth
   date → "Ausweis geprüft, übergeben" (`activation_code_handed_over`, notice provided) → after
   the event "nicht übergebene widerrufen".
4. **PL issues in person:** detail → "Persönlich senden" → confirm the photo-ID check → email or
   mobile typed, language → the code is committed `pending`, the link and the notice link are
   sent, the outcome recorded; the PL sees "an E-Mail gesendet" (or "Zustellung unklar", or the
   failure), never the code and, later, never the address.
5. **Participant activates:** opens the link or scans the QR (or types the code on `/activate`) →
   notice → birth date (or, without one, nothing after the ID check) → `in_person`: retypes the
   address the link came to; else chooses email or mobile, consents, types the one-time code →
   "Ihr Zugang ist aktiv" → status `contacted` if it was `imported`/`unreachable` → the activation
   notice arrives on that channel.
6. **Participant logs in:** `/login` → address → code by email or SMS (15 min) → typed, or the
   email link opened and "Anmelden" clicked → session (30 min idle, 12 h). Wrong code 5× → a new
   code is needed; more than 5 requests an hour → "Bitte später erneut".
7. **PL reissues before activation:** letter lost or code expired → identity verified → "Neu
   ausstellen" with any channel → the old code is revoked.
8. **Lost access after activation:** the participant contacts the PL → identity verified →
   recovery code by any channel → at once all sessions end and the old channels are suspended →
   the participant completes it and registers channels again; if it expires, the old channels stay
   suspended.
9. **Code locked or expired:** the participant sees the generic "Dieser Code ist nicht gültig"
   with the TG contact; the PL sees "gesperrt" (5 failures) or "abgelaufen" and reissues.
10. **Notice due or overdue:** the list shows "Datenschutzhinweis fällig bis TT.MM.JJJJ" or
    "überfällig" → the PL issues codes (letters) or prints notice-only letters, or hands the
    notice over in person and records it.
11. **Assisted mode:** without a birth date the PL issues only a sheet or in person, after the
    photo-ID check (Q113, Q129); a person without a private email or mobile, or unwilling to
    register one, isn't activated (Q117): the PL records `contacted` by hand as today, and staff
    enter data on their behalf with `onBehalfOf` from Slice 4a.
12. **PL manages the team:** Team tab → add a consultant → assign participations in the list;
    consultants then see exactly those participations.

## Acceptance criteria

**3a**
- No `self_registered`, `rejected` or `anonymous_self_registration` in domain, database, API
  document, generated docs or UI; the migration fails on a database holding them; drift tests
  green.

**3b**
- Both modes create, read and end `staff_session` rows; the cookie holds a token whose SHA-256 is
  the row key; a session older than 8 h is a 401; logout ends it; a new token at every login.
- OIDC against a test issuer: state, nonce and PKCE checked; first login binds by email, later
  ones match `(iss, sub)` only; unknown, deactivated and differently bound accounts are refused
  with their code and a `staff_login_refused` row without the email.
- A `POST` from a foreign origin, or without `Origin` and `Sec-Fetch-Site: same-origin`, is a 403
  `csrf_origin` on every unsafe route.
- `AUTH_MODE=oidc` starts with the OIDC variables set and refuses to start without them;
  `AUTH_MODE=dev` stays refused in production.

**3c**
- Region scope: a regional admin and a regional operations manager see and act only on projects
  of their regions; a project without a region only for global roles; tests for every operation.
- Only a global admin manages staff accounts, org roles and `mayCreateProjects`; the creator of a
  project chooses its region and is its first PL; the PL changes the region only while draft.
- Members: the PL adds and removes members; a global admin adds a replacement PL but never
  themselves; regional admins can't; the last active PL can't be removed; removing `consultant`
  ends their assignments; all audited.
- Assignments: only to project consultants; a consultant lists and reads exactly their assigned
  participations (existing scope tests extended); unassigning removes access at the next request.
- Deactivation ends sessions, memberships and assignments, and is refused for a last PL.

**3d**
- A code is 12 Crockford characters, generated at issuance, stored only as its keyed hash; no
  code, address or hash in logs, audit details, errors or later responses.
- Issuance only by the PL or a back-office member, only in active projects, never for terminal
  participations or pre-admission participations past their cutoff; letters refused without
  address or birth date; reissue needs the confirmation and revokes the open code; every
  issuance, handover and revocation audited.
- A printed sheet can't be activated until its handover is recorded with confirmer, time and
  method; unhanded sheets are revoked in one action.
- `in_person`: the ID check is recorded first; the code is committed `pending` before the send;
  a definitive failure revokes it, an unknown outcome leaves it `delivery_unknown`; no
  transaction is open during the send.
- Every letter, handed-over sheet and in-person message records a notice delivery (version,
  language, method, time); notice state `provided`/`due`/`overdue` per participation in list and
  detail; notice-only letters and handovers resolve it; de and en for every format.
- A terminal transition revokes open codes in the same transaction.
- The PL sees the activation status per participation; capabilities drive the actions; print
  views render letter, sheet and notice-only letter with QR, code and expiry.
- Notice texts: changing a released version fails the test suite.

**3e**
- The code is read from the fragment, removed from the address bar and posted only on a click.
- Failures (wrong birth date; wrong address for an `in_person` code) count on the code; the fifth
  locks it atomically (`activation_code_locked`); invalid codes of any kind get the one generic
  answer and count nothing; the per-IP throttle applies to every submission.
- Completion is one transaction: code used, account with its identity assurance, channel, consent
  record with text version and language, status `imported`/`unreachable` → `contacted` with actor
  `participant`, audit events, session `active` with a new token. Before the cutoff only for
  `imported`, `contacted` and `unreachable` (database time at completion); `informed` and
  `active_in_tg` activate without a status change. A failure anywhere leaves nothing.
- `change_participation_status` still refuses a `participant` actor; only `complete_activation`
  takes the `activation` edges.
- The activation notice is sent at least once, with the idempotency key, also when the job runs
  twice.
- Participant sessions: 30 min idle, 12 h absolute, ended by a terminal transition; step-ups
  recorded with method and time; an account assured by `photo_id` is marked so.

**3f**
- Login: 202 for any address; a code is valid 15 min, single-use, dead after 5 wrong entries;
  the 6th request in an hour per address is a 429; the email link logs in only after the click;
  `participant_login`/`participant_logout` audited.
- Channels: add (verified, own consent), remove (consent ended `revoked`, audited); the last
  removal ends the session; an address active elsewhere is the generic `channel_in_use`; no work
  email path exists.
- Recovery: issuing it ends all sessions and suspends the old channels at once; completion
  replaces them and ends their consents with `lost_access_replaced`; expiry leaves them
  suspended.
- e2e happy path: staff dev login → print a letter → activate in the portal (one-time code from
  the dev outbox) → the PL sees "aktiviert", the notice provided and `contacted` → log out → log
  in again by code.

**Every PR:** `pnpm verify` green, CI green, new tables in the data catalog with classes, docs as
listed, no real personal data.
