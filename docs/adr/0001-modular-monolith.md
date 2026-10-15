# ADR-0001: Modular monolith in a monorepo

- Status: Accepted
- Date: 2026-10-15

## Context
Phase 1 (TA) and Phase 2 (TG) work on the same people, projects and documents. The DSV is a
status change, not a system boundary. Team is small; AI agents do much of the implementation.

## Decision
One API, one SPA, one database, organised as packages in a pnpm monorepo. Phases are modules
switched on per project.

## Consequences
+ No data sync between systems, simple deployment, easy cross-phase reporting.
+ Agents get the whole context in one repo.
- Module boundaries must be enforced by convention/lint rules, not by the network.
- If a separate public participant frontend is needed later, it can be another app in the
  monorepo using the same API.

## Amendment 2026-10-15 (accepted in the PR #1 review)
- **Two SPAs on one API:** `apps/web` (staff) and `apps/portal` (participants), sharing
  `packages/*`. Reasons: the portal is mobile-first, has a different login flow, will need RTL
  languages, and staff code shouldn't be shipped to participants (smaller attack surface).
- Module boundaries are enforced by lint rules on import paths (e.g. `apps/portal` may not
  import staff-only modules).

