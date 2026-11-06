# Decisions — 2026-11-06, the UX foundation (Slice 6b, Q221–Q225)

The product owner reviewed [the Slice 6b plan](../plans/slice-6b.md) and answered its five
questions. They were first drafted as Q210–Q214, which Slice 7 (PR #104) already uses for DSV and
retention decisions; they are renumbered Q221–Q225 and Slice 7's rows are unchanged. All five are
`accepted` for development on synthetic data; Q223 keeps a 🔒 for the DPO check before any
persistent storage.

## Q221 — Product identity (accepted)

"Transferplattform", Carbon's existing accent and a neutral placeholder mark. Final branding
follows independently and swaps only the mark and favicon.

## Q222 — Component library (accepted)

Thin Carbon wrappers in `packages/ui`; no `@carbon/ibm-products` dependency in this slice. Build
each component around an actual consumer.

## Q223 — Work-list column preferences (accepted, 🔒)

In memory for now: not in `localStorage`, not in the URL. Persistent per-user storage may follow
after a DPO check; a user id in a storage key would still be an identifier.

## Q224 — "Meine Aufgaben" (accepted)

Yes, later. The cross-project API and its access model get their own scope; this blocks no current
work.

## Q225 — Screen size (accepted)

1280px is the preferred layout, not a functional cutoff. Forms, filters and dialogs remain usable
when zoom causes narrow reflow (WCAG 1.4.10); tables may scroll inside their own container. Each
UI PR adds a manual zoom check alongside axe.

## Corrections to the plan (same review)

- Quick-view labels match their filters: `deadlineState: upcoming` is "In den nächsten 14 Tagen"
  (the 14-day horizon), `actions: any` is "Angaben/Unterlagen fehlen"; every quick view is
  defined explicitly (plan D6). Before 6b-3.
- The dashboard never says "Alles erledigt": with the featured counts at zero it says "Keine
  offenen Punkte in diesen Ansichten", other open-work counts stay reachable (a mandatory BA
  reporting task can stay open after the participation closes). Before 6b-4.
- Back office cannot assign waves (the PL's capability); its walkthrough tasks are activation
  letters and BA reporting. Permissions unchanged.
- Contracts added before their owning PRs: blocked actions explained (C1), "Nächster Schritt"
  including undated escalations and invalidated evidence (C2), parallel tracks (C3), drafts (C4),
  meaningful portal progress (C5).
- 6b-1 and the essential shared components may start now; independent Slice 7 backend work need
  not wait for the dashboard and portal polish.
