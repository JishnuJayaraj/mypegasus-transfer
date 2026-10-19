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
