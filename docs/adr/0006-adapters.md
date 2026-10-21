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
  revokes the code (unless a reissue or terminal transition already revoked it during the send;
  that reason stands); an unknown outcome records `delivery_unknown` and keeps it valid. Any
  other provider error counts as unknown and is not logged, since it may echo the destination.
- `MAIL_ADAPTER` and `SMS_ADAPTER` currently accept only `mock`. The mocks are wired only outside
  `NODE_ENV=production`: they report `sent` without sending, which would record Art. 14 evidence
  for a message nobody received. In production, in-person issuance answers
  `503 delivery_unavailable` before any code exists. A real EU provider, its AVV and interface
  contract tests are required before real messages. SMS is one participant-selected
  channel, not a default or primary channel.

## As built 2026-10-21: one-time codes and the activation notice (Slice 3, PR 3e)

- A portal one-time code follows the same protocol: `create_one_time_code` commits the challenge
  `pending`; the API sends after the commit with the challenge id as the idempotency key; then
  `record_one_time_code_delivery` records the outcome. A definitive failure invalidates the code
  (unless a newer one superseded it during the send) and answers `503 delivery_failed`; any
  provider error is an unknown outcome, never logged, and the code stays usable. Without a sender
  (production) the request answers `503 delivery_unavailable` before a challenge exists.
- The activation notice carries no secret and goes through the job `portal.activation-notice`
  (ADR-0011) with the provider key `activation-notice:<channelId>`. The server builds one set of
  senders for the API and the jobs (`messaging` in `apps/api/src/app.ts`), so the development
  outbox shows the notice too.

## As built 2026-10-21: login codes (Slice 3, PR 3f)

- A login code follows the same protocol (`request_login_code`, the send with the challenge id
  as the idempotency key, `record_login_code_delivery`), except that the send runs **after the
  `202`** (`apps/api/src/detached.ts`): the answer must not reveal, by its timing or its outcome,
  whether the address has an account, so a definitive failure only invalidates the code. The code
  exists only in the closure of that task, never in a job payload; failures are logged without a
  message; shutdown waits for the tasks in flight before closing the pool. Whether a sender exists
  depends on the kind only, so `503 delivery_unavailable` reveals nothing.
- A channel verification code (`request_channel_code`) is sent in the request like the
  activation's, and its outcome recorded by `record_one_time_code_delivery`.
- A recovery code in person is sent like a first in-person code (`record_activation_delivery`).
