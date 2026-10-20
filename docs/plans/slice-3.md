# Slice 3 — Auth & roles: plan

Status: draft for review, 2026-10-20. Scope: [roadmap](../roadmap.md) Slice 3,
[ADR-0007](../adr/0007-auth.md) with its 2026-10-20 amendment, [round 35](../decisions/2026-10-20-answers-round-35.md)
(Q112–Q120). New questions from this plan: Q121–Q130 in [open-questions.md](../open-questions.md);
each names the fail-safe reading the PRs build until the owner answers.

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
- D5. **Binding an Entra account:** staff accounts are created in the app by an admin (email, name,
  roles; Q7: roles in the app, not Entra groups). The first OIDC login of an active, unbound
  account whose email matches the `email` claim (else `preferred_username`), case-insensitively,
  binds `(iss, sub)` to it (audited); later logins match `(iss, sub)` only. Unknown, deactivated or
  differently bound accounts are refused with a code. MFA stays the IdP's (Conditional Access, Q7);
  the app does not check `amr`.
- D6. **Staff login audit** goes to a new `staff_audit_event` table (no `project_id`, so not
  `audit_event`): logins, logouts, refused logins (code only, never the claimed email), identity
  bindings, account and org-role changes.

**Org model (deferred from Slice 2)**
- D7. **Regions:** a `region` table (Niederlassung, Q35) and `project.region_id`. New projects
  need a region; the PL changes it while the project is draft, an admin at any time (Q126). Org
  roles become region-scoped: `staff_org_role` rows (`admin` global, `regional_admin` and
  `regional_operations_manager` per region). A project without a region is seen only by global
  roles (fail safe). `PermissionTarget.regionId` is the project's region from now on.
- D8. **The flat `staff_user.role` goes.** Today's flat `project_lead` (who may create projects)
  becomes `staff_user.may_create_projects`, set by an admin (Q126). The migration maps `admin` to a
  global org role and `project_lead` to the flag; flat regional roles get no org role (no region is
  known; the seed grants them).
- D9. **Memberships:** the PL of a project adds and removes members and their project roles; an
  admin may add a PL to any project (so a project never stays without one). The last active PL
  can't be removed (`last_project_lead`). Removing the `consultant` role ends that person's
  assignments in the project (Q126).
- D10. **Participant assignments (Q62):** the PL assigns participations to members holding
  `consultant` in the project, zero or more per participation; rows are closed, never deleted.
  `staffSubjectOf` loads the open ones into `assignedParticipationIds`. Back office needs no
  assignment: "assigned back office" (Q118) is a back-office member of the project.
- D11. **Deactivating a staff account** (admin): refused while they are the last active PL of a
  project; ends their sessions, memberships and assignments in one transaction (Q59 unchanged:
  never deleted).

**Activation codes (round 35, Q113–Q120)**
- D12. **Format:** 12 characters of Crockford base32 (no I, L, O, U; about 60 bits), printed
  `XXXX-XXXX-XXXX`. Input is normalised: upper case, spaces and hyphens dropped, O→0, I/L→1.
- D13. **Generated in the request that issues it** (`crypto.randomBytes`), never at import, never
  stored: the row keeps `HMAC-SHA256(k, code)` with `k = HKDF(ACCESS_CODE_SECRET,
  "activation-code:v1")`. A separate secret, so rotating `SESSION_SECRET` (import keys) doesn't
  void posted letters; rotating `ACCESS_CODE_SECRET` voids every open code (the PL reissues).
- D14. **Validity:** 30 days from issuance (`expires_at = now() + 30 days`, database time), locked
  after 5 failed attempts (Q118). A failed attempt is a wrong birth date for a valid code. An
  unknown code can't be counted against any participation; it hits an in-memory per-IP limit
  (10 per 15 minutes, never stored or logged) (Q128).
