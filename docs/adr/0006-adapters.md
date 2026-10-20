# ADR-0006: Ports & adapters for external services

- Status: Accepted (amended 2026-10-15)
- Date: 2026-10-15

## Decision
Every external capability is an interface in `packages/adapters` with a mock implementation.
Features import interfaces only. The implementation is selected via environment configuration.

Canonical list:

| Interface | Purpose | First real implementation |
|---|---|---|
| `PdfRenderer` | AcroForm filling of official forms + HTML→PDF for our documents | pdf-lib (AcroForm), Gotenberg (HTML) — ADR-0009 |
| `Mailer` | email | open |
| `SmsSender` | SMS (primary participant login channel) | open (EU provider, AVV) |
| `FileStorage` | uploads, scans, generated documents | S3-compatible (MinIO locally, Hetzner Object Storage) |
| `VirusScanner` | upload scanning | open (e.g. ClamAV in the cluster) |
| `Exporter` | versioned CSV exports: payroll (DATEV LODAS later), Teilnehmerliste per Agentur, customer report, half-yearly Agentur report | CSV |
| `Clock` | current date/time, so deadline logic and system transitions are testable | system clock |
| `AiAssistant` | **v2 only**; not built in the MVP | — |

Not adapters:
- **Staff login** uses a plain OIDC client configured by environment (Entra ID). No
  `IdentityProvider` adapter (ADR-0007).
- **No e-signature adapter.** DSV, TL 407 and Kug 200b are signed in wet ink.

## Consequences
+ The MVP runs fully locally and in cloud sessions with mocks; real providers are added one by
  one.
+ Easy to test.
- Each real adapter needs contract tests against its interface. For `PdfRenderer`, that means
  tests that fill the real blank TL 407 / Kug 200b and read the values back.

## Conventions as built (Slices 0–2)

- **No direct time** in `packages/domain`, `packages/config` and `apps/api/src/jobs`: no
  `Date.now()` and no `new Date(…)` outside tests and `testing/`, enforced by a source scan
  (`packages/adapters/src/clock/no-direct-time.test.ts`). Business dates (Berlin today, run times)
  come from the injected `Clock`; recorded instants (`occurred_at`, `activated_at`,
  `completed_at`) are the database's `now()`.
