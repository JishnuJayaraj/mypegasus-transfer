# PR #90 — Slice 6, PR 6-3a review and the Q199 decisions

Reviewed 2026-10-26. PR: <https://github.com/JishnuJayaraj/mypegasus-transfer/pull/90>.
Head: `63a84d9`. This records the product owner's findings and decisions as given; the fixes are
in the same PR. This does not constitute external DPO, legal, works-council or Agentur
confirmation.

## Findings

1. **P1 — An old school confirmation applied after an education edit.** Generation accepted
   warning codes without the readiness they were given for: check → confirm "Kein Schulabschluss"
   → change the education → generate succeeded with the old confirmation. Return a source token
   with the readiness, require it for generation, and refuse changed inputs before applying
   confirmations.
2. **P2 — "Kein Schulabschluss" failed without any education row.** The check skipped an empty
   history, after which generation answered `required_missing` even with the explicit
   confirmation. Support a reviewed absence apart from "unknown", without a made-up institution
   or qualification.
3. **P2 — Generated copies blocked later uploads.** Both upload counters (50 live, 20 an hour)
   included generated documents; after 20 generations a valid CV upload was
   `upload_rate_limited`. Exclude generated document policies from both.
4. **P2 — The abandonment fallback expired copies that were followed up.** A signed scan accepted
   on day 80 gave day 90 instead of day 110. Apply the abandonment only while there is neither a
   successor nor an accepted scan. Nothing is deleted yet; fix the contract before the retention
   job uses it.

## Q199 decisions

- **1:** accept the per-generation "Kein Schulabschluss", after fixing the confirmation's binding
  and the empty history.
- **2–3:** accept the explicitly scoped PL completeness summary and the on-demand "Prüfen". The
  PL's boolean must not become a generation or entry guard.
- **4:** accept the logged PL opening under D8/Q49. The existing DPO confirmation remains a
  live-use gate; synthetic development continues.
- **5:** rejected before merge: identity, contact details and the effective TG dates must take
  part in change detection, and the organisation configuration's version or fingerprint is kept.
  A surname correction through the existing write function during rendering was followed by a
  successful record of the old-name form. Comparable values or fingerprints suffice; no new
  general revision system.
- **6:** accept recording only the raised confirmations; document the generation endpoint's
  form-level errors explicitly, while the readiness keeps the field-level explanations.
- **7:** accept the separate upload allowances after fixing the counters.