- D15. **Issuance channels, the PL's choice per participant (Q120):**
  - `letter`: batch-printed, to the imported address; needs the address and a birth date
    (Q113: without one, no letter); the verification is the imported address (Q127).
  - `sheet`: printed, handed over in person; the issuer confirms the ID check
    (`identityConfirmed`, Q127).
  - `in_person`: after an ID check the PL types a private email or mobile; the server sends the
    link there at once and keeps only a keyed hash of the address
    (`delivery-address:v1`), never the address or the code. The response never contains the code.
- D16. **Who issues:** PL or back-office member of the project (`issueActivationCode`,
  `revokeActivationCode`); never a consultant, admin or participant; no anonymous or self-service
  path (Q118). Only in an `active` project, never for a terminal participation, and for
  `unreachable` only while `before_cutoff` holds (Q121).
- D17. **One open code per participation.** A new issuance revokes the open one (`reissued`) and
  needs `replaceOpenCode: true` when one is open (`open_code_exists` otherwise), so a reprint is a
  conscious reissue. A code can also be revoked without a new one (`not_handed_over`, `lost`).
  Issuing to an activated account is the lost-access path (D24).
- D18. **The letter and the sheet are the Art. 14 notice (Q114):** versioned pilot content in a
  notice catalog, German. Each code row records the notice version it went out with. The portal
  shows the same notice as the first activation step for every channel and records its version
  (the only notice an `in_person` participant gets, Q124). Controller and DPO contact details come
  from `packages/config` (`organisation.json`, synthetic in dev), never hard-coded.

**Activation, one-time codes, participant sessions**
- D19. **The code arrives in the link's fragment** (`<PORTAL_PUBLIC_URL>activate#<code>`). The
  page moves it into memory, removes it with `history.replaceState` and posts it only on the
  participant's click. Codes, one-time codes and addresses never appear in a URL the server sees.
- D20. **Steps:** code → notice → birth date (skipped only when the participation has none and the
  code went out with an ID check, Q113/Q129) → channel with consent → one-time code to that
  channel (skipped when the typed address matches the `in_person` delivery hash: opening the link
  verified it, Q120) → done. One transaction completes it: code `used`, account, channel, consent
  record, the status change, the audit events; the session becomes `active` with a new token.
- D21. **Activation moves the status (Q116)** through the status function's single body: new
  edges `imported → contacted` and `unreachable → contacted` of kind `activation`, actor
  `participant`, with the same guards as the manual edges (`before_cutoff` on the second). Any
  later status stays; a failing guard refuses the activation (Q121).
- D22. **One-time codes:** 6 digits, single-use, 15 minutes, at most 5 per address per hour
  (login and channel verification together), 5 wrong entries end the code. Stored as
  `HMAC(HKDF(ACCESS_CODE_SECRET, "one-time-code:v1"), challengeId ‖ code)`. The email carries the
  code and a link with it in the fragment; the page logs in only on a click (no login on a bare
  GET). The login request answers `202` whether or not the address exists.
- D23. **Channels:** at least one verified private email or mobile per activated account (Q117),
  chosen by the participant (Q119), each with its own consent record (purpose `portal_contact`:
  login and portal notifications; text versioned, de/en). An address is unique among active
  channels (`channel_in_use`, Q125). Never the imported work email; the import never writes
  channels, so a re-import can't overwrite them (Q112 by construction). The participant adds and
  removes channels in the portal; removing one revokes its consent; removing the last one ends the
  session (only a new code or assisted mode remain, ADR-0007).
- D24. **Lost access:** a new code; completing it again ends all sessions and removes the old
  channels (reason `reactivated`), so a lost phone stops working (Q130). No status change.
- D25. **Participant sessions:** 30 minutes idle, 12 hours absolute (`last_seen_at` written at
  most once a minute). An `activating` session (code accepted, not finished) lives 30 minutes
  idle and opens only the activation steps. A session ends at a terminal status of its
  participation (checked per request, Q121). The session records the birth-date check of the
  activation (`knowledge_checked_at`); the re-check before special-category data comes with the
  first such field (Slice 4a).
- D26. **Activation notice:** after the commit a pg-boss job (`portal.activation-notice`,
  payload `{ channelId }`, `singletonKey` the channel id) sends the notice; the channel row
  records `notice_sent_at`, so a retry never sends twice.
