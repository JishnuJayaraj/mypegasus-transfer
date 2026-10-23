# ADR-0010: API contract

- Status: Accepted
- Date: 2026-10-15

## Context
Two SPAs (`apps/web`, `apps/portal`, ADR-0001) talk to one Hono API. Exports and later
integrations (payroll, Agentur reports) need documented interfaces. Validation already uses
Zod in `packages/domain`.

## Decision
- **OpenAPI via `@hono/zod-openapi`.** Routes are defined with the shared Zod schemas, and the
  OpenAPI document is generated from them. Typed clients for both apps are generated from that
  document.
- **One error format:** RFC 9457 problem details (`application/problem+json`), with a stable
  `type` URI per error kind. Validation errors list the failing fields. Error bodies never
  contain personal data beyond what the caller sent.
- **Cursor pagination** for lists (`cursor`, `limit`; response carries `nextCursor`).
- **URL versioning:** `/api/v1`. Breaking changes need a new version.
- Special-category and highly confidential data are served by **separate endpoints** with read
  logging, never as part of list responses (data-protection.md).
- Authorisation is checked in the API for every request (ADR-0007).

## Consequences
+ One source of truth for request/response types, documentation and clients.
+ Exports and integrations get a documented contract.
- Routes must be written in the `@hono/zod-openapi` style from Slice 0 on.

## Risk noted 2026-10-15: `openapi-typescript` maintenance

`openapi-typescript`'s maintenance looks uncertain: no release since February 2026, and TS 6
support has stalled, according to a maintainer-status discussion on GitHub. Version 7.13.0
declares `typescript: ^5.x` as a peer; the root `package.json` allows TS 6 for exactly that edge
(`openapi-typescript>typescript`, spike S4 in ADR-0003). The risk is contained: only
`packages/api-client` depends on the generator, and the apps only use `openapi-fetch` and the
committed types. If it doesn't support TS 6 by the end of the MVP, evaluate a replacement
generator then. No action now.

## Note 2026-10-19 (Slice 2, PR 2g): uploads, body limits, new problem types

- **Uploads are JSON.** The API keeps refusing non-JSON bodies, so the import sends the file as
  base64 inside the JSON body (`POST /projects/{id}/imports/preview` and `…/imports`). The
  decoded file is at most 5 MB; the base64 body of the two import routes at most 8 MB.
- **Body limits:** 8 MB on the two import routes, 100 kB on every other `/api` route; above it the
  answer is `413` `payload-too-large`.
- **Problem types added in Slice 2:** `conflict` (409), `domain-error` (422, `errors[].code`, and
  `failedGuards` where a guard failed) and `payload-too-large` (413). Codes only, never a value of
  the request; a file the import can't read is a 422 at `/file`.

## Note 2026-10-19 (Slice 2, PR 2h-2): a busy import, the participation of a refusal

- **`503` `service-unavailable` with `import_busy`:** an API process runs at most two parse
  workers; up to eight further preview or confirm requests wait for at most 20 s. A request that
  finds the queue full or whose wait expires is answered `503` with `errors[].code`
  `import_busy` and `Retry-After: 10` (round 33). The client retries later;
  nothing was read or written.
- **`participationId` in a problem:** a refusal that refers to a participation the caller may
  open names its id (an extension member of RFC 9457), never a value: a manual creation whose
  Personalnummer exists already (`personnel_number_taken`) links to that participation.

## Note 2026-10-20 (Slice 3, PR 3b): session cookie, CSRF, login problem codes

