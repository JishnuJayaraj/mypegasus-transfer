# ADR-0006: Ports & adapters for external services

- Status: Accepted
- Date: 2026-10-15

## Decision
Every external capability is an interface in `packages/adapters` with a mock implementation:
`PdfRenderer`, `Mailer`, `SmsSender`, `FileStorage`, `VirusScanner`, `AiAssistant`,
`Exporter` (payroll/KuG/CSV), `IdentityProvider`. Selection via environment configuration.
Features import interfaces only.

## Consequences
+ MVP runs fully locally/in cloud sessions with mocks; real providers added one by one.
+ Easy to test.
- Each real adapter needs contract tests against its interface.