- D27. **Messages are sent in the request** when they carry a secret (activation link, one-time
  code): it exists only in memory, so no job could send it. Issue/challenge write and send share
  one transaction; a failed send rolls back (`503 delivery_failed`).
- D28. **What staff see of channels:** the kinds (`email`, `sms`) and dates, never the addresses
  (purpose limitation; Q123, fail safe).

**Lifecycle core**
- D29. **`self_registered` and `rejected` leave the core** in their own PR (3a): enum values,
  edges, the `anonymous_self_registration` edge kind and permission denial, the `CHECK`s, the
  generated table. The migration recreates the enum types and refuses if any row holds a removed
  value.

## PRs

One planned PR = one branch = one PR, each in its own session. 3a and 3b start from `main` in
parallel; each later PR starts from `main` once its predecessor merged. Estimates: changed lines
without tests and generated files.

| PR | Content | After | Estimate |
|---|---|---|---|
| 3a | Remove `self_registered`, `rejected` and the anonymous edge kind (D29) | — | ~300 |
| 3b | Staff sessions, OIDC + dev stub, CSRF, `staff_audit_event`, web login/logout (D1–D6) | — | ~1,100 |
| 3c | Regions, org roles, staff accounts, memberships, assignments, admin and team UI (D7–D11) | 3b | ~1,450 |
| 3d | Activation codes: tables, issuance (three channels), revoke, notice catalog, Mailer/SmsSender mocks, PL status and print views (D12–D18, D27, D28) | 3c | ~1,450 |
| 3e | Portal activation: participant sessions, one-time codes for verification, activation function and status edge, activation UI, notice job (D19–D21, D23, D25, D26) | 3d | ~1,350 |
| 3f | Portal login with one-time code, logout, channel management and consent revocation, lost-access reactivation (D22–D24) | 3e | ~1,000 |

Six PRs because the slice is about 6,600 lines: 3b and 3c are separate concerns (login vs. the org
model), 3d–3f each stay under the 1,500-line limit, and 3a is its own PR by round 35.

## Design

### Data model

