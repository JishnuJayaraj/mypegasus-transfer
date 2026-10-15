# ADR-0002: PostgreSQL + Drizzle, hybrid relational/jsonb model

- Status: Accepted
- Date: 2026-10-15

## Context
The data model is the core of the product and expensive to change later. Regional variation
needs flexible fields; reporting needs solid relational data.

## Decision
PostgreSQL 16 with Drizzle ORM and SQL migrations. Core entities and fields (person,
participation, status, dates, audit) are real columns. Config-driven fields live in `jsonb`
validated by the resolved Zod/JSON schema. Audit log is an append-only table.

## Consequences
+ Strong consistency, good reporting, one database to operate.
+ Pre-installed in cloud coding sessions (`service postgresql start`).
- jsonb fields need careful indexing if they become filter criteria; promote to columns when
  a field becomes universal.
