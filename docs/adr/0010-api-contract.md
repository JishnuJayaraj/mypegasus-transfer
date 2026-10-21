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
- `POST`, `PUT` and `PATCH` need `application/json` (415). CSRF: see the Slice 3 note below.
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
