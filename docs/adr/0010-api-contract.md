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