New tables (data catalog: `dataClass`, `retentionClass`, `holdsParticipantData`; the access
category is the field catalog's for what staff may read; a hash is never served):

| Table | PR | Columns (short) | dataClass | accessCategory | retentionClass |
|---|---|---|---|---|---|
| `staff_session` | 3b | `token_hash` PK, `staff_user_id`, `created_at`, `expires_at`, `ended_at`, `end_reason` (`logout`, `deactivated`, `superseded`) | internal | — (staff) | `access_credential` (new, Q122) |
| `staff_audit_event` | 3b | `seq`, `event_type`, `actor_staff_user_id`, `subject_staff_user_id`, `reason_code`, `details` (ids/codes), `occurred_at`, `request_id` | internal | — (staff) | `audit_log` (Q122) |
| `region` | 3c | `id`, `code`, `name`, `created_at` | internal | — | `reference_data` |
| `staff_org_role` | 3c | `staff_user_id`, `role`, `region_id` (null only for `admin`), `granted_by`, `granted_at` | internal | — (staff) | `staff_account` |
| `participant_assignment` | 3c | `id`, `project_id`, `participation_id`, `staff_user_id`, `assigned_by/at`, `ended_by/at`, `end_reason` | internal | `case_internal` | `participation_record` |
| `activation_code` | 3d | `id`, `project_id`, `participation_id`, `code_hash` (unique), `channel`, `identity_check` (`imported_address`, `id_checked`), `delivery_kind`, `delivery_address_hash`, `notice_version`, `issued_by/at`, `expires_at`, `failed_attempts`, `locked_at`, `revoked_by/at`, `revoke_reason`, `used_at` | confidential | `case_internal` (status, dates, kinds); hashes never served | `access_credential` (Q122) |
| `participant_account` | 3e | `participation_id` PK, `project_id`, `activated_at`, `activation_code_id`, `language` | internal | `case_internal` | `personnel_file` |
| `participant_channel` | 3e | `id`, `project_id`, `participation_id`, `kind` (`email`, `sms`), `address` (normalised), `verified_at`, `verified_by` (`one_time_code`, `activation_link`), `consent_id`, `notice_sent_at`, `removed_at`, `removed_reason` (`consent_revoked`, `reactivated`); unique `(kind, address)` while not removed | confidential | `confidential`, not listable; staff see kinds only (Q123) | `personnel_file` |
| `consent_record` | 3e | `id`, `project_id`, `participation_id`, `purpose` (`portal_contact`), `text_version`, `language`, `given_at`, `revoked_at`, actor | confidential | `confidential` | `personnel_file` (Q122) |
| `one_time_code_challenge` | 3e | `id`, `project_id`, `participation_id`, `purpose` (`login`, `channel_verification`), `kind`, `address` (normalised), `code_hash`, `created_at`, `expires_at`, `failed_attempts`, `consumed_at` | confidential | never served | `access_credential` (Q122) |
| `participant_session` | 3e | `token_hash` PK, `project_id`, `participation_id`, `state` (`activating`, `active`), `activation_code_id`, `created_at`, `last_seen_at`, `ended_at`, `end_reason`, `knowledge_checked_at` | internal | never served to staff | `access_credential` (Q122) |

Changed: `staff_user` (3b: `oidc_issuer`, `oidc_subject`, unique together; 3c:
`may_create_projects`, `deactivated_at`, drop `role`); `project` (3c: `region_id`); the
`main_status` and `edge_kind` enums (3a: values removed; 3e: `activation` added). The new class
`access_credential` is `unset` in `retentionPeriods` like the others, so no job deletes before
Q122 is answered. Field catalog: `activationStatus` (internal, `case_internal`, listable) and
`portalChannels` (confidential, `confidential`, self-service, not listable, `personnel_file`).

### Database functions and grants

All `SECURITY DEFINER`, owned by `transfer_owner`, fixed `search_path`, `EXECUTE` to
`transfer_app` only, `P0001` codes, audit event in the same transaction, ADR-0002 conventions.
`transfer_app` gets `SELECT` on the new tables and no `INSERT`/`UPDATE`/`DELETE`, except
`UPDATE (last_seen_at)` on `participant_session` (D25). Column `SELECT` on `staff_audit_event`
and `audit_event` stays none.

| PR | Functions |
|---|---|
| 3a | the enum recreation; `change_participation_status` and the helpers whose signatures name the types recreated unchanged in behaviour |
| 3b | `start_staff_session`, `end_staff_session`, `bind_staff_identity`, `record_staff_login_refused` |
| 3c | `create_region`, `update_region`, `create_staff_user`, `update_staff_user`, `deactivate_staff_user`, `grant_org_role`, `revoke_org_role`, `add_project_member`, `remove_project_member`, `assign_participations`, `unassign_participation`; `create_project` and `update_project` replaced with a region parameter |
| 3d | `issue_activation_code` (locks the participation, revokes the open code, re-checks D15–D17), `revoke_activation_code` |
| 3e | the status body moves into the internal `apply_status_change` (no grant); `change_participation_status` keeps its signature and refuses `participant`; `start_activation`, `check_activation_birth_date` (counts and locks under the row lock), `create_one_time_code` (per-address advisory lock, 5/hour), `verify_one_time_code`, `complete_activation` (calls `apply_status_change` with kind `activation`), `end_participant_session`, `mark_activation_notice_sent` |
| 3f | `start_participant_session`, `add_participant_channel`, `remove_participant_channel` |

Audit event types (`audit_event`, codes and ids only): `activation_code_issued` (code id,
channel, identity check, delivery kind, notice version), `activation_code_revoked`,
`activation_code_locked` (actor `system`, job `portal-activation`), `participant_activated`,
`consent_given`, `consent_revoked`, `contact_channel_added`, `contact_channel_removed`,
`participant_login`, `participant_logout`, `one_time_code_exhausted`, `project_member_added`,
`project_member_removed`, `participant_assigned`, `participant_unassigned`; plus
`status_changed` with actor `participant` for D21. `staff_audit_event` types: `staff_login`,
`staff_logout`, `staff_login_refused`, `staff_identity_bound`, `staff_account_created`,
`staff_account_changed`, `staff_account_deactivated`, `org_role_granted`, `org_role_revoked`,
`region_created`, `region_changed`. The audit Zod model and the `CHECK`s grow with each PR.

### Domain (`packages/domain`, tests first, 100 % coverage)

- `lifecycle`: 3a removes the values, edges and the denial; 3e adds the `activation` edges.
  `mayPerformTransition`: a participant takes exactly the `activation` edges of their own
  participation.
- `access/permissions`: operations `issueActivationCode`, `revokeActivationCode` (PL, back
  office), `manageMembers`, `assignParticipations` (PL; admin adds a PL), `setProjectRegion`; org
  administration `mayAdminister(subject, "staff" | "regions")` (admin).
- `activation/code.ts`: alphabet, format, normalise. `activation/issuance.ts`:
  `issuanceRefusals(...)` → `participation_closed`, `project_not_active`, `birth_date_required`,
  `address_required`, `identity_not_confirmed`, `before_cutoff`, `open_code_exists`.
  `activation/status.ts`: `activationStatus` → `{ account: activated | not_activated, code: none |
  open | expired | locked | revoked | used }` with dates. `activation/steps.ts`: the step machine
  of D20.
- `portal/contact.ts`: email and mobile normalisation (German national numbers to `+49`, else E.164
  with `+`). `portal/limits.ts`: the constants of D14, D22, D25 (a drift test holds the SQL to
  them).
- `notices/`: catalog of `art14-activation:v1` (de) and `portal-contact-consent:v1` (de, en) with
  each text's SHA-256; a released text never changes (test, like the template manifest).

### Adapters (`packages/adapters`, ADR-0006)

- `Mailer.send({ to, subject, text })` and `SmsSender.send({ to, text })`, each with a mock that
  keeps the last 100 messages in memory and logs only a message id. `MAIL_ADAPTER` and
  `SMS_ADAPTER` accept `mock` only until a provider (with AVV) is chosen.
- Dev only (`AUTH_MODE=dev`, refused in production): `GET /api/v1/dev/outbox` lists the mock
  messages, for development and e2e.
- No adapter for OIDC (ADR-0006).

### API (`/api/v1`, ADR-0010)

| PR | Routes |
|---|---|
| 3b | `GET /auth/login` (302 to the IdP; `tp_oidc` signed cookie with state, nonce, verifier, return path, 10 minutes), `GET /auth/callback`, `POST /auth/logout`, `GET /me` (+ `sessionExpiresAt`); dev `POST/DELETE /dev/session` on the session store |
| 3c | `GET/POST /regions`, `PATCH /regions/{id}`; `GET/POST /staff-users`, `PATCH /staff-users/{id}`, `POST /staff-users/{id}/deactivation`, `PUT /staff-users/{id}/org-roles`; `GET /staff-directory?search=` (id and name of active staff, for member pickers); `GET/POST /projects/{id}/members`, `DELETE /projects/{id}/members/{staffUserId}/{role}`; `POST /projects/{id}/assignments` (bulk, ≤ 500), `DELETE /participations/{id}/assignments/{staffUserId}`; `regionId` on project create/update |
| 3d | `POST /projects/{id}/activation-codes` (`letter` or `sheet`, ≤ 500 participations, all or nothing; `201` with the codes and print data, `Cache-Control: no-store`), `POST /participations/{id}/activation-codes/in-person` (no code in the response), `POST /participations/{id}/activation-codes/revocation`, `GET /participations/{id}/activation`; `activationStatus` in list items and the detail, with capabilities |
| 3e | `POST /portal/activation` (code), `POST /portal/activation/birth-date`, `POST /portal/activation/channel`, `POST /portal/activation/completion`, `GET /portal/me`, `POST /portal/logout` |
| 3f | `POST /portal/login/code-request` (`202` always), `POST /portal/login`, `GET/POST /portal/channels`, `POST /portal/channels/verification`, `DELETE /portal/channels/{id}` |

New problem codes (422 unless noted): `csrf_origin` (403), `unknown_account`,
`account_deactivated`, `identity_mismatch`, `last_project_lead`, `not_consultant`,
`region_required`, the issuance refusals above, `code_invalid`, `code_expired`, `code_locked`,
`code_revoked`, `code_used`, `knowledge_check_failed` (with the remaining attempts),
`one_time_code_invalid`, `rate_limited` (429, a new problem type `too-many-requests`, with
`Retry-After`), `channel_in_use`,
`channel_invalid`, `delivery_failed` (503). Portal routes never say whether an address exists.
Logs: the portal request line carries `participationId` (an id), never an address, code or token.

Environment (`.env.example`): `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (secret
store), `OIDC_REDIRECT_URL`; `ACCESS_CODE_SECRET` (≥ 32 characters, required outside
development, a fixed dev value otherwise so a watch restart keeps printed dev codes);
`PORTAL_PUBLIC_URL` (required outside development).

### Web (`apps/web`, de)

- 3b: login page (`oidc`: "Anmelden" to `/auth/login`; `dev`: the user switcher), the user and
  "Abmelden" in the header, a 401 anywhere returns to the login page with "Sitzung abgelaufen".
- 3c: `/admin/staff` and `/admin/regions` (admin only); project "Team" tab (members, roles, add
  and remove); region on project create and setup; participants list: assigned consultants
  column, bulk "Zuweisen"; detail: assignments.
- 3d: participants list: activation status column, row selection, bulk "Aktivierungsbriefe
  drucken" / "Aktivierungsblätter drucken" (capability per row, a confirmation for reissues);
  detail: activation panel (status, channel, dates, issuer, attempts left, "Persönlich senden",
  "Code widerrufen", "Neu ausstellen"); print views for the letter (DIN 5008 window address) and
  the sheet, with the notice text, the grouped code, its expiry and a QR of the link (client-side
  QR library, pinned). The codes live only in the mutation result; leaving the print view drops
  them.

### Portal (`apps/portal`, de + en, mobile-first, RTL-ready)

- 3e: `/activate` (fragment handling, notice, birth date `TT.MM.JJJJ`, channel choice with the
  consent text, one-time code, done), `/` (logged in: greeting, channels), an expired or idle
  session returns to `/login` (3f) or the activation start.
- 3f: `/login` (address → code; the email link pre-fills the code from the fragment and waits for
  the click), `/channels` (add with verification and consent, remove with a warning for the last
  one), "Abmelden".

### Jobs (ADR-0011)

- `portal.activation-notice` (3e): `exclusive` queue, payload `{ channelId }`, sends once
  (`notice_sent_at`), retries with backoff, logs ids and outcome only.

### Docs each PR updates

ADR-0007 (as built), ADR-0002 (functions, grants), ADR-0006 (Mailer, SmsSender, dev outbox; SMS no
longer "primary"), ADR-0010 (cookies, CSRF, problem codes), data-protection.md (Authentication,
the retention-class table, the new tables), process-and-lifecycle.md (3a removal, 3e activation
edges, the generated transitions table), overview.md, `.env.example`; 3f moves this plan to
`docs/plans/archive/` and marks Slice 3 done in the roadmap.

## User flows

1. **Staff login.** Unauthenticated → login page → Entra (MFA by Conditional Access) → callback:
   first login binds the account, a session starts (8 h), `staff_login`. Unknown account → "Kein
   Zugang" page, `staff_login_refused`. Dev: the switcher does the same against the store.
2. **PL issues letters.** Participants list → select (status `imported`/`unreachable`, not
   activated) → "Aktivierungsbriefe drucken" → rows with an open code need the reissue
   confirmation; rows without address or birth date are refused with their code → print view →
   browser print → the PL posts them (Q115). Every code: `activation_code_issued`.
3. **PL issues sheets** for an info event: the same with "Aktivierungsblätter drucken" and the
   confirmation that each sheet is handed over after an ID check; sheets not handed over are
   revoked (`not_handed_over`).
4. **PL issues in person:** detail → "Persönlich senden" → ID checked (confirmation) → email or
   mobile typed → the link is sent; the PL sees "an E-Mail gesendet", never the code or, later,
   the address.
5. **Participant activates:** opens the link or scans the QR (or types the code on `/activate`) →
   notice → birth date → email or mobile and consent → one-time code (or none after an
   `in_person` link to that address) → "Ihr Zugang ist aktiv" → status `contacted` if it was
   `imported`/`unreachable` → the notice arrives on that channel.
6. **Participant logs in:** `/login` → address → code by email or SMS (15 min) → typed, or the
   email link opened and "Anmelden" clicked → session (30 min idle, 12 h). Wrong code 5× → a new
   code is needed; more than 5 requests an hour → "Bitte später erneut".
7. **PL reissues:** a participant lost access or the letter → identity verified → "Neu
   ausstellen" with any channel → the old code is revoked; after a completed reactivation the old
   channels and sessions end (D24).
8. **Code locked or expired:** the participant sees "Dieser Code ist nicht mehr gültig" with the
   TG contact; the PL sees "gesperrt" (5 wrong birth dates) or "abgelaufen" and reissues.
9. **Assisted mode:** without a birth date the PL issues only a sheet or in person, after an ID
   check (Q113); a person without a private email or mobile, or unwilling to register one, isn't
   activated (Q117): the PL records `contacted` by hand as today, and staff enter data on their
   behalf with `onBehalfOf` from Slice 4a.
10. **PL manages the team:** Team tab → add a consultant → assign participations in the list;
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
- Members: the PL adds and removes members; the last active PL can't be removed; removing
  `consultant` ends their assignments; all audited.
- Assignments: only to project consultants; a consultant lists and reads exactly their assigned
  participations (existing scope tests extended); unassigning removes access at the next request.
- Deactivation ends sessions, memberships and assignments, and is refused for a last PL.
- No `staff_user.role`; who may create projects is the admin-set flag.

**3d**
- A code is 12 Crockford characters, generated at issuance, stored only as its keyed hash; no
  code, address or hash in logs, audit details, errors or later responses.
- Issuance only by the PL or a back-office member, only in active projects, never for terminal
  participations; letters refused without address or birth date; reissue needs the confirmation
  and revokes the open code; every issuance and revocation audited with channel and notice
  version.
- `in_person` sends the link through the mock adapter and keeps only the address hash; a failed
  send writes nothing.
- The PL sees the activation status per participation in list and detail; capabilities drive the
  actions; print views render letter and sheet with QR, code and expiry.
- Notice texts: changing a released version fails the test suite.

**3e**
- The code is read from the fragment, removed from the address bar and posted only on a click.
- Wrong birth dates count on the code; the fifth locks it (`activation_code_locked`); an expired,
  revoked, used or locked code can't start an activation; unknown codes hit the per-IP limit.
- Completion is one transaction: code used, account, channel, consent record with text version
  and language, status `imported`/`unreachable` → `contacted` with actor `participant` (no change
  from later statuses; `before_cutoff` refusal per Q121), audit events, session `active` with a
  new token. A failure anywhere leaves nothing.
- `change_participation_status` still refuses a `participant` actor; only `complete_activation`
  takes the `activation` edges.
- The notice reaches the new channel exactly once, also when the job runs twice.
- Participant sessions: 30 min idle, 12 h absolute, ended at a terminal status.

**3f**
- Login: 202 for any address; a code is valid 15 min, single-use, dead after 5 wrong entries;
  the 6th request in an hour per address is a 429; the email link logs in only after the click;
  `participant_login`/`participant_logout` audited.
- Channels: add (verified, own consent), remove (consent revoked, audited); the last removal
  ends the session; an address active elsewhere is `channel_in_use`; no work email path exists.
- Reactivation removes the old channels and ends all sessions.
- e2e happy path: staff dev login → print a letter → activate in the portal (one-time code from
  the dev outbox) → the PL sees "aktiviert" and `contacted` → log out → log in again by code.

**Every PR:** `pnpm verify` green, CI green, new tables in the data catalog with classes, docs as
listed, no real personal data.
