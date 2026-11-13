# The usability walkthrough on the reference pages (2026-11-13)

Slice 7b, PR 7b-8 (the plan's D14, [archived](../plans/archive/slice-7b.md)). Run on synthetic data
in the dev environment: one Berater (logged in as the seeded consultant) and one Projektleiter
(the seeded PL), four tasks, one page each. The findings
are the participants' words as reported, not an evaluation of the product against the plan.

## Tasks and who took part

| # | Page | Role | Task, given as a goal |
|---|---|---|---|
| 1 | Kit page | Berater | Which button is the main action, which are secondary, where would a dangerous action sit |
| 2 | Participant page | Berater | Where is this person in each track, what next, what is missing for profiling |
| 3 | Project overview | Projektleiter | What needs attention today; open the oldest overdue item |
| 4 | Project setup | Projektleiter | Find out why the project isn't active; change one setting |

Both participants were dissatisfied with the product as a whole and asked for a major overhaul
designed from the user's daily work.

## Findings

Dispositions: **fixed** in this PR, **deferred** with its slice, **question** with its number, or
**observed** (a positive or neutral observation; a usability concern is never closed because the
layout matches the design). No code was changed in this PR, so no visual-regression baseline
changed.

| # | Page | Finding | Disposition |
|---|---|---|---|
| F1 | Kit | "Aktionen" was read as the secondary button; they expected page-level actions inside it. The design intends a menu for less common and destructive actions, but the reading shows the menu is not recognisable as a menu | kept open for the redesign review (Q261) |
| F2 | Kit | The outlined "Scan hochladen" was read as belonging to its content, which is how D6 intends it | observed; no change in this PR (Q261 reviews the button hierarchy) |
| F3 | Seed | The seed has no Berater assignments, so a Berater cannot open any participant page ("Sie dürfen diese teilnehmende Person nicht sehen"); worked around by assigning three participants in the local database | actionable fix, tracked in [docs/issues/seed-berater-assignments.md](../issues/seed-berater-assignments.md); access rules stay as they are (Q263) |
| F4 | Participant header | The three track pills help in the start phase and are noise once the person is in the TG | question Q262 |
| F5 | Participant header | Wanted: a thin sticky strip with name, project, Welle, days left in the TG, end date and Berater | question Q263 |
| F6 | Participant header | Wanted: the qualification budget the PL set for this person | question Q263 (qualification planning is Slice 8) |
| F7 | Participant, "Als Nächstes" | Liked; it shows the missing fields | observed (positive) |
| F8 | Participant, "Stand" | The three bars are not useful: hovering shows nothing, they show neither what is done nor what is left, nor how to move on | question Q264 |
| F9 | Participant, "Verlauf" | The timeline is confusing: events at the bottom, "Portal-Aktivierung" out of place | question Q264 (stage 2 is Slice 8) |
| F10 | Participant, "Stammdaten" | Liked (basic data and contact), but the participant is unsure the card belongs on this page | placement left to the redesign review (Q261) |
| F11 | Participant, "Selbstauskunft" | Looks like floating text, no dividers, cards or tables | deferred, Slice 9 (D13: keeps its layout); Q264 |
| F12 | Participant, "Profiling" | Liked: the left list to jump between steps; the text in it looks awkward (not specified) | question Q264 |
| F13 | Participant, "Arbeitsuche" | Much empty space, unclear what to do; the Berater wants to have the form filled and handed to the BA, as a linear process with checkmarks | question Q264 |
| F14 | Participant, "DSV" | Does not show what is current, finished or next | question Q264 |
| F15 | Participant list | Wanted columns: name, active or not, days left or end date, last contact; also contract end and the BA-Kundennummer | question Q263 |
| F16 | Overall | The UI looks decades old; the top bar and tabs are fine | question Q261 |
| F17 | Overall | Hard to tell where to find fields | question Q261 |
| F18 | Overall | Wanted: an English/German toggle; tracking of contacts, qualification history and bookings; study what a Berater needs | questions Q266 (language), Q263 (the rest) |
| F19 | Overview, tiles | The pills showing what is missing work; the PL took them to open the participant list with the filter | observed (positive) |
| F20 | Overview | "Making my eyes bleed" (no specifics given) | question Q261 |
| F21 | Overview, waves and funnel | Useful only in the start phase (first meeting, forms, how many are in which stage); not once the participants are in | question Q262 |
| F22 | Overview | The PL's later-phase concerns in a running TG are not shown | question Q262 (Slice 8) |
| F23 | Setup | The PL reported finding the blocker and named the DSV-Vorlage as missing. **What the blocker was cannot be determined from the session**: the activation rules block only on a missing Project-Agentur template and, for a `ta_tg` project, on having no entry wave with a latest entry date (`packages/domain/src/lifecycle/activation.ts`); a missing DSV-Vorlage blocks DSV generation, not activation. In the local database the project used (Restrukturierung Werk Nord) was already `active` with DSV-Vorlage `v1` pinned, so neither reading matches what was reported | observed; the project and the setup page state at the time were not recorded (Q265) |
| F24 | Setup, DSV-Vorlage | The PL does not understand why the DSV-Vorlage is "buried" in the setup, or why it is needed in the middle of profiling | question Q265 (the DSV-Vorlage is a setup step because the DSV is generated from the project's pinned version; it does not block activation) |
| F25 | Setup | The side panel is "not great" (no specifics given) | question Q261 |
| F26 | Navigation, "Teilnehmende" | Liked the filter; wants to manage all Berater and who is assigned to whom | question Q263 |
| F27 | Navigation, "Einrichtung" | Liked as project details; does not understand the Agentur version, why Import sits there, or how to use the "Termine" settings in the real job | question Q265 |
| F28 | Navigation, "Team" | Liked for deciding who has access; cannot see what each role can and cannot do | question Q265 |
| F29 | Navigation, project list | The side navigation for choosing a project and then its details works | observed (positive) |
| F30 | Setup header | The two header buttons ("Aktivieren", "Weiter zu …") render as wide blocks (7b-7 follow-up). Neither participant mentioned them; that is not evidence that they are satisfactory | not evaluated; left for the redesign review (Q261) |

The flaky participant-page unit test named in the 7b-7 hand-off was not touched.
