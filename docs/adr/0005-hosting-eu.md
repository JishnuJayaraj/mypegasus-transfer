# ADR-0005: Hosting — local first, then company Hetzner cluster

- Status: Accepted (cluster details provisional, Q12)
- Date: 2026-10-15 (amended the same day from the decisions log)

## Context
The app processes social data (Sozialdaten), including health data. Data residency and
subprocessors must be acceptable to customers, works councils and the DPO. The company already
operates a Hetzner cluster in German data centres.

## Decision
- **Development and demos:** run locally (Docker Compose: app, PostgreSQL 16, MinIO, Gotenberg)
  with **synthetic data only**.
- **Pilot and production:** the company **Hetzner** cluster, **German locations only**
  (Nürnberg, Falkenstein). **Real data only on the cluster, never on laptops**, never in cloud
  coding sessions, never in the repo. The first pilot is one project in Nürnberg (Q26), after
  the pre-pilot gate below.
- Cluster setup *(provisional, Q12)*:
  - k3s on Hetzner Cloud
  - PostgreSQL via the CloudNativePG operator, with encrypted backups to Hetzner Object Storage
    (S3-compatible), kept for **≤ 30 days** (so that deletions take effect, ADR-0008)
  - TLS via cert-manager + Let's Encrypt
  - Prometheus/Grafana for metrics, Loki for logs
  - Kubernetes Secrets, SOPS-encrypted in git
- **One PostgreSQL major version everywhere** (Slice 0): the cluster's PostgreSQL
  (CloudNativePG) runs the same major version as development (cloud session, Compose) and CI,
  currently **16**. A major upgrade is a deliberate change everywhere at once.
- The app is delivered as **container images** (Node 24 LTS), with Helm or Kustomize manifests
  in `deploy/`, health and readiness endpoints, `/metrics`, and structured JSON logs **without
  personal data**. No Hetzner-specific APIs in application code.
- No VoidZero/Void, Vercel or other US edge hosting for anything that holds participant data.
- No AI providers in the MVP. Later, only EU-hosted providers with an AVV, never US providers
  for personal data *(assumed, Q38)*.

## Pre-pilot gate (all must be true before any real data)
- [ ] DPIA (DSFA) completed (Q25)
- [ ] **AVV chain signed** for the cluster (TG ↔ operator ↔ Hetzner, or TG ↔ Hetzner) —
      **blocking**. The product owner operates the cluster and owns the AVV chain (Q32).
- [ ] Data-sharing clause in the customer contract (Q14)
- [ ] No `assumed`/`verify` items left in data protection, retention or legal deadlines
      (`open-questions.md`, rows marked 🔒)
- [ ] **Row-level security per project enabled** on all tables with participant data (they
      carry `project_id` from the start, ADR-0002)
- [ ] Backup and restore tested; backup retention ≤ 30 days
- [ ] TLS, monitoring and alerting in place; logs checked for personal data
- [ ] Security review / penetration test of auth, permissions and uploads
- [ ] Retention values confirmed by DPO and tax advisor
- [ ] A shared rate limiter for portal code submissions (Slice 3 plan D14, Q128; in memory per
      process until then) and the client IP behind the ingress (the throttle sees the peer
      address; a trusted forwarded-for header needs the ingress configuration)
- [ ] Every DPO/legal confirmation implemented; if one required a design change, that change
      is built and tested (round 9)

## Consequences
+ Data stays in German infrastructure under company control.
- We own backups, upgrades and monitoring of Postgres (no managed Postgres at Hetzner).
- The pilot depends on the AVV chain being signed (owned by the product owner, Q32).

## Conventions as built (Slices 0–2)

- **CI supply chain** (`.github/workflows/ci.yml`): third-party actions pinned by commit SHA,
  workflow `permissions: contents: read`, checkout without persisted credentials; the Postgres
  service image and the Node base image of the `Dockerfile` pinned by digest (tag and digest
  updated together).
- **The image runs as the non-root `node` user**; `scripts/image-smoke.sh` fails if it runs as
  root.
- **Memory per API pod:** each import parse worker may use about 300 MB, so an API process runs at
  most two, with up to eight requests waiting (ADR-0003, ADR-0010), each holding about 13 MB (the
  8 MB body and the 5 MB decoded file). Two workers, the waiting requests and the API itself are
  budgeted under 1 GiB per pod; the pod's memory limit is set with the cluster deployment.
