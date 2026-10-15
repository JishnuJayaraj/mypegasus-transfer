Files that break the portal boundary rule on purpose (ADR-0001, AC-19). `pnpm lint` skips this
directory (`--ignore-pattern`); `src/boundary.test.ts` lints each file and expects the rule to
fire (or, for `allowed.ts`, not to). They are not compiled.
