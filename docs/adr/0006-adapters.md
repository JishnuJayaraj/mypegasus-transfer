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

## As built 2026-10-21: activation delivery (Slice 3, PR 3d)

- `Mailer.send` and `SmsSender.send` take the destination, rendered text and an explicit
  `idempotencyKey`. They return `sent` or definitive `failed`; `DeliveryOutcomeUnknown` means a
  timeout or lost response whose provider outcome cannot safely be guessed.
- The mock implementations share a process-local `DevelopmentOutbox`, deduplicate by idempotency
  key, retain only the last 100 messages and can be switched to sent, failed or unknown in tests.
  Their log callback receives only the generated message id. In development,
  `GET /api/v1/dev/outbox` exposes the synthetic outbox; it is not mounted in production.
- Activation messages use the committed `activation_code.id` as the provider idempotency key.
  The provider is called only after the issuance transaction commits. A definitive failure
  revokes the code; an unknown outcome records `delivery_unknown` and keeps it valid.
- `MAIL_ADAPTER` and `SMS_ADAPTER` currently accept only `mock`. A real EU provider, its AVV and
  interface contract tests are required before real messages. SMS is one participant-selected
  channel, not a default or primary channel.
