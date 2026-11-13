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

Dispositions: **fixed** in this PR, **deferred** with its slice, or **question** with its number.
No code was changed in this PR (no finding was a small fix), so no visual-regression baseline
changed.

| # | Page | Finding | Disposition |
|---|---|---|---|
| F1 | Kit | "Aktionen" was read as the secondary button; the expectation (page-level actions inside) matches the design | no change |
| F2 | Kit | The outlined "Scan hochladen" was read as belonging to its content, as D6 intends | works as designed |
| F3 | Seed | The seed has no Berater assignments, so a Berater cannot open any participant page ("Sie dürfen diese teilnehmende Person nicht sehen"); worked around by assigning three participants in the local database | question Q263 |
| F4 | Participant header | The three track pills help in the start phase and are noise once the person is in the TG | question Q262 |
| F5 | Participant header | Wanted: a thin sticky strip with name, project, Welle, days left in the TG, end date and Berater | question Q263 |
| F6 | Participant header | Wanted: the qualification budget the PL set for this person | question Q263 (qualification planning is Slice 8) |
| F7 | Participant, "Als Nächstes" | Liked; shows the missing fields | works as designed |
| F8 | Participant, "Stand" | The three bars are not useful: hovering shows nothing, they show neither what is done nor what is left, nor how to move on | question Q264 |
| F9 | Participant, "Verlauf" | The timeline is confusing: events at the bottom, "Portal-Aktivierung" out of place | question Q264 (stage 2 is Slice 8) |
| F10 | Participant, "Stammdaten" | Liked (basic data and contact); unsure it belongs on this page | works as designed |
| F11 | Participant, "Selbstauskunft" | Looks like floating text, no dividers, cards or tables | deferred, Slice 9 (D13: keeps its layout); Q264 |
| F12 | Participant, "Profiling" | Liked: the left list to jump between steps; the text in it looks awkward (not specified) | question Q264 |
| F13 | Participant, "Arbeitsuche" | Much empty space, unclear what to do; the Berater wants to have the form filled and handed to the BA, as a linear process with checkmarks | question Q264 |
| F14 | Participant, "DSV" | Does not show what is current, finished or next | question Q264 |
| F15 | Participant list | Wanted columns: name, active or not, days left or end date, last contact; also contract end and the BA-Kundennummer | question Q263 |
| F16 | Overall | The UI looks decades old; the top bar and tabs are fine | question Q261 |
| F17 | Overall | Hard to tell where to find fields | question Q261 |
| F18 | Overall | Wanted: an English/German toggle; tracking of contacts, qualification history and bookings; study what a Berater needs | questions Q266 (language), Q263 (the rest) |
| F19 | Overview, tiles | The pills showing what is missing work; they open the participant list with the filter | works as designed |
| F20 | Overview | "Making my eyes bleed" (no specifics given) | question Q261 |
| F21 | Overview, waves and funnel | Useful only in the start phase (first meeting, forms, how many are in which stage); not once the participants are in | question Q262 |
| F22 | Overview | The PL's later-phase concerns in a running TG are not shown | question Q262 (Slice 8) |
| F23 | Setup | The blocker (no DSV-Vorlage) was found | works as designed |
| F24 | Setup | The DSV-Vorlage "buried" in the setup, and unclear why it is needed in the middle of profiling | question Q265 |
| F25 | Setup | The side panel is "not great" (no specifics given) | question Q261 |
| F26 | Navigation, "Teilnehmende" | Liked the filter; wants to manage all Berater and who is assigned to whom | question Q263 |
| F27 | Navigation, "Einrichtung" | Liked as project details; does not understand the Agentur version, why Import sits there, or how to use the "Termine" settings in the real job | question Q265 |
| F28 | Navigation, "Team" | Liked for deciding who has access; cannot see what each role can and cannot do | question Q265 |
| F29 | Navigation, project list | The side navigation for choosing a project and then its details works | works as designed |
| F30 | Setup header | The two header buttons ("Aktivieren", "Weiter zu …") as wide blocks (7b-7 follow-up): not raised by either participant | no change |

The flaky participant-page unit test named in the 7b-7 hand-off was not touched.
