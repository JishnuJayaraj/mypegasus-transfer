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