- **Session cookie:** `__Host-tp_staff` (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`) outside
  development, `tp_staff` over http in development (ADR-0007, as built). Staff routes read only
  that cookie; a missing, unknown, ended or expired session is a 401 `unauthenticated`.
- **CSRF (`apps/api/src/csrf.ts`), replacing Hono's `csrf()`, which checked only form content
  types:** every `POST`, `PUT`, `PATCH` and `DELETE` under `/api/*` needs an `Origin` in
  `APP_ORIGINS`; without an `Origin`, `Sec-Fetch-Site: same-origin`. Anything else, `Origin: null`
  included, is a 403 `forbidden` with `errors[].code` `csrf_origin`. It runs before the content-type
  check. With JSON-only bodies, no CORS and `SameSite=Lax` cookies there is no token scheme.
- **Login refusals** (`unknown_account`, `account_deactivated`, `identity_mismatch`): a 422
  `domain-error` from the dev login; the OIDC callback, a browser navigation, redirects to
  `/login?error=<code>` instead, with `login_failed` for a callback that fails its checks.
- **New routes:** `GET /auth/login`, `GET /auth/callback` (302 only, `Cache-Control: no-store`, with
  `AUTH_MODE=oidc`), `POST /auth/logout` (an empty strict body, 204 with or without a session);
  `GET /me` gains `sessionExpiresAt` (schema `CurrentStaffUser`).
- **Logs:** the request line has no query string, so neither the authorization code nor `state`
  reaches it; a failed callback logs the error's name, code and stack frames only.

## Note 2026-10-20 (Slice 3, PR 3c): administration, teams, assignments

- **New routes:** `GET/POST /regions`, `PATCH /regions/{id}`; `GET/POST /staff-users` (cursor
  pagination), `PATCH /staff-users/{id}`, `POST /staff-users/{id}/deactivation` (an empty strict
  body), `PUT /staff-users/{id}/org-roles` (an atomic complete set; the database locks and re-reads
  the target before granting and revoking the difference); `GET /staff-directory?search=` (id and
  name of active staff, at most 20); `GET/POST /projects/{id}/members`,
  `DELETE /projects/{id}/members/{staffUserId}/{role}`;
  `POST /projects/{id}/assignments` (1–500 distinct participations, all or nothing),
  `DELETE /participations/{id}/assignments/{staffUserId}`. `regionId` on project create, update
  and the `Project` schema; `consultants` in participant list items; `assignments` and
  `capabilities.assignParticipations` in the detail; `capabilities.setProjectRegion` in the
  project configuration; `ProjectTeam.capabilities` (`manageMembers`, `addReplacementLead`,
  `assignParticipations`). `GET /me` and `StaffUser` carry `mayCreateProjects` and `orgRoles`
  instead of the flat `role`; the dev switcher's `DevStaffUser` a `role` label.
- **Order:** the administration routes check the global admin first (403 for everyone else, also
  for an unknown id), then the resource (404). Team and assignment routes keep the order above:
  visibility 404, operation 403, then the refusals.
- **Problem codes (422 unless noted):** `region_required`, `region_not_found`,
  `region_code_taken` (`/code`), `region_unchanged`, `email_taken` (`/email`),
  `staff_user_unchanged`, `account_deactivated`, `own_account`, `last_project_lead`,
  `org_role_exists`, `org_role_not_found`, `membership_exists`, `unknown_account` and
  `not_consultant` (`/staffUserId`), `participation_not_found` (`/participationIds`); an unknown
  region, account, membership or assignment in the path is a 404; `region_scope` and
  `duplicate_org_role` are 400 validation codes.

## Note 2026-10-21 (Slice 3, PR 3d): activation and Article 14 notice APIs

- **New routes:** `POST /projects/{id}/activation-codes` (letter/sheet batch, 1–500 distinct
  participations, all or nothing), `POST /participations/{id}/activation-codes/in-person`,
  `POST /participations/{id}/activation-codes/handover`,
  `POST /participations/{id}/activation-codes/revocation`, and
  `GET /participations/{id}/activation`; notice-only routes are
  `POST /projects/{id}/privacy-notices` and `POST /participations/{id}/privacy-notices`.
  Participation list/detail responses add derived activation and notice state plus capabilities;
  list filters execute in SQL before cursor pagination.
- Printable batch responses are `Cache-Control: no-store` and are the only API responses that
  contain activation codes. The in-person and state responses never contain a code, destination
  or either keyed hash. The public portal route `/portal/notice/art14/{version}` is static,
  bilingual, personal-data-free and makes no API request.
- Batch requests reject duplicate ids and preserve input order while locking in sorted order.
  Nested handover/revocation routes return 404 when the code does not belong to the participation
  in the path. Issuance refusals are 422 domain codes; a definitive provider failure is 503 with
  `delivery_failed`; an unknown provider outcome is a successful committed state reported as
  `delivery_unknown`.
- Activation and notice state are projections, never client claims. `provided` notice evidence
  means a letter was produced, a sheet or in-person print was handed over, or an in-person
  email/SMS send definitively succeeded. Failed and unknown sends do not claim provision.

## Note 2026-10-21 (Slice 3, PR 3e): the portal activation API

- **Routes:** `POST /portal/activation` (the code; starts the `activating` session and sets the
  portal cookie), `POST /portal/activation/birth-date`, `POST /portal/activation/delivery-address`,
  `POST /portal/activation/channel` (`202`: a one-time code sent, or its outcome unknown),
  `POST /portal/activation/completion` (`201` with `PortalMe` and a new cookie), `GET /portal/me`,
  `POST /portal/logout` (`{}` body, `204`). The steps answer `ActivationState` (the next step,
  the code's channel and language, the notice and consent versions). Codes and addresses travel
  only in request bodies; no response carries a code, a whole address or a hash: `PortalMe`
  shows the participant's own channels masked (`p…@example.org`, `+49 … 123`).
- **Problem codes:** 422 `code_invalid` (the one generic answer for any unusable code; the portal
  cookie is cleared), `knowledge_check_failed`, `one_time_code_invalid`, `before_cutoff`,
  `step_not_allowed`, `channel_in_use`, `channel_invalid`; a new problem type
  `too-many-requests` (429, `rate_limited`, with `Retry-After`); 503 `delivery_failed` and
  `delivery_unavailable`; 401 for a missing, idle, expired or wrong-state session.
- **Staff side:** `GET /participations/{id}/activation` adds `account` (activation time and
  identity assurance) and `channels` (kind, verification, consent, notice and removal dates; never
  the address); the list filter `activation` takes `activated`; issuance refuses
  `already_activated`.
- Portal request log lines carry `participationId`, never a code, address or token.

## Note 2026-10-21 (Slice 3, PR 3f): portal login, channels and recovery

- **Login:** `POST /portal/login/code-request` (`{ kind, address, language }`) answers `202` with
  no body whether or not the address has an account; `POST /portal/login`
  (`{ kind, address, oneTimeCode }`) answers `200` with `PortalMe` and the portal cookie, or the
  one 422 `one_time_code_invalid` for every failure (unknown address included). A sixth code
  request for an address within an hour is a `429` for any address. A malformed address is 422
  `channel_invalid`, which says nothing about an account.
- **Channels:** `GET /portal/channels` (`PortalChannels`, masked), `POST /portal/channels`
  (`202`, a verification code sent), `POST /portal/channels/verification` (`201` with the
  channels; the consent with its version and language), `DELETE /portal/channels/{channelId}`
  (`200` `{ sessionEnded }`; `true` when it was the last channel, and the cookie is cleared; 404
  for a channel not the participant's own).
- **Recovery:** `POST /participations/{id}/activation-codes` takes `RecoveryCodeInput` (purpose
  `recovery`; `letter`, `sheet` or `in_person` with the address and the photo-ID check;
  `identityVerified: true` always) and answers `201` `RecoveryCodeResult`: the print item with
  the code for a letter or sheet (`Cache-Control: no-store`, never retrievable later), `null` for
  in person, and the new `ParticipationActivation`. New refusal `not_activated`.
  `ActivationRecord` and `ActivationState` carry `purpose`; for an activated account
  `ActivationStatus.code` shows a recovery code's state.

## Note 2026-10-22 (Slice 4b, PR 4b-2): documents

- **Upload transport:** base64 in JSON, as the import: `POST` with `{ type, fileName, content }`
  (`DocumentUploadInput`, strict; no MIME type: the type is detected from the content). The
  decoded file is at most 10 MB (10,485,760 bytes); the body of the three upload routes at most
  **14 MB**, every other route keeps 100 kB (`413` above). An API process handles at most two
  uploads at once, up to four more wait ≤ 20 s, else `503` `upload_busy` with `Retry-After: 10`.
  Not chosen: multipart (a second body parser and an exception to JSON-only and strict schemas)
  and a direct signed upload to the object store (CSP `connect-src` to the store's origin, a
  public store endpoint, the provider would see plaintext, and nothing would be scanned before it
  is stored); nor an asynchronous scan job (a pending state, a quarantine and purge of unscanned
  objects, polling in both apps, completeness over unscanned files): a stored file is always a
  clean one.
- **Routes:** `GET`/`POST /portal/documents`, `POST /portal/documents/{documentId}/opening`,
  `DELETE /portal/documents/{documentId}`; `GET`/`POST /participations/{id}/documents`,
  `POST …/documents/{documentId}/opening`, `POST …/documents/{documentId}/review`
  (`{ decision, reasonCode? }`), `DELETE …/documents/{documentId}?reasonCode=` (strict query);
  `GET`/`POST /participations/{id}/assisted/documents?assistedModeId=` and
  `POST …/assisted/documents/{documentId}/opening?assistedModeId=` (403 `assisted_mode_required`
  without a live mode); `GET /document-content/{token}`. Lists are `DocumentList` (the live
  documents of the types the viewer may read, oldest first, `addableTypes`, `limits`); a document
  is `Document` (metadata, review, `capabilities` `open` / `review` / `delete`), never content, a
  hash or a key.
- **Order:** the participation's visibility (404, also for an unassigned consultant and for a
  document of another participation or a type the viewer can't read), the type
  (`document_type_not_supported`), the operation's permission (403), the store, the file name
  (400 `file_name_invalid`), the gate, then the file and the function's refusals.
- **The opening and the download (Q147):** `POST …/opening` answers `201`
  `{ url: "/api/v1/document-content/<token>", expiresAt }` (`no-store`), audited
  `document_opened`. The browser navigates to the URL with the session that asked (portal or
  staff cookie); within 60 s the `GET` answers the file as `attachment` (`Content-Disposition`
  with an ASCII fallback and the UTF-8 name, the detected type's extension appended when the
  kept name lacks it), `Content-Type` the detected type, `X-Content-Type-Options: nosniff`,
  `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'; sandbox`. Any other
  session, a dead link or a deleted document is a `404`.
- **Problem codes:** 422 `document_type_not_supported`, `file_empty`, `file_too_large`,
  `file_type_not_allowed`, `file_infected`, `file_unscannable` (at `/content`), `document_limit`,
  `document_reviewed` (a second review), `document_accepted` (the participant deleting an
  accepted one), `participation_closed`; 400 `reason_code_mismatch` (a rejection without a reason
  or an acceptance with one); 429 `rate_limited` (20 uploads an hour, `Retry-After`); 503
  `upload_busy`, `scan_unavailable` (`Retry-After: 30`) and `storage_unavailable` (always with
  `NODE_ENV=production` until the S3 store and ClamAV exist, Q149).
- **Logs:** an upload logs the request id, participation id, type, a size bucket and the outcome;
  the download's route is logged as its pattern, never the token.
- **The clients (PR 4b-3):** the portal's "Unterlagen", the staff tab "Unterlagen" and the
  assisted page read the file into base64 in memory, check the size against `limits.maxBytes`
  before sending, map each code above to a message (an ended session or mode ends the view, a
  `404` reloads the list), send the bodyless opening with `Content-Type: application/json` and
  then assign `location` to the link: a top-level download, no `blob:`, no CSP change.

## Note 2026-10-22 (Slice 5, PR 5-1): the work list snapshot and the dashboard

- **Routes:** `GET /projects/{id}/worklist` (`Worklist` `{ generatedAt, items: WorklistItem[] }`),
  `GET /projects/{id}/dashboard` (`ProjectDashboard`: `scope` `project` / `assigned`, `generatedAt`,
  `counts` per group, each count `{ key, count, filter }` with its `WorklistFilter`) and
  `POST /projects/{id}/entry-wave-assignments` (`{ waveId, participationIds }`, 1–500 distinct,
  → `200 { assigned, unchanged }`). The paged `GET /projects/{id}/participations` stays as it is.
- **The bounded snapshot, an exception to cursor pagination:** the work list answers the viewer's
  whole scope in one response, evaluated once in one `repeatable read`, read-only transaction (the
  configuration resolved once per placement Agentur, the guard facts from the `GuardFactsProvider`),
  at most `worklistMaxRows` (5,000); above it `422 worklist_too_large` until the Slice 9
  performance pass. No cursor, so no page recomputes the project and nothing is ever partial; the
  browser filters and searches it. The dashboard counts the same items by the same filters. Both
  are `Cache-Control: private, no-store`.
- **Order:** the schema (400) → visibility (404) → the list scope or the operation (403: the PL
  only for the bulk assignment) → state (422). The bulk assignment refuses `not_ta_tg` and
  `wave_of_other_project` (`/waveId`) for the whole request, else every refused row at
  `/participationIds/<i>` with its code (`participation_not_found` for another project's id, the
  wave codes); a duplicate id is a 400 `duplicate_participation`.
- **Problem codes:** 422 `worklist_too_large`; the others exist.

## Note 2026-10-22 (Slice 5, PR 5-2): reminders and consent v2

- **Routes:** `POST /projects/{id}/reminders` (`{ kind: "open_items", participationIds }`, 1–500
  distinct → `201 { batchId, queued: [{ participationId, channel }], skipped: [{ participationId,
  code }] }`; skips are data, not problems), `GET /participations/{id}/reminders` (`ReminderPage`,
  newest first, an opaque cursor, `private, no-store`; for whoever reads the participation's
  `case_internal` data, else `403`), `POST /portal/channels/{channelId}/consent-upgrade` (the
  participant only: `{ consent: true, consentVersion: "portal-contact-consent:v2", language }` →
  `200 { result: "upgraded" | "already_current" }`; `404` for a channel that isn't the session's
  own live one). `WorklistItem` adds `reminder` (`{ lastRequestedOn, status }` or null) and
  `capabilities.remind` (`{ allowed, code, channel }`: `code` the skip a permitted reminder would
  get, null when the viewer may not remind; `channel` the kind it would go to). `PortalChannel`
  adds `consentUpgrade`; the staff channel record adds `consentVersion`.
- **Order:** the schema (400, a duplicate id `duplicate_participation`) → visibility (404; a
  participation the viewer can't see, a consultant's unassigned one included, is
  `422 participation_not_found` at `/participationIds/<i>`) → permission (`403`: back office and
  every role but the PL and the assigned consultant) → state (`422 project_not_active`) →
  `503 jobs_unavailable` / `503 delivery_unavailable` (production only), all before anything is
  written.
- **Problem codes:** 503 `jobs_unavailable`; the others exist.

## Note 2026-10-23 (Slice 5, PR 5-3): the audit history

- **Route:** `GET /participations/{id}/history` (`HistoryPage` `{ items: HistoryEntry[],
  nextCursor }`, newest first, `limit` 1–100, default 50, `private, no-store`). A `HistoryEntry`
  is `{ occurredAt, type, actor: { kind, name, assisted, job }, change: { field, from, to } | null,
  reasonCode, effectiveDate, details }`; `type` is a `HistoryEventType`, the event types a history
  can show.
- **The database decides what is shown** (data-protection.md, the audit history): the route calls
  `audit_history` and validates each row against its type's projection (a row with more is a
  500), localizes nothing and removes nothing.
- **The cursor** is base64url of the function's position (the last row's sequence number),
  opaque to the client; a full page carries one, so the last may be empty. An undecodable cursor
  is a 400 `invalid_cursor`. Only the first page (no cursor) is audited as an opening.
- **Order:** the schema (400) → visibility (404: an unknown participation or a project the viewer
  can't see) → permission (403: no history stream for the viewer's project roles, e.g. an
  unassigned consultant) → the function, whose refusals map `unauthenticated` → 401,
  `not_member` and `not_assigned` → 403, `participation_not_found` → 404.

## Note 2026-10-23 (Slice 5b, PR 5b-1): appointments and staff bookings

- **Routes:** `GET /projects/{id}/appointments` (`AppointmentPage`: `period` `upcoming` (not
  ended, soonest first) or `past` (latest first), cursor on the start, `capabilities`
  `createInfoEvent`, `createConsultation`, `chooseHost`), `POST /projects/{id}/appointments`
  (`AppointmentInput` → `201 Appointment`), `GET` and `PATCH /appointments/{id}`
  (`AppointmentChangeInput` with `expectedVersion`; the API sends the whole new state to the
  function; a moved start keeps the cutoff's days), `POST /appointments/{id}/host`
  (`{ expectedVersion, hostStaffUserId }`), `POST /appointments/{id}/cancellation` (`{ reason }`),
  `GET /appointments/{id}/bookings` (the bookings the viewer may list, live first, with the
  listable person fields), `POST /appointments/{id}/bookings` (`{ participationId }` →
  `201 { bookingId, warnings }`), `POST /appointment-bookings/{id}/cancellation` (`{}` → `204`),
  `GET /participations/{id}/appointments` (the bookings and the upcoming appointments in the
  participation's audience or host rule, each with its seat state and refusal code or warnings).
  Every list and item is `private, no-store`.
- **An `Appointment`** carries `bookings` as the viewer's view (`{ scope: "all", booked,
  availability }`, `{ scope: "own", own, availability }`), never a total outside the exact scope;
  `needsResolution` (the PL only, else null); `inUse`; `capabilities` `change`, `changeHost`,
  `cancel`, `book`.
- **Order:** the schema (400) → visibility (404: an unknown appointment or one of a project the
  viewer can't see; a booking whose participation the viewer may not list) → membership or the
  operation's permission (403: not a member, back office booking, a consultant on an info event
  or another's slot) → a participation in the body the viewer can't list, or of another project,
  `422 participation_not_found` at `/participationId` → state (422, the domain's booking codes
  before the function) → version (409 `conflict`). The function's refusals map `actor_not_allowed`
  → 403, `stale_version` → 409, `appointment_not_found`/`booking_not_found` → 404, the rest → 422.
- **Problem codes:** 422 `host_not_allowed` (`/hostStaffUserId`), `host_overlap`,
  `starts_in_past` (`/startsAt`), `ends_before_start` (`/endsAt`), `capacity_below_bookings`
  (`/capacity`), `appointment_in_use`, `appointment_unchanged`, `appointment_cancelled`,
  `appointment_started`, `audience_mismatch` (`/audienceWaveId`), `not_consultation`,
  `host_not_responsible`, the booking codes (`participation_closed`, `not_in_audience`,
  `already_booked`, `info_event_limit`, `booking_overlap`, `appointment_full`, `after_cutoff`),
  `booking_cancelled`; 400 `host_mismatch`, `control_character`; the others exist.

## Conventions as built (Slices 0–2)

Status service (`apps/api/src/participations/status-service.ts`):
- The only TypeScript caller of the status functions. One transaction per call, in this order:
  lock and load (participation, project, wave, current exception request, dated facts) →
  permission (`mayPerformTransition` / `mayPerformOperation`) → the draft gate → stale check → the
  domain's check → the function. A refusal is a `StatusServiceError` of kind `not_found`,
  `forbidden`, `stale`, `domain` or `integrity` with a code (and the failed guards), never a value;
  it writes nothing.
- Every function that changes the participation row (status, tracks, wave, dates) increments
  `status_version`, the optimistic-concurrency token clients send as `expectedVersion`.

Errors (`apps/api/src/problem.ts`, `app.ts`, `database-errors.ts`, `packages/domain/src/api.ts`):
- `type` is `urn:transfer:problem:<kind>`: `validation-error` 400, `unauthenticated` 401,
  `forbidden` 403, `not-found` 404, `conflict` 409, `payload-too-large` 413,
  `unsupported-media-type` 415, `domain-error` 422, `internal-error` 500, `service-unavailable` 503.
- `errors[]` items are `{ pointer | parameter, code, detail }` (a JSON pointer into the body, or a
  query or path parameter), never the submitted value. A domain error's pointer is `/<field>` when
  its code belongs to a field, else empty. Malformed JSON is a 400 `malformed_json`.
- A 500 has no message or stack, only `instance: urn:request:<id>`; the log keeps the error's
  name, code and stack frames, never its message.
- Status-service kinds: `not_found` → 404, `forbidden` → 403, `stale` → 409 `conflict`,
  `domain` and `integrity` → 422. Each route allowlists the `P0001` codes it maps
  (`functionRefusal`) and rethrows the rest (a 500). A release template file that differs from the
  manifest, or an invalid stored template snapshot, is a 500 too.

Requests:
- `POST`, `PUT` and `PATCH` need `application/json` (415), also without a body (the openings):
  the client names the type, the API never exempts an empty body. CSRF: see the Slice 3 note below.
- Bodies are strict: an unknown field is a 400 `unrecognized_keys` at its pointer, so
  server-owned values (creator, approver, confirmer, hashes, a new project's Project Agentur) never
  come from the client. Action routes (activation, withdrawal) take an empty strict object.
  `DELETE` has no body; its `expectedVersion` is a strict query parameter. The template catalog's
  query is strict too; the other paged lists' `PageQuery` is not.
- A write that changes nothing is refused 422 (`project_unchanged`, `wave_unchanged`,
  `override_unchanged`, `dates_unchanged`).
- Order: the request schema (400, a malformed id included) → visibility (404: an unknown id and a
  resource the user may not see are the same 404, as is a nested resource such as a wave of
  another project) → operation permission 403 → state 422 → version 409 → value rules 422 → write.
  Exceptions: the date change checks the version (409) before its rules; the import confirm
  refuses mapping issues and error rows (422) before a stale preview token (409
  `import_preview_stale`).

Pagination (`apps/api/src/cursor.ts`):
- `limit` 1–100, default 50. The cursor is base64url JSON of the keyset position, opaque but not
  signed; one that doesn't decode is a 400 `invalid_cursor`. Keyset `(created_at, id)`:
  participations and entry waves ascending, projects newest first; the template catalog by
  `(agenturKey, version)`. No personal data in cursors or URLs.
- Participant list items carry only the id, the three statuses, the wave id and, where the viewer
  may list them, Personalnummer and names. Which rows: `participationListScope` (all, the assigned
  ones, or none → 403).

Capabilities:
- The API derives per viewer what they may do now (`capabilities`, with a refusal code where not):
  permission first, then the domain preconditions (`packages/domain/src/access/participation-view.ts`,
  `projects/pins.ts`). The UI shows an action only when its capability allows it, never inferred
  from role or status; the API decides again on submit.

Logging and environment (`apps/api/src/logger.ts`, `env.ts`):
- One JSON line per request: `requestId`, `method`, `route` (the pattern), `status`, `durationMs`,
  `staffUserId`; never bodies, query strings, cookies or headers. Every response carries
  `X-Request-Id`. Environment errors name the variable, never its value.

Import keys (`apps/api/src/imports/keys.ts`):
- Saved column mappings and preview tokens are HMACs under two keys derived from `SESSION_SECRET`
  with HKDF-SHA256 (`import-header-mapping:v1`, `import-preview-token:v1`), so one never gives the
  other.
