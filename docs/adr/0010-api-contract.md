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
