# ADR-0005: Hosting — local first, then company Hetzner cluster

- Status: Accepted
- Date: 2026-10-15

## Context
The app processes social data (Sozialdaten). Data residency and subprocessors must be
acceptable to customers, works councils and the DPO. The company already operates a Hetzner
cluster (German data centres).

## Decision
- **Development & pilots:** run locally (Docker Compose: app + PostgreSQL). Real participant
  data, if any during a pilot, only on company machines/infrastructure — never in cloud coding
  sessions, never in the GitHub repo.
- **Production/staging:** the company **Hetzner** cluster (German data centres), with an AVV in
  place. PostgreSQL either managed by the cluster team or as a container with backups.
- The app is delivered as **container images** and stays provider-neutral (no Hetzner-specific
  APIs in application code). Deployment manifests (Compose or Kubernetes, depending on the
  cluster) live in `deploy/` and are decided in Slice 9.
- No VoidZero/Void, Vercel or other US edge hosting for anything that holds participant data.

## Consequences
+ Data stays in company-controlled German infrastructure.
- We own backups, TLS, monitoring and updates (check what the cluster team already provides).
- AI providers (v2) must meet the same residency rules.
