# Transfer Platform

Web application for running Transferagentur / Transfergesellschaft projects: participant
import, self-service data collection, profiling and Agentur forms, DSV tracking, and the TG
phase (coaching, qualification, applications, exit).

**Status:** Slice 0 (walking skeleton) is complete: monorepo, `Project` list and create end to
end (Postgres, Hono API, staff SPA), a thin participant portal shell (de/en), and one Node 24
image that serves the API and both SPAs. Slice 1 (domain core, [plan](docs/plans/slice-1.md)) is
nearly done: the lifecycle, Transfer-KuG eligibility, the access matrix, completeness, regional
configuration, the status functions and service with the seed, and pg-boss in the API with the
nightly schedule (PR 1h-1). Last: the nightly lifecycle sweep (PR 1h-2).

```
pnpm install && pnpm db:setup && pnpm db:seed && pnpm dev   # web :5173, portal :5174/portal/
```

See the commands in [`CLAUDE.md`](CLAUDE.md#commands). Synthetic data only.

| Read | For |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Rules and context for AI coding sessions (and humans) |
| [`docs/prd.md`](docs/prd.md) | MVP scope and user flows |
| [`docs/domain/`](docs/domain/) | Glossary, lifecycle, regional variation, data protection |
| [`docs/architecture/overview.md`](docs/architecture/overview.md) | Architecture |
| [`docs/adr/`](docs/adr/) | Architecture decisions |
| [`docs/roadmap.md`](docs/roadmap.md) | Build order (vertical slices) |
| [`docs/guide/working-with-claude-cloud.md`](docs/guide/working-with-claude-cloud.md) | How we build this with Claude in the cloud |
| [`docs/open-questions.md`](docs/open-questions.md) | Things we must not guess |
| [`docs/decisions/`](docs/decisions/) | Answers to open questions (dated) |
| [`docs/reviews/`](docs/reviews/) | Critical reviews of the docs and ADR change proposals |
